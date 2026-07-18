import { config, AGENTS } from './config.js';
import { db } from './db.js';
import { decide } from './llm.js';
import * as limitless from './venues/paper.js';
import * as world from './venues/world.js';
import * as oauth from './paybox/oauth.js';
import * as live from './paybox/live.js';

/**
 * The arena loop. Every cycle:
 *   1. pick the venue (World via paybox MCP when connected; Limitless fallback)
 *   2. refresh the market slate
 *   3. resolve expired positions, mark open ones to market
 *   4. ask each model for decisions (same prompt, same data)
 *   5. execute with hard risk caps
 *   6. snapshot equity per agent
 * Emits events through `broadcast` (SSE fan-out lives in api.js).
 */

const VENUES = { limitless, world };

let broadcast = () => {};
export function onBroadcast(fn) { broadcast = fn; }

let running = false;
let lastCycle = { startedAt: null, finishedAt: null, error: null, slateSize: 0, venue: null };
export function cycleStatus() {
  return { ...lastCycle, cycleSeconds: config.cycleSeconds, llmReady: !!config.openrouter.apiKey };
}

const q = {
  creditDeposit: db.prepare('UPDATE agents SET cash = cash + ?, starting_bankroll = starting_bankroll + ? WHERE id = ?'),
  agent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  agents: db.prepare('SELECT * FROM agents'),
  setCash: db.prepare('UPDATE agents SET cash = ? WHERE id = ?'),
  openPositions: db.prepare("SELECT * FROM positions WHERE agent_id = ? AND status = 'open'"),
  allOpenPositions: db.prepare("SELECT * FROM positions WHERE status = 'open'"),
  position: db.prepare('SELECT * FROM positions WHERE id = ?'),
  insertPosition: db.prepare(`
    INSERT INTO positions (agent_id, venue, market_slug, market_title, side, shares, entry_price, cost,
                           current_price, expiration, opened_at)
    VALUES (@agent_id, @venue, @market_slug, @market_title, @side, @shares, @entry_price, @cost,
            @entry_price, @expiration, @ts)
  `),
  markPosition: db.prepare('UPDATE positions SET current_price = ? WHERE id = ?'),
  closePosition: db.prepare(`
    UPDATE positions SET status = @status, exit_price = @exit_price, proceeds = @proceeds,
                         pnl = @pnl, close_reason = @reason, closed_at = @ts, current_price = @exit_price
    WHERE id = @id
  `),
  insertTrade: db.prepare(`
    INSERT INTO trades (agent_id, position_id, action, market_title, side, shares, price, usd, pnl, reason, ts)
    VALUES (@agent_id, @position_id, @action, @market_title, @side, @shares, @price, @usd, @pnl, @reason, @ts)
  `),
  insertDecision: db.prepare(`
    INSERT INTO decisions (agent_id, ts, summary, commentary, raw, latency_ms, error)
    VALUES (@agent_id, @ts, @summary, @commentary, @raw, @latency_ms, @error)
  `),
  insertSnapshot: db.prepare(`
    INSERT OR REPLACE INTO equity_snapshots (agent_id, ts, equity, cash, positions_value)
    VALUES (?, ?, ?, ?, ?)
  `),
};

const SYSTEM_PROMPT = `You are an autonomous short-horizon trader in a live arena, competing head-to-head against rival AI models with equal starting capital. Your equity curve is public. Your goal: finish with more money than your rivals.

You trade rolling 5/15/60-minute binary markets on crypto price direction (BTC, ETH, SOL, XRP…): "price up in next N mins?" A YES share pays $1.00 if the asset closes the window UP versus the window open, NO pays $1.00 otherwise. Buying at price p risks p per share for a payout of 1. Prices are the market's implied probability; each market shows its recent YES-price path (one point per minute) — that is the market's live directional lean.

How to win:
- Read the trend path: a steadily climbing YES price means the asset is up so far in the window (momentum); a price snapping back toward 0.50 means the move faded (mean reversion). Trade the continuation or the fade — but have a reason.
- A YES near 0.80 late in a window is usually a near-lock priced with a premium; buying it earns little. The interesting entries are mispriced 0.30–0.70 quotes where the trend path disagrees with the price.
- The spread (~2-4¢ round trip) is your main cost. Prefer letting positions RIDE TO RESOLUTION (minutes away) over closing early — resolution pays face value with no spread. Close early only to cut a clearly broken thesis.
- Size to survive being wrong: these are minutes-long trades, variance is high. Standard size 10-25% of your cash; up to 35% only with strong conviction. Never go all-in on one window.
- Sitting 100% in cash every cycle is a losing strategy in an arena — a rival who finds even a small edge compounds it fast on 5-minute markets. Trade when you see something, hold when you truly don't.

Respond with STRICT JSON only:
{
  "commentary": "one or two sentences on your current read",
  "actions": [
    {"type": "open", "slug": "<market slug>", "side": "yes"|"no", "usd": <amount>, "reason": "<why>"},
    {"type": "close", "position_id": <id>, "reason": "<why>"}
  ]
}
The actions array may be empty. Never invent slugs or position ids not shown to you.`;

function fmtUsd(x) { return `$${(Math.round(x * 100) / 100).toFixed(2)}`; }

function fmtDuration(ms) {
  if (ms == null) return 'open-ended';
  const mins = Math.round(ms / 60_000);
  if (mins < 120) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function buildUserPrompt(agent, positions, slate, rivals) {
  const posLines = positions.length
    ? positions.map((p) => {
        const mark = p.current_price != null ? p.current_price : p.entry_price;
        const value = p.shares * mark;
        const upnl = value - p.cost;
        const left = p.expiration ? fmtDuration(p.expiration - Date.now()) : '?';
        return `- position_id=${p.id} | ${p.market_title} | ${p.side.toUpperCase()} | ${p.shares.toFixed(1)} sh @ ${p.entry_price} | now ${mark} | value ${fmtUsd(value)} | uPnL ${fmtUsd(upnl)} | closes in ${left}`;
      }).join('\n')
    : '(none)';

  const marketLines = slate.map((m) => {
    const left = m.expiration ? fmtDuration(m.expiration - Date.now()) : 'open-ended';
    const trend = m.yesTrend ? ` | YES path: ${m.yesTrend}` : '';
    return `- slug=${m.slug} | ${m.title} | buy YES @ ${m.buy?.[0]} / buy NO @ ${m.buy?.[1]} | closes in ${left}${trend}`;
  }).join('\n');

  const rivalLines = rivals.map((r) => `${r.label}: ${fmtUsd(r.equity)}`).join(' | ');

  return `COMPETITION
Your equity: ${fmtUsd(agent.equity)} (started ${fmtUsd(config.startingBankroll)})
Rivals: ${rivalLines}

PORTFOLIO
Cash: ${fmtUsd(agent.cash)}
Open positions:
${posLines}

MARKETS AVAILABLE (binary YES/NO, prices are cost per $1-payout share)
${marketLines}

RULES
- Max ${fmtUsd(Math.min(config.maxTradeUsd, Math.max(0.1, agent.cash * 0.35)))} per new position (35% of your cash). Max ${config.maxOpenPositions} open positions (you have ${positions.length}).
- You may open at most 2 new positions per cycle.
- Only use slugs and position_ids listed above.

Decide now.`;
}

// marketCache is keyed "venue:slug" so mixed-venue positions resolve correctly.
async function resolveAndMark(marketCache) {
  const open = q.allOpenPositions.all();
  const keys = [...new Set(open.map((p) => `${p.venue}:${p.market_slug}`))];

  for (const key of keys) {
    if (marketCache.has(key)) continue;
    const [venueName, slug] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const venue = VENUES[venueName];
    if (!venue) continue;
    try {
      marketCache.set(key, await venue.fetchMarket(slug));
    } catch (err) {
      console.error(`[engine] fetch ${key} failed:`, err.message);
    }
  }

  for (const p of open) {
    const venue = VENUES[p.venue];
    const m = marketCache.get(`${p.venue}:${p.market_slug}`);
    if (!venue || !m) continue;

    const payout = venue.resolutionPayout(m, p.side);
    if (payout != null) {
      const proceeds = p.shares * payout;
      const pnl = proceeds - p.cost;
      const ts = Date.now();
      db.transaction(() => {
        q.closePosition.run({ id: p.id, status: 'resolved', exit_price: payout, proceeds, pnl, reason: payout === 1 ? 'market resolved: WIN' : 'market resolved: LOSS', ts });
        const agent = q.agent.get(p.agent_id);
        q.setCash.run(agent.cash + proceeds, p.agent_id);
        q.insertTrade.run({ agent_id: p.agent_id, position_id: p.id, action: 'resolve', market_title: p.market_title, side: p.side, shares: p.shares, price: payout, usd: proceeds, pnl, reason: payout === 1 ? 'WIN' : 'LOSS', ts });
      })();
      broadcast('trade', { agentId: p.agent_id, action: 'resolve', title: p.market_title, side: p.side, pnl });
    } else if (!m.expired) {
      const mark = venue.markPrice(m, p.side);
      if (mark != null) q.markPosition.run(mark, p.id);
    }
    // expired but unresolved: leave as-is, resolution lands on a later cycle
  }
}

async function executeActions(agent, actions, slate, marketCache, venue) {
  const bySlug = new Map(slate.map((m) => [m.slug, m]));
  const executed = [];
  const liveMode = venue.name === 'world' && config.live.enabled;
  let opens = 0;

  for (const a of Array.isArray(actions) ? actions : []) {
    try {
      if (a.type === 'open') {
        if (opens >= 2) continue;
        const m = bySlug.get(a.slug);
        if (!m) continue;
        // Quotes are from cycle start; don't fill into a window that is closing.
        if (m.expiration && m.expiration < Date.now() + 45_000) continue;
        const side = a.side === 'no' ? 'no' : 'yes';
        const current = q.agent.get(agent.id);
        const openCount = q.openPositions.all(agent.id).length;
        if (openCount >= config.maxOpenPositions) continue;
        const usdCap = Math.min(config.maxTradeUsd, Math.max(0.1, current.cash * 0.35));
        const usd = Math.min(Math.max(Number(a.usd) || 0, 0.1), usdCap, current.cash);
        if (usd < 0.1) continue;
        let fill = venue.paperBuy(m, side, usd);
        if (!fill) continue;
        if (liveMode) {
          // Real fill gates the ledger: no on-chain settle, no position.
          const lr = await live.liveBuy({ agentId: agent.id, market: m, side, usd });
          if (lr) broadcast('live', { kind: 'buy', ...lr });
          if (!lr || lr.status !== 'success') {
            executed.push(`live buy ${lr?.status || 'failed'} — ${m.title}`);
            continue;
          }
          if (lr.shares) fill = { price: usd / lr.shares, shares: lr.shares };
        }
        const ts = Date.now();
        db.transaction(() => {
          const info = q.insertPosition.run({ agent_id: agent.id, venue: venue.name, market_slug: m.slug, market_title: m.title, side, shares: fill.shares, entry_price: fill.price, cost: usd, expiration: m.expiration, ts });
          q.setCash.run(current.cash - usd, agent.id);
          q.insertTrade.run({ agent_id: agent.id, position_id: info.lastInsertRowid, action: 'open', market_title: m.title, side, shares: fill.shares, price: fill.price, usd, pnl: null, reason: String(a.reason || '').slice(0, 400), ts });
        })();
        opens += 1;
        executed.push(`open ${side.toUpperCase()} ${fmtUsd(usd)} @ ${fill.price.toFixed(3)} — ${m.title}`);
        broadcast('trade', { agentId: agent.id, action: 'open', title: m.title, side, usd, price: fill.price });
      } else if (a.type === 'close') {
        const p = q.position.get(Number(a.position_id));
        if (!p || p.agent_id !== agent.id || p.status !== 'open') continue;
        const pVenue = VENUES[p.venue];
        const m = marketCache.get(`${p.venue}:${p.market_slug}`);
        if (!pVenue || !m || m.expired) continue;
        const price = pVenue.paperSellPrice(m, p.side);
        if (price == null) continue;
        if (liveMode && p.venue === 'world') {
          const lr = await live.liveSell({ agentId: agent.id, market: m, side: p.side, shares: p.shares });
          if (lr) broadcast('live', { kind: 'sell', ...lr });
          if (!lr || lr.status !== 'success') {
            executed.push(`live sell ${lr?.status || 'failed'} — ${p.market_title}`);
            continue;
          }
        }
        const proceeds = p.shares * price;
        const pnl = proceeds - p.cost;
        const ts = Date.now();
        db.transaction(() => {
          q.closePosition.run({ id: p.id, status: 'closed', exit_price: price, proceeds, pnl, reason: String(a.reason || 'agent close').slice(0, 400), ts });
          const current = q.agent.get(agent.id);
          q.setCash.run(current.cash + proceeds, agent.id);
          q.insertTrade.run({ agent_id: agent.id, position_id: p.id, action: 'close', market_title: p.market_title, side: p.side, shares: p.shares, price, usd: proceeds, pnl, reason: String(a.reason || '').slice(0, 400), ts });
        })();
        executed.push(`close #${p.id} @ ${price.toFixed(3)} (pnl ${fmtUsd(pnl)}) — ${p.market_title}`);
        broadcast('trade', { agentId: agent.id, action: 'close', title: p.market_title, side: p.side, pnl });
      }
    } catch (err) {
      console.error(`[engine] action failed for ${agent.id}:`, err.message);
    }
  }
  return executed;
}

function agentEquity(agent) {
  const positions = q.openPositions.all(agent.id);
  const positionsValue = positions.reduce((sum, p) => {
    const mark = p.current_price != null ? p.current_price : p.entry_price;
    return sum + p.shares * mark;
  }, 0);
  return { equity: agent.cash + positionsValue, positionsValue };
}

function snapshotEquity(ts) {
  const out = [];
  for (const agent of q.agents.all()) {
    const { equity, positionsValue } = agentEquity(agent);
    q.insertSnapshot.run(agent.id, ts, equity, agent.cash, positionsValue);
    out.push({ agentId: agent.id, ts, equity, cash: agent.cash, positionsValue });
  }
  broadcast('equity', { snapshots: out });
  return out;
}

/**
 * Wallet USDC above the sum of the three ledgers = a fresh deposit (redemption
 * lag only ever pushes the wallet BELOW the ledgers). Split it equally, and
 * grow starting bankrolls too so a top-up never reads as trading PnL.
 */
const DEPOSIT_THRESHOLD_USD = 0.25;
async function detectDeposit() {
  if (!config.live.enabled) return;
  const bal = await live.refreshBalance();
  if (bal == null) return;
  const ledgerCash = q.agents.all().reduce((s, a) => s + a.cash, 0);
  const surplus = bal - ledgerCash;
  if (surplus < DEPOSIT_THRESHOLD_USD) return;
  const share = Math.floor((surplus / AGENTS.length) * 100) / 100;
  if (share <= 0) return;
  db.transaction(() => {
    for (const a of AGENTS) q.creditDeposit.run(share, share, a.id);
  })();
  console.log(`[engine] deposit detected: +$${surplus.toFixed(2)} → $${share.toFixed(2)} per agent`);
  broadcast('live', { kind: 'deposit', amount: surplus, perAgent: share });
}

async function pickVenueAndSlate() {
  if (oauth.isConnected()) {
    try {
      const slate = await world.fetchSlate();
      if (slate.length) return { venue: world, slate };
      console.error('[engine] world slate empty');
    } catch (err) {
      console.error('[engine] world slate failed:', err.message);
    }
    // Real-money mode trades World only — a paper fallback would desync the
    // ledgers from the wallet. Sit the cycle out instead.
    if (config.live.enabled) return { venue: world, slate: [] };
  }
  return { venue: limitless, slate: await limitless.fetchSlate() };
}

export async function runCycle() {
  if (running) return;
  running = true;
  lastCycle = { startedAt: Date.now(), finishedAt: null, error: null, slateSize: 0, venue: null };
  broadcast('cycle', { phase: 'start', ts: lastCycle.startedAt });

  try {
    const { venue, slate } = await pickVenueAndSlate();
    lastCycle.venue = venue.name;
    lastCycle.slateSize = slate.length;

    const marketCache = new Map();
    for (const m of slate) marketCache.set(`${venue.name}:${m.slug}`, m);

    await resolveAndMark(marketCache);

    if (venue.name === 'world') {
      live.redeemSweep()
        .then((rs) => { if (rs.length) broadcast('live', { kind: 'redeem', count: rs.length }); })
        .catch(() => {});
      // Fire-and-forget: the conversion parks + the cockpit signs it; the
      // replenished USDC is there for the NEXT cycle's buys.
      live.ensureUsdc()
        .then((r) => { if (r) broadcast('live', { kind: 'convert', ...r }); })
        .catch(() => {});
      await detectDeposit().catch((err) => console.error('[engine] deposit check failed:', err.message));
    }

    if (config.openrouter.apiKey && slate.length) {
      const equities = q.agents.all().map((a) => ({ id: a.id, label: a.label, ...agentEquity(a) }));
      await Promise.all(AGENTS.map(async (spec) => {
        const agent = q.agent.get(spec.id);
        if (agent.paused) return; // benched: no decisions, positions still resolve
        const positions = q.openPositions.all(spec.id);
        const me = equities.find((e) => e.id === spec.id);
        const rivals = equities.filter((e) => e.id !== spec.id);
        const ts = Date.now();
        try {
          const { json, raw, latencyMs } = await decide(
            spec.model,
            SYSTEM_PROMPT,
            buildUserPrompt({ ...agent, equity: me.equity }, positions, slate, rivals),
          );
          const executed = await executeActions(agent, json.actions, slate, marketCache, venue);
          const summary = executed.length ? executed.join(' | ') : 'hold';
          q.insertDecision.run({ agent_id: spec.id, ts, summary, commentary: String(json.commentary || '').slice(0, 600), raw: raw.slice(0, 4000), latency_ms: latencyMs, error: null });
          broadcast('decision', { agentId: spec.id, summary, commentary: json.commentary, latencyMs });
        } catch (err) {
          q.insertDecision.run({ agent_id: spec.id, ts, summary: null, commentary: null, raw: null, latency_ms: null, error: err.message.slice(0, 500) });
          broadcast('decision', { agentId: spec.id, error: err.message });
        }
      }));
    }

    snapshotEquity(Date.now());
  } catch (err) {
    lastCycle.error = err.message;
    console.error('[engine] cycle failed:', err);
  } finally {
    lastCycle.finishedAt = Date.now();
    running = false;
    broadcast('cycle', { phase: 'end', ts: lastCycle.finishedAt, error: lastCycle.error });
  }
}

export function startLoop() {
  runCycle();
  setInterval(runCycle, config.cycleSeconds * 1000);
}
