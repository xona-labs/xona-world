import React, { useEffect, useState } from 'react';

export default function StrategyPage() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [agents, setAgents] = useState([]);
  const [token, setToken] = useState(localStorage.getItem('xw.adminToken') || '');
  const [saved, setSaved] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch('/api/strategy').then((r) => r.json()).then((d) => { setData(d); setForm(d.strategy); });
    fetch('/api/bootstrap').then((r) => r.json()).then((d) => setAgents(d.agentSpecs || [])).catch(() => {});
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setMem = (k, v) => setForm((f) => ({ ...f, memory: { ...f.memory, [k]: v } }));
  const setNote = (id, v) => setForm((f) => ({ ...f, agentNotes: { ...f.agentNotes, [id]: v } }));

  const save = async () => {
    setErr(null); setSaved(null);
    localStorage.setItem('xw.adminToken', token);
    const r = await fetch('/api/strategy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-cockpit-token': token } : {}) },
      body: JSON.stringify(form),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.error || `save failed (${r.status})`); return; }
    setForm(d.strategy);
    setSaved(Date.now());
  };

  const reset = () => data && setForm(data.defaults);

  if (!form) return <div className="shell"><div className="empty">loading strategy…</div></div>;

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <img className="brand-logo" src="/xona-logo.jpg" alt="Xona" />
          <div className="logo"><span className="x">XONA</span> WORLD</div>
          <div className="tag">strategy editor · applies next cycle, no restart</div>
        </div>
        <div className="header-right">
          <a className="pill" href="/">← arena</a>
          <a className="pill" href="/how">how it works</a>
        </div>
      </header>

      <section className="card">
        <h2>Risk & cadence</h2>
        <div className="knobs">
          <label>cycle seconds<input type="number" min="120" max="3600" value={form.cycleSeconds} onChange={(e) => set('cycleSeconds', +e.target.value)} /></label>
          <label>max $ per trade<input type="number" min="0.5" max="500" step="0.5" value={form.maxTradeUsd} onChange={(e) => set('maxTradeUsd', +e.target.value)} /></label>
          <label>max open positions<input type="number" min="1" max="12" value={form.maxOpenPositions} onChange={(e) => set('maxOpenPositions', +e.target.value)} /></label>
          <label>max opens / cycle<input type="number" min="1" max="4" value={form.maxOpensPerCycle} onChange={(e) => set('maxOpensPerCycle', +e.target.value)} /></label>
          <label>workflow
            <select value={form.workflow} onChange={(e) => set('workflow', e.target.value)}>
              <option value="plan-critique">plan → critique (2 calls)</option>
              <option value="single">single shot (1 call)</option>
            </select>
          </label>
          <label>memory
            <select value={form.memory.enabled ? '1' : '0'} onChange={(e) => setMem('enabled', e.target.value === '1')}>
              <option value="1">on — reflect & learn</option>
              <option value="0">off — stateless</option>
            </select>
          </label>
          <label>max lessons<input type="number" min="0" max="20" value={form.memory.maxLessons} onChange={(e) => setMem('maxLessons', +e.target.value)} /></label>
        </div>
      </section>

      <section className="card">
        <h2>System prompt <span className="muted">— every model trades with this</span></h2>
        <textarea className="prompt-edit" rows={16} value={form.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
      </section>

      <section className="card">
        <h2>Per-model directives <span className="muted">— optional persona appendix</span></h2>
        {agents.map((a) => (
          <div key={a.id} className="note-row">
            <div className="how-label">{a.label}</div>
            <textarea rows={2} placeholder={`e.g. "Only trade 60-minute windows. Prefer NO on overextended moves."`}
              value={form.agentNotes[a.id] || ''} onChange={(e) => setNote(a.id, e.target.value)} />
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Apply</h2>
        <div className="apply-row">
          <input className="token-input" type="password" placeholder="admin token (only needed on public deploys)"
            value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn solid" onClick={save}>Save strategy</button>
          <button className="btn solid" onClick={reset}>Reset to defaults</button>
        </div>
        {saved && <div className="sub-note" style={{ marginTop: 10 }}>✓ saved — applies from the next cycle</div>}
        {err && <div className="fund-warn err" style={{ marginTop: 10 }}>{err}</div>}
        <p className="prose muted" style={{ marginTop: 12 }}>
          All numbers are clamped server-side to safe ranges. The prompt and directives steer real
          money — small, deliberate edits beat rewrites.
        </p>
      </section>
    </div>
  );
}
