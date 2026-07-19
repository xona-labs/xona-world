import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EquityChart from './EquityChart.jsx';

const usd = (x, digits = 2) =>
  (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const timeLeft = (ms) => {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 120) return `${mins}m left`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
};
const timeAgo = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const clock = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });

export default function App() {
  const [boot, setBoot] = useState(null);
  const [liveEquity, setLiveEquity] = useState(null);
  const [feed, setFeed] = useState([]);
  const [tab, setTab] = useState('open');
  const [fundOpen, setFundOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refetchTimer = useRef(null);

  const refetch = useCallback(() => {
    fetch('/api/bootstrap').then((r) => r.json()).then(setBoot).catch(() => {});
  }, []);
  const scheduleRefetch = useCallback(() => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(refetch, 800);
  }, [refetch]);

  useEffect(() => { refetch(); }, [refetch]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // SSE
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => refetch(); // resync after any reconnect (server restarts)
    es.addEventListener('equity', (e) => setLiveEquity(JSON.parse(e.data)));
    es.addEventListener('trade', (e) => {
      const d = JSON.parse(e.data);
      setFeed((f) => [{ kind: 'trade', ts: Date.now(), ...d }, ...f].slice(0, 60));
      scheduleRefetch();
    });
    es.addEventListener('decision', (e) => {
      const d = JSON.parse(e.data);
      setFeed((f) => [{ kind: 'decision', ts: Date.now(), ...d }, ...f].slice(0, 60));
      scheduleRefetch();
    });
    es.addEventListener('live', (e) => {
      const d = JSON.parse(e.data);
      setFeed((f) => [{ ...d, kind: 'live', ts: Date.now() }, ...f].slice(0, 60));
      scheduleRefetch();
    });
    es.addEventListener('cycle', (e) => {
      const d = JSON.parse(e.data);
      if (d.phase === 'end') scheduleRefetch();
    });
    return () => es.close();
  }, [scheduleRefetch]);

  const agents = useMemo(() => {
    if (!boot) return [];
    const specById = Object.fromEntries((boot.agentSpecs || []).map((s) => [s.id, s]));
    return boot.agents.map((a) => ({ ...a, dash: specById[a.id]?.dash || 'solid' }));
  }, [boot]);
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const ranked = useMemo(() => [...agents].sort((a, b) => b.equity - a.equity), [agents]);

  // A cycle is in-flight when it started after it last finished. Cycles can run
  // longer than their interval (live signing), so show "running" rather than a
  // countdown frozen at 00:00.
  const cycleLabel = useMemo(() => {
    const c = boot?.cycle;
    if (!c?.startedAt) return 'cycle —';
    const running = !c.finishedAt || c.startedAt > c.finishedAt;
    if (running) return 'cycle running…';
    const secs = Math.max(0, Math.round((c.startedAt + c.cycleSeconds * 1000 - now) / 1000));
    return `next cycle ${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }, [boot, now]);

  const connectPaybox = async () => {
    const r = await fetch('/api/paybox/connect', { method: 'POST' });
    const { url, error } = await r.json();
    if (url) window.open(url, '_blank');
    else alert(error || 'connect failed');
  };

  const setPaused = async (id, paused) => {
    await fetch(`/api/agents/${id}/paused`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    });
    refetch();
  };
  const pullFunds = async (id) => {
    if (!window.confirm(`Move ALL other models' cash into ${byId[id]?.label}?`)) return;
    await fetch('/api/agents/reallocate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: id }),
    });
    refetch();
  };

  if (!boot) return <div className="shell"><div className="empty">loading arena…</div></div>;

  const walletAddress = boot.live?.wallet?.address || null;
  const shortAddr = walletAddress ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}` : null;

  const openPositions = agents.flatMap((a) => a.openPositions.map((p) => ({ ...p, agent: a })));
  openPositions.sort((a, b) => b.opened_at - a.opened_at);

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <img className="brand-logo" src="/xona-logo.jpg" alt="Xona" />
          <div className="logo"><span className="x">XONA</span> WORLD</div>
          <div className="tag">
            autonomous prediction-market arena
            {walletAddress && (
              <>
                {' · '}
                <button className="linklike" onClick={() => setFundOpen(true)} title="Fund the trading wallet">
                  wallet {shortAddr} — fund →
                </button>
              </>
            )}
          </div>
        </div>
        <div className="header-right">
          <a className="pill" href="/how">how it works</a>
          <a className="pill" href="/strategy">strategy</a>
          <div className="pill">
            <span className={`dot ${boot.cycle.llmReady ? 'live' : 'warn'}`} />
            {boot.cycle.llmReady ? 'agents live' : 'agents idle'}
          </div>
          <div className="pill mono">{cycleLabel}</div>
          <div className="pill">
            <span className={`dot ${boot.paybox.connected ? 'live' : ''}`} />
            World MCP&nbsp;
            {boot.paybox.connected
              ? <b>connected</b>
              : <button onClick={connectPaybox}>connect →</button>}
          </div>
          <div className="pill">data <b>{(boot.cycle.venue || '—').toUpperCase()}</b></div>
          <div className="pill">
            live <b>{boot.live?.enabled ? `wallet $${(boot.live.balance?.usd ?? 0).toFixed(2)}` : 'OFF'}</b>
          </div>
          {boot.live?.enabled && (
            <div className="pill" title="The signing cockpit that settles trades on-chain">
              <span className={`dot ${boot.live.cockpitSeenAt && now - boot.live.cockpitSeenAt < 20000 ? 'live' : 'warn'}`} />
              signer {boot.live.cockpitSeenAt && now - boot.live.cockpitSeenAt < 20000 ? 'online' : 'OFFLINE'}
            </div>
          )}
          {walletAddress && boot.live?.enabled && (
            <button className="btn solid" onClick={() => setFundOpen(true)}>+ Fund</button>
          )}
        </div>
      </header>

      {!boot.cycle.llmReady && (
        <div className="banner">
          ⚠ Agents are idle — set <code>OPENROUTER_API_KEY</code> in <code>.env</code> and restart the server to let Kimi K3, GPT-5.6 Sol and Grok 4.5 start trading.
        </div>
      )}

      <section className="tiles">
        {ranked.map((a, i) => {
          const pnl = a.equity - a.starting_bankroll;
          const dir = pnl > 0.005 ? 'up' : pnl < -0.005 ? 'down' : 'flat';
          const losses = a.closedCount - a.wins;
          return (
            <div className={`tile ${a.paused ? 'paused' : ''}`} key={a.id} style={{ '--series': a.color }}>
              <div className={`rank ${i === 0 && pnl !== 0 ? 'first' : ''}`}>{a.paused ? 'PAUSED' : `#${i + 1}`}</div>
              <div className="who">
                <div className="name"><span className={`swatch ${a.dash}`} />{a.label}</div>
              </div>
              <div className="vendor">{a.vendor} · {a.model}</div>
              <div className="equity">{usd(a.equity)}</div>
              <div className={`delta ${dir}`}>{dir === 'down' ? '▼' : dir === 'up' ? '▲' : '—'} {usd(Math.abs(pnl))} · {pct(pnl / a.starting_bankroll)}</div>
              <div className="sub">
                <span>cash<b>{usd(a.cash, 0)}</b></span>
                <span>in play<b>{usd(a.positionsValue, 0)}</b></span>
                <span>open<b>{a.openPositions.length}</b></span>
                <span>record<b>{a.wins}W–{losses}L</b></span>
              </div>
              <div className="tile-actions">
                <button onClick={() => setPaused(a.id, !a.paused)}>
                  {a.paused ? '▶ resume' : '⏸ pause'}
                </button>
                <button onClick={() => pullFunds(a.id)} title="Move all other models' cash into this one">
                  ⇤ pull funds
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>
          Equity — head to head
          <span className="legend">
            {agents.map((a) => (
              <span className="item" key={a.id}>
                <span className={`mark ${a.dash}`} style={{ '--series': a.color }} />{a.label}
              </span>
            ))}
          </span>
        </h2>
        <div className="sub-note">
          three models, one shared wallet split evenly · same markets, same rules, only the model differs
        </div>
        <EquityChart
          agents={boot.agentSpecs.map((s) => ({ ...s, ...byId[s.id] }))}
          history={boot.history}
          live={liveEquity}
          startingBankroll={boot.config.startingBankroll}
        />
      </section>

      <section className="columns">
        <div className="card">
          <h2>
            Positions
            <span className="tabs">
              <button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open ({openPositions.length})</button>
              <button className={tab === 'closed' ? 'active' : ''} onClick={() => setTab('closed')}>Closed</button>
              <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades</button>
            </span>
          </h2>
          {tab === 'open' && (
            openPositions.length === 0 ? <div className="empty">no open positions</div> : (
              <div className="table-scroll">
              <table>
                <thead><tr><th>Model</th><th>Market</th><th>Side</th><th className="num">Entry</th><th className="num">Now</th><th className="num">Value</th><th className="num">uPnL</th></tr></thead>
                <tbody>
                  {openPositions.map((p) => {
                    const mark = p.current_price ?? p.entry_price;
                    const value = p.shares * mark;
                    const upnl = value - p.cost;
                    return (
                      <tr key={p.id}>
                        <td><AgentChip a={p.agent} /></td>
                        <td><div className="market-title" title={p.market_title}>{p.market_title}</div>
                          <span className="muted">{p.expiration ? timeLeft(p.expiration - now) : ''}</span></td>
                        <td><span className={`side ${p.side}`}>{p.side.toUpperCase()}</span></td>
                        <td className="num">{p.entry_price.toFixed(3)}</td>
                        <td className="num">{mark.toFixed(3)}</td>
                        <td className="num">{usd(value)}</td>
                        <td className={`num pnl ${upnl >= 0 ? 'up' : 'down'}`}>{upnl >= 0 ? '+' : ''}{usd(upnl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )
          )}
          {tab === 'closed' && (
            (boot.closedPositions?.length || 0) === 0 ? <div className="empty">nothing closed yet</div> : (
              <div className="table-scroll">
              <table>
                <thead><tr><th>Model</th><th>Market</th><th>Side</th><th className="num">Entry</th><th className="num">Exit</th><th className="num">PnL</th><th>Why</th></tr></thead>
                <tbody>
                  {boot.closedPositions.map((p) => (
                    <tr key={p.id}>
                      <td><AgentChip a={byId[p.agent_id]} /></td>
                      <td><div className="market-title" title={p.market_title}>{p.market_title}</div></td>
                      <td><span className={`side ${p.side}`}>{p.side.toUpperCase()}</span></td>
                      <td className="num">{p.entry_price.toFixed(3)}</td>
                      <td className="num">{p.exit_price?.toFixed(3)}</td>
                      <td className={`num pnl ${p.pnl >= 0 ? 'up' : 'down'}`}>{p.pnl >= 0 ? '+' : ''}{usd(p.pnl)}</td>
                      <td className="muted" style={{ maxWidth: 180 }}>{p.close_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )
          )}
          {tab === 'trades' && (
            (boot.trades?.length || 0) === 0 ? <div className="empty">no trades yet</div> : (
              <div className="table-scroll">
              <table>
                <thead><tr><th>Time</th><th>Model</th><th>Action</th><th>Market</th><th className="num">Price</th><th className="num">USD</th><th className="num">PnL</th></tr></thead>
                <tbody>
                  {boot.trades.map((t) => (
                    <tr key={t.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{clock(t.ts)}</td>
                      <td><AgentChip a={byId[t.agent_id]} /></td>
                      <td>{t.action} <span className={`side ${t.side}`}>{t.side.toUpperCase()}</span></td>
                      <td><div className="market-title" title={t.market_title}>{t.market_title}</div></td>
                      <td className="num">{t.price.toFixed(3)}</td>
                      <td className="num">{usd(t.usd)}</td>
                      <td className={`num pnl ${t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'}`}>{t.pnl == null ? '—' : `${t.pnl >= 0 ? '+' : ''}${usd(t.pnl)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )
          )}
        </div>

        <div className="card">
          <h2>Live feed</h2>
          <div className="sub-note">every decision, straight from the models</div>
          <div className="feed">
            {feed.length === 0 && (boot.decisions || []).length === 0 && (
              <div className="empty">waiting for the next cycle…</div>
            )}
            {feed.map((f, i) => <FeedItem key={`live-${i}`} f={f} byId={byId} />)}
            {boot.decisions.map((d) => (
              <FeedItem
                key={`d-${d.id}`}
                f={{ kind: 'decision', ts: d.ts, agentId: d.agent_id, summary: d.summary, commentary: d.commentary, error: d.error }}
                byId={byId}
              />
            ))}
          </div>
        </div>
      </section>

      {boot.live?.enabled && (boot.live.trades || []).length > 0 && (
        <section className="card">
          <h2>
            On-chain settlement
            <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
              wallet ${(boot.live.balance?.usd ?? 0).toFixed(2)} · every order parks at paybox, signs in the cockpit, settles on Solana
            </span>
          </h2>
          <div className="table-scroll" style={{ maxHeight: 300 }}>
            <table>
              <thead><tr><th>Time</th><th>Model</th><th>Action</th><th>Detail</th><th className="num">USD</th><th>Status</th></tr></thead>
              <tbody>
                {boot.live.trades.map((t, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{clock(t.ts)}</td>
                    <td>{byId[t.agent_id] ? <AgentChip a={byId[t.agent_id]} /> : <span className="muted">{t.agent_id}</span>}</td>
                    <td>{t.action}{t.side ? <> <span className={`side ${t.side}`}>{t.side.toUpperCase()}</span></> : null}</td>
                    <td><div className="market-title">{t.market_title || '—'}</div></td>
                    <td className="num">{t.usd != null ? `$${Number(t.usd).toFixed(2)}` : '—'}</td>
                    <td><span className={`settle-status ${t.status === 'success' ? 'ok' : String(t.status).startsWith('pending') ? 'pending' : 'err'}`}>{t.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="footer">
        Xona World Arena · live on World (paybox) MCP · fills settle on Solana
      </footer>

      {fundOpen && (
        <FundModal
          wallet={boot.live.wallet}
          balance={boot.live.balance}
          onClose={() => setFundOpen(false)}
        />
      )}
    </div>
  );
}

function FundModal({ wallet, balance, onClose }) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState(25);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const copy = async () => {
    try { await navigator.clipboard.writeText(wallet.address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const buy = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/fund/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountUsd: Number(amount) || null }),
      });
      const d = await r.json();
      if (d.url) window.open(d.url, '_blank');
      else setErr(d.error || 'could not create checkout');
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Fund the arena wallet</h3>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <p className="modal-note">
          One shared Solana wallet · new funds split evenly across the three models next cycle.
          Current balance <b>${(balance?.usd ?? 0).toFixed(2)}</b>
          {balance?.cash != null && <span className="muted"> ({balance.usdc?.toFixed(2)} USDC + {balance.cash?.toFixed(2)} CASH)</span>}.
        </p>

        <div className="fund-block">
          <div className="fund-label">Send USDC (Solana / SPL) to this address</div>
          <div className="addr-row">
            <code>{wallet.address}</code>
            <button className="btn solid" onClick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
          </div>
          <div className="fund-warn">Solana USDC only. Sending any other token or chain will be lost.</div>
        </div>

        <div className="fund-block">
          <div className="fund-label">Or buy with card (MoonPay → deposits USDC here)</div>
          <div className="addr-row">
            <div className="amt">
              <span>$</span>
              <input type="number" min="10" step="5" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <button className="btn solid" onClick={buy} disabled={loading}>
              {loading ? 'opening…' : 'Buy USDC →'}
            </button>
          </div>
          {err && <div className="fund-warn err">{err}</div>}
        </div>
      </div>
    </div>
  );
}

function AgentChip({ a }) {
  if (!a) return null;
  return (
    <span className="agent-chip">
      <span className={`swatch ${a.dash || ''}`} style={{ '--series': a.color }} />{a.label}
    </span>
  );
}

function FeedItem({ f, byId }) {
  const a = byId[f.agentId];
  return (
    <div className="feed-item" style={{ '--series': a?.color }}>
      <div className="top"><b>{a?.label || f.agentId}</b><span>{timeAgo(f.ts)}</span></div>
      {f.kind === 'live' ? (
        <div className="what">
          {f.perAgent != null
            ? <>⛓ deposit detected — {usd(f.amount || 0)} split, +{usd(f.perAgent)} per model</>
            : f.amountUsd != null
              ? <>⛓ treasury — converted {usd(f.amountUsd)} CASH → USDC ({f.status})</>
              : f.market
                ? <>⛓ LIVE {f.status === 'success' ? 'fill' : f.status} — {f.side?.toUpperCase()} {usd(f.usd || 0)} on {f.market}</>
                : <>⛓ LIVE redeem swept {f.count} settled position{f.count === 1 ? '' : 's'}</>}
        </div>
      ) : f.kind === 'trade' ? (
        <div className="what">
          {f.action === 'open' && <>opened <span className={`side ${f.side}`}>{f.side?.toUpperCase()}</span> {usd(f.usd || 0)} @ {f.price} — {f.title}</>}
          {f.action === 'close' && <>closed {f.title} <span className={`pnl ${f.pnl >= 0 ? 'up' : 'down'}`}>{f.pnl >= 0 ? '+' : ''}{usd(f.pnl || 0)}</span></>}
          {f.action === 'resolve' && <>{f.pnl >= 0 ? '🏆 won' : '✖ lost'} {f.title} <span className={`pnl ${f.pnl >= 0 ? 'up' : 'down'}`}>{f.pnl >= 0 ? '+' : ''}{usd(f.pnl || 0)}</span></>}
        </div>
      ) : f.error ? (
        <div className="err">error: {f.error}</div>
      ) : (
        <>
          <div className="what">{f.summary || 'hold'}</div>
          {f.commentary && <div className="commentary">“{f.commentary}”</div>}
        </>
      )}
    </div>
  );
}
