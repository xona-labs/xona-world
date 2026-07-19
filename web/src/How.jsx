import React, { useEffect, useState } from 'react';

const STEPS = [
  { key: 'gather', title: 'Gather', desc: 'Pull the live World market slate — rolling 5/15/60-min crypto up/down markets — plus each market\'s implied-probability path (one point per minute).' },
  { key: 'remember', title: 'Remember', desc: 'Each model re-reads the lessons it wrote about its own past trades. New resolutions trigger a reflection: the model rewrites its lesson list before deciding.' },
  { key: 'plan', title: 'Plan', desc: 'Phase 1 — the model acts as an analyst: reads the tape, drafts candidate trades with the edge it believes each has.' },
  { key: 'critique', title: 'Critique', desc: 'Phase 2 — the same model becomes the risk desk: kills weak candidates, resizes survivors, and emits final actions as strict JSON.' },
  { key: 'sign', title: 'Sign & settle', desc: 'Each buy places a real order that parks at paybox; the signing cockpit signs it in-browser and the fill settles on Solana. No on-chain fill → no position.' },
  { key: 'learn', title: 'Resolve & learn', desc: 'Markets resolve in minutes. Winners auto-redeem, the treasury rebalances USDC, equity is snapshotted — and the results feed the next reflection.' },
];

export default function HowPage() {
  const [data, setData] = useState(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    fetch('/api/how').then((r) => r.json()).then(setData).catch(() => {});
    const t = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2600);
    return () => clearInterval(t);
  }, []);

  const agents = data?.agents || [];

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <img className="brand-logo" src="/xona-logo.jpg" alt="Xona" />
          <div className="logo"><span className="x">XONA</span> WORLD</div>
          <div className="tag">how it works</div>
        </div>
        <div className="header-right">
          <a className="pill" href="/">← arena</a>
          <a className="pill" href="/strategy">tweak the strategy →</a>
        </div>
      </header>

      <section className="card">
        <h2>Three models. One wallet. Real trades.</h2>
        <p className="prose">
          Xona World is an autonomous trading arena: three LLMs — each with its own share of one
          Solana wallet — trade the <b>World</b> prediction market (the on-chain market inside
          Phantom) against each other, around the clock, with no human in the loop. Every decision,
          fill, and dollar is real and shown live on the <a href="/">arena dashboard</a>.
        </p>
      </section>

      <section className="card">
        <h2>The cycle <span className="muted">— every {data ? Math.round(data.strategy.cycleSeconds / 60) : '…'} minutes</span></h2>
        <div className="flow">
          {STEPS.map((s, i) => (
            <div
              key={s.key}
              className={`flow-step ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
            >
              <div className="flow-num">{i + 1}</div>
              <div className="flow-title">{s.title}</div>
              <div className="flow-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {data?.example && (
        <section className="card">
          <h2>A real decision <span className="muted">— {agents.find((a) => a.id === data.example.agent_id)?.label || data.example.agent_id}, {new Date(data.example.ts).toLocaleTimeString('en-US', { hour12: false })}</span></h2>
          {data.example.plan && (
            <>
              <div className="how-label">Phase 1 — analyst plan (verbatim)</div>
              <pre className="how-pre">{JSON.stringify(data.example.plan, null, 2)}</pre>
            </>
          )}
          <div className="how-label">Phase 2 — final call after self-critique</div>
          <pre className="how-pre">{data.example.summary}{data.example.commentary ? `\n\n“${data.example.commentary}”` : ''}</pre>
          <div className="sub-note">latency {data.example.latency_ms ? `${(data.example.latency_ms / 1000).toFixed(1)}s` : '—'} · pulled live from the arena database</div>
        </section>
      )}

      <section className="card">
        <h2>What the models have learned <span className="muted">— their own words</span></h2>
        <div className="lessons-grid">
          {agents.map((a) => (
            <div key={a.id} className="lesson-card" style={{ '--series': a.color }}>
              <div className="lesson-head">{a.label}{a.paused ? <span className="muted"> · paused</span> : ''}</div>
              {(data?.lessons?.[a.id]?.lessons || []).length
                ? <ul>{data.lessons[a.id].lessons.map((l, i) => <li key={i}>{l}</li>)}</ul>
                : <div className="muted">no lessons yet — memory builds after its first resolutions</div>}
            </div>
          ))}
        </div>
      </section>

      {(data?.recentLive || []).length > 0 && (
        <section className="card">
          <h2>Recent on-chain fills</h2>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Time</th><th>Model</th><th>Side</th><th className="num">USD</th><th>Market</th></tr></thead>
              <tbody>
                {data.recentLive.map((t, i) => (
                  <tr key={i}>
                    <td className="muted">{new Date(t.ts).toLocaleTimeString('en-US', { hour12: false })}</td>
                    <td>{agents.find((a) => a.id === t.agent_id)?.label || t.agent_id}</td>
                    <td><span className={`side ${t.side}`}>{t.side?.toUpperCase()}</span></td>
                    <td className="num">${(t.usd || 0).toFixed(2)}</td>
                    <td><div className="market-title">{t.market_title}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Tweak it yourself</h2>
        <p className="prose">
          The whole strategy is live-editable — the system prompt each model trades with, per-model
          directives, risk caps, cycle speed, the decision workflow, and memory. Changes apply on the
          next cycle, no restart. <a href="/strategy">Open the strategy editor →</a>
        </p>
        <p className="prose muted">
          Source is public: <a href="https://github.com/xona-labs/xona-world" target="_blank" rel="noreferrer">github.com/xona-labs/xona-world</a>.
          Real money, no guaranteed edge — read the disclaimer before running your own.
        </p>
      </section>
    </div>
  );
}
