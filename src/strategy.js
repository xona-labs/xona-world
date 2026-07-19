import { config } from './config.js';
import { kv } from './db.js';

/**
 * The live-tweakable strategy. Stored in kv, read fresh every cycle, edited
 * from the /strategy page — no restart needed. Every numeric knob is clamped
 * so a typo can't nuke the bankroll.
 */

export const DEFAULT_SYSTEM_PROMPT = `You are an autonomous short-horizon trader in a live arena, competing head-to-head against rival AI models with equal starting capital. Your equity curve is public. Your goal: finish with more money than your rivals.

You trade rolling 5/15/60-minute binary markets on crypto price direction (BTC, ETH, SOL, XRP…): "price up in next N mins?" A YES share pays $1.00 if the asset closes the window UP versus the window open, NO pays $1.00 otherwise. Buying at price p risks p per share for a payout of 1. Prices are the market's implied probability; each market shows its recent YES-price path (one point per minute) — that is the market's live directional lean.

How to win:
- Read the trend path: a steadily climbing YES price means the asset is up so far in the window (momentum); a price snapping back toward 0.50 means the move faded (mean reversion). Trade the continuation or the fade — but have a reason.
- A YES near 0.80 late in a window is usually a near-lock priced with a premium; buying it earns little. The interesting entries are mispriced 0.30–0.70 quotes where the trend path disagrees with the price.
- The spread (~2-4¢ round trip) is your main cost. Prefer letting positions RIDE TO RESOLUTION (minutes away) over closing early — resolution pays face value with no spread. Close early only to cut a clearly broken thesis.
- Size to survive being wrong: these are minutes-long trades, variance is high. Standard size 10-25% of your cash; up to 35% only with strong conviction. Never go all-in on one window.
- Sitting 100% in cash every cycle is a losing strategy in an arena — a rival who finds even a small edge compounds it fast on 5-minute markets. Trade when you see something, hold when you truly don't.`;

const DEFAULTS = {
  cycleSeconds: config.cycleSeconds,
  maxTradeUsd: config.maxTradeUsd,
  maxOpenPositions: config.maxOpenPositions,
  maxOpensPerCycle: 2,
  // 'single' = one-shot decision; 'plan-critique' = analyst plan then risk-desk
  // critique (two calls, better discipline, ~2x inference cost per decision).
  workflow: 'plan-critique',
  memory: { enabled: true, maxLessons: 8 },
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  // Optional per-agent persona appendix, keyed by agent id.
  agentNotes: {},
};

const clamp = (n, lo, hi, fallback) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};

function sanitize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  s.cycleSeconds = clamp(s.cycleSeconds, 120, 3600, DEFAULTS.cycleSeconds);
  s.maxTradeUsd = clamp(s.maxTradeUsd, 0.5, 500, DEFAULTS.maxTradeUsd);
  s.maxOpenPositions = Math.round(clamp(s.maxOpenPositions, 1, 12, DEFAULTS.maxOpenPositions));
  s.maxOpensPerCycle = Math.round(clamp(s.maxOpensPerCycle, 1, 4, DEFAULTS.maxOpensPerCycle));
  s.workflow = ['single', 'plan-critique'].includes(s.workflow) ? s.workflow : DEFAULTS.workflow;
  const mem = { ...DEFAULTS.memory, ...(s.memory || {}) };
  s.memory = {
    enabled: !!mem.enabled,
    maxLessons: Math.round(clamp(mem.maxLessons, 0, 20, DEFAULTS.memory.maxLessons)),
  };
  s.systemPrompt = String(s.systemPrompt || DEFAULTS.systemPrompt).slice(0, 8000);
  const notes = {};
  for (const [k, v] of Object.entries(s.agentNotes || {})) {
    if (typeof v === 'string' && v.trim()) notes[k] = v.slice(0, 2000);
  }
  s.agentNotes = notes;
  return s;
}

export function getStrategy() {
  return sanitize(kv.get('strategy.config'));
}

export function setStrategy(patch) {
  const next = sanitize({ ...(kv.get('strategy.config') || {}), ...(patch || {}) });
  kv.set('strategy.config', next);
  return next;
}

export function strategyDefaults() {
  return sanitize(null);
}
