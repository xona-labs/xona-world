import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, AGENTS } from './config.js';
import { db } from './db.js';
import { cycleStatus, onBroadcast, runCycle } from './engine.js';
import * as oauth from './paybox/oauth.js';
import * as mcp from './paybox/mcp.js';
import * as live from './paybox/live.js';

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cockpit', (req, res, next) => {
    const name = req.body?.name ? ` ${req.body.name}` : '';
    console.log(`[cockpit] ${req.method} ${req.path}${name}`);
    next();
  });

  // ---- SSE fan-out -------------------------------------------------------
  const clients = new Set();
  onBroadcast((type, payload) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  });

  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // ---- Bootstrap: everything the dashboard needs in one call -------------
  app.get('/api/bootstrap', (req, res) => {
    const agents = db.prepare('SELECT * FROM agents').all().map((a) => {
      const open = db.prepare("SELECT * FROM positions WHERE agent_id = ? AND status = 'open' ORDER BY opened_at DESC").all(a.id);
      const positionsValue = open.reduce((s, p) => s + p.shares * (p.current_price ?? p.entry_price), 0);
      const stats = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
               SUM(pnl) AS realized
        FROM positions WHERE agent_id = ? AND status IN ('closed','resolved')
      `).get(a.id);
      return {
        ...a,
        equity: a.cash + positionsValue,
        positionsValue,
        openPositions: open,
        closedCount: stats.n || 0,
        wins: stats.wins || 0,
        realizedPnl: stats.realized || 0,
      };
    });

    const history = db.prepare('SELECT agent_id, ts, equity FROM equity_snapshots ORDER BY ts ASC').all();
    const trades = db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT 60').all();
    const decisions = db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT 30').all();
    const closed = db.prepare("SELECT * FROM positions WHERE status IN ('closed','resolved') ORDER BY closed_at DESC LIMIT 40").all();

    res.json({
      agents,
      agentSpecs: AGENTS,
      history,
      trades,
      decisions,
      closedPositions: closed,
      cycle: cycleStatus(),
      paybox: { connected: oauth.isConnected(), tools: mcp.cachedTools()?.map((t) => t.name) || null },
      live: {
        enabled: config.live.enabled,
        tradeUsd: config.live.tradeUsd,
        balance: live.cachedBalance(),
        wallet: live.cachedWallet(),
        trades: db.prepare('SELECT ts, agent_id, action, market_title, side, usd, status FROM live_trades ORDER BY ts DESC LIMIT 20').all(),
      },
      config: { cycleSeconds: config.cycleSeconds, startingBankroll: config.startingBankroll },
    });
  });

  // ---- Agent controls ------------------------------------------------------
  app.post('/api/agents/:id/paused', (req, res) => {
    const paused = req.body?.paused ? 1 : 0;
    const info = db.prepare('UPDATE agents SET paused = ? WHERE id = ?').run(paused, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'unknown agent' });
    res.json({ ok: true, id: req.params.id, paused: !!paused });
  });

  // Move every OTHER agent's cash into the target's ledger. Starting bankrolls
  // shift by the same amounts so nobody's PnL is rewritten by the transfer.
  app.post('/api/agents/reallocate', (req, res) => {
    const to = req.body?.to;
    const target = db.prepare('SELECT * FROM agents WHERE id = ?').get(to);
    if (!target) return res.status(404).json({ error: 'unknown target agent' });
    const moves = [];
    db.transaction(() => {
      for (const a of db.prepare('SELECT * FROM agents WHERE id != ?').all(to)) {
        const t = Math.floor(a.cash * 100) / 100;
        if (t <= 0) continue;
        db.prepare('UPDATE agents SET cash = cash - ?, starting_bankroll = MAX(0.01, starting_bankroll - ?) WHERE id = ?').run(t, t, a.id);
        db.prepare('UPDATE agents SET cash = cash + ?, starting_bankroll = starting_bankroll + ? WHERE id = ?').run(t, t, to);
        moves.push({ from: a.id, usd: t });
      }
    })();
    res.json({ ok: true, to, moves });
  });

  // ---- Fund the trading wallet -------------------------------------------
  // A MoonPay checkout that deposits USDC straight into the granted Solana
  // wallet; the deposit auto-splits across the three agents next cycle.
  app.post('/api/fund/link', async (req, res) => {
    try {
      const amount = Number(req.body?.amountUsd) || null;
      res.json(await live.buyLink(amount));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/fund/refresh', async (req, res) => {
    try {
      const usd = await live.refreshBalance();
      res.json({ balance: live.cachedBalance(), usd });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Paybox / World connection -----------------------------------------
  app.post('/api/paybox/connect', async (req, res) => {
    try {
      res.json({ url: await oauth.buildAuthorizeUrl() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/oauth/callback', async (req, res) => {
    try {
      await oauth.handleCallback(String(req.query.code || ''), String(req.query.state || ''));
      mcp.resetSession();
      // Discover the World toolset right away; non-fatal if it fails.
      mcp.listTools({ force: true }).catch((err) => console.error('[paybox] tools/list failed:', err.message));
      res.redirect('/?connected=1');
    } catch (err) {
      res.status(400).send(`OAuth failed: ${err.message}`);
    }
  });

  app.get('/api/paybox/status', async (req, res) => {
    const connected = oauth.isConnected();
    let tools = mcp.cachedTools();
    if (connected && !tools) {
      try { tools = await mcp.listTools(); } catch (err) { return res.json({ connected, tools: null, error: err.message }); }
    }
    res.json({ connected, tools });
  });

  app.post('/api/paybox/disconnect', (req, res) => {
    oauth.disconnect();
    mcp.resetSession();
    res.json({ ok: true });
  });

  // ---- Signing cockpit -----------------------------------------------------
  // Hosts paybox's own wallet-sign app in an iframe and bridges its MCP-Apps
  // protocol to our OAuth session, so parked live trades sign in-browser.
  // When COCKPIT_TOKEN is set (any public deploy), every cockpit surface
  // requires it — /api/cockpit/key hands out signing-key material.
  const cockpitToken = process.env.COCKPIT_TOKEN || '';
  const cockpitGuard = (req, res, next) => {
    if (!cockpitToken) return next(); // local dev
    const presented = req.query.token || req.get('x-cockpit-token') ||
      (req.headers.cookie || '').match(/cockpit_token=([^;]+)/)?.[1];
    if (presented === cockpitToken) return next();
    res.status(401).send('cockpit token required');
  };

  app.get('/cockpit', cockpitGuard, (req, res) => {
    if (cockpitToken) {
      res.cookie
        ? res.cookie('cockpit_token', cockpitToken, { httpOnly: true, sameSite: 'strict' })
        : res.setHeader('Set-Cookie', `cockpit_token=${cockpitToken}; HttpOnly; SameSite=Strict; Path=/`);
    }
    res.sendFile(path.join(config.root, 'src', 'cockpit.html'));
  });
  app.use('/api/cockpit', cockpitGuard);

  app.get('/api/cockpit/app', async (req, res) => {
    try {
      const uri = 'ui://paybox/wallet-sign?v=a213e2584d0e61d9';
      const html = await mcp.readResource(uri, { force: req.query.fresh === '1' });
      res.set('Content-Type', 'text/html').send(html);
    } catch (err) {
      res.status(500).send(`cockpit app load failed: ${err.message}`);
    }
  });

  app.post('/api/cockpit/call', async (req, res) => {
    try {
      const { name, arguments: args } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      res.json(await mcp.callToolRaw(name, args));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/cockpit/pending', (req, res) => {
    const rows = db.prepare(`
      SELECT id, request_id, agent_id, market_title, side, usd, status, raw, ts
      FROM live_trades
      WHERE status LIKE 'pending%' AND request_id IS NOT NULL AND ts > ?
      ORDER BY ts ASC
    `).all(Date.now() - 4 * 60_000);
    res.json({ pending: rows.map((r) => ({ ...r, raw: undefined, op: safeParse(r.raw) })) });
  });

  // The paybox-issued signing key, parsed for the in-browser signing app.
  // Local-only surface: this server runs on the operator's own machine.
  app.get('/api/cockpit/key', (req, res) => {
    const token = (process.env.PAYBOX_SIGNING_KEY || '').trim();
    if (!token) return res.status(404).json({ error: 'PAYBOX_SIGNING_KEY not set' });
    try {
      const body = token.startsWith('pbxk1.') ? token.slice(6) : token;
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const apiPubHex = String(parsed.p ?? parsed.apiPubHex ?? '');
      const apiPrivHex = String(parsed.s ?? parsed.apiPrivHex ?? '');
      if (!apiPubHex || !apiPrivHex) throw new Error('missing key material');
      res.json({ apiPubHex, apiPrivHex });
    } catch (err) {
      res.status(500).json({ error: `bad signing key: ${err.message}` });
    }
  });

  // The cockpit reports the signing app's visible state so the operator (and
  // the server log) can see what the iframe is showing without screen access.
  app.post('/api/cockpit/report', (req, res) => {
    console.log(`[cockpit-app] ${String(req.body?.text || '').slice(0, 300).replace(/\s+/g, ' ')}`);
    res.json({ ok: true });
  });

  app.post('/api/cockpit/mark', (req, res) => {
    const { request_id, status } = req.body || {};
    if (!request_id || !status) return res.status(400).json({ error: 'request_id and status required' });
    db.prepare('UPDATE live_trades SET status = ? WHERE request_id = ?').run(String(status).slice(0, 40), request_id);
    res.json({ ok: true });
  });

  // Manual cycle trigger (handy in dev)
  app.post('/api/cycle', (req, res) => {
    runCycle();
    res.json({ ok: true });
  });

  // ---- Static dashboard (built frontend) ---------------------------------
  const dist = path.join(config.root, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api|oauth).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return app;
}
