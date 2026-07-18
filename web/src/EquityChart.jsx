import React, { useEffect, useRef } from 'react';
import { createChart, LineStyle } from 'lightweight-charts';

const DASH_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted };

/**
 * Head-to-head equity curves, one line per model. Times are unix seconds.
 * `history` is the full snapshot list; `live` is the latest SSE equity event
 * (applied incrementally so the chart streams without refetching).
 */
export default function EquityChart({ agents, history, live, startingBankroll }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const lastTsRef = useRef({});

  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8a8a8a',
        fontSize: 11,
        fontFamily: 'ui-monospace, Menlo, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.055)' },
        horzLines: { color: 'rgba(255,255,255,0.055)' },
      },
      // Headroom so the series name badges don't sit on top of axis ticks.
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: false },
      crosshair: {
        horzLine: { labelBackgroundColor: '#2a2a2a' },
        vertLine: { labelBackgroundColor: '#2a2a2a' },
      },
      localization: {
        priceFormatter: (p) => `$${p.toFixed(0)}`,
      },
    });
    chartRef.current = chart;

    let first = true;
    for (const a of agents) {
      const s = chart.addLineSeries({
        color: a.color,
        lineWidth: 2,
        lineStyle: DASH_STYLE[a.dash] ?? LineStyle.Solid,
        title: a.label,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 4,
      });
      if (first) {
        s.createPriceLine({
          price: startingBankroll,
          color: 'rgba(255,255,255,0.25)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
        });
        first = false;
      }
      seriesRef.current[a.id] = s;
    }
    return () => { chart.remove(); seriesRef.current = {}; lastTsRef.current = {}; };
    // agents identity is stable for the app's lifetime
  }, [agents.length]);

  // Full history load / reload
  useEffect(() => {
    if (!history) return;
    const byAgent = {};
    for (const row of history) {
      (byAgent[row.agent_id] ||= []).push({ time: Math.floor(row.ts / 1000), value: row.equity });
    }
    for (const [agentId, points] of Object.entries(byAgent)) {
      const s = seriesRef.current[agentId];
      if (!s) continue;
      // de-dup identical seconds (keep last)
      const dedup = [];
      for (const p of points) {
        if (dedup.length && dedup[dedup.length - 1].time === p.time) dedup[dedup.length - 1] = p;
        else dedup.push(p);
      }
      s.setData(dedup);
      lastTsRef.current[agentId] = dedup.length ? dedup[dedup.length - 1].time : 0;
    }
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  // Live streaming updates
  useEffect(() => {
    if (!live?.snapshots) return;
    for (const snap of live.snapshots) {
      const s = seriesRef.current[snap.agentId];
      if (!s) continue;
      const time = Math.floor(snap.ts / 1000);
      if (time < (lastTsRef.current[snap.agentId] || 0)) continue;
      s.update({ time, value: snap.equity });
      lastTsRef.current[snap.agentId] = time;
    }
  }, [live]);

  return <div className="chart-wrap" ref={elRef} />;
}
