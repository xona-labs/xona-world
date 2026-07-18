import { config } from '../config.js';
import { kv } from '../db.js';
import { callToolJson } from '../paybox/mcp.js';

// Rolling short-horizon crypto series: WXBTC5M-…, WXETH15M-…, WXSOL60M-…
const FAST_RE = /^WX[A-Z]+(5|15|60)M-/;

/**
 * World prediction market (world.xyz, the venue inside Phantom) via the paybox
 * MCP. Read-only market data with paper fills for now; the same tool family
 * (`world_buy_outcome` / `world_change_position` / `world_redeem`) executes for
 * real from a granted Solana wallet when live trading is switched on.
 *
 * Normalized to the shared venue shape: prices/buy/sell are [yes, no] arrays
 * in USD per $1-payout share; slug = World market ticker.
 */

export const name = 'world';

const SIDE_INDEX = { yes: 0, no: 1 };
const KV_EVENT_MAP = 'world.eventByTicker';

function num(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function questionOf(m) {
  const q = m.rulesPrimary?.tokens?.question?.value;
  if (q) return q.replace(/^Will /, '').replace(/\?$/, '');
  return m.subtitle ? `${m.title} — ${m.subtitle}` : m.title;
}

function simplify(m) {
  const yesAsk = num(m.yesAsk), yesBid = num(m.yesBid);
  const noAsk = num(m.noAsk), noBid = num(m.noBid);
  const mid = (bid, ask) => (bid && ask ? (bid + ask) / 2 : ask || bid || null);
  const expiration = m.closeTime ? m.closeTime * 1000 : null;
  let winningOutcomeIndex = null;
  if (['determined', 'finalized', 'settled'].includes(m.status)) {
    if (m.result === 'yes') winningOutcomeIndex = 0;
    else if (m.result === 'no') winningOutcomeIndex = 1;
  }
  return {
    slug: m.ticker,
    title: questionOf(m),
    eventTicker: m.eventTicker,
    categories: [],
    prices: [mid(yesBid, yesAsk), mid(noBid, noAsk)],
    buy: [yesAsk, noAsk],
    sell: [yesBid, noBid],
    volume: (Number(m.volume) || 0) / 1e6,
    trades24h: m.trades24h || 0,
    expiration,
    minsToExpiry: expiration ? Math.round((expiration - Date.now()) / 60_000) : null,
    expired: expiration ? expiration <= Date.now() : false,
    status: m.status,
    winningOutcomeIndex,
    yesMint: m.accounts ? Object.values(m.accounts)[0]?.yesMint : null,
    noMint: m.accounts ? Object.values(m.accounts)[0]?.noMint : null,
  };
}

function rememberEvents(markets) {
  const map = kv.get(KV_EVENT_MAP) || {};
  let dirty = false;
  for (const m of markets) {
    if (m.slug && m.eventTicker && map[m.slug] !== m.eventTicker) {
      map[m.slug] = m.eventTicker;
      dirty = true;
    }
  }
  if (dirty) kv.set(KV_EVENT_MAP, map);
}

function sane(m, minLeftMs) {
  if (m.status !== 'active') return false;
  if (!m.buy[0] || !m.buy[1] || m.buy[0] <= 0.01 || m.buy[0] >= 0.99) return false;
  if (m.expiration && m.expiration <= Date.now() + minLeftMs) return false;
  return true;
}

// Wide quotes (e.g. HYPE's 0.11 bid / 0.97 ask) are spread traps — skip them.
function tightSpread(m) {
  const spread = (side) => (m.buy[side] && m.sell[side] ? m.buy[side] - m.sell[side] : 1);
  return spread(0) < 0.08 && spread(1) < 0.08;
}

async function fetchActiveMarkets() {
  const collected = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const res = await callToolJson('world_find_markets', {
      status: 'active',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const rows = res.markets || [];
    collected.push(...rows.map(simplify));
    cursor = res.cursor;
    if (!cursor || rows.length === 0) break;
  }
  rememberEvents(collected);
  return collected;
}

/**
 * Attach the recent implied-probability path (YES mid, one point per minute)
 * — the only live momentum signal a model has on a short-horizon market.
 */
async function attachMomentum(markets) {
  const end = Math.floor(Date.now() / 1000);
  await Promise.all(markets.map(async (m) => {
    try {
      const res = await callToolJson('world_market_prices', {
        ticker: m.slug, start_ts: end - 1800, end_ts: end, resolution: 60,
      });
      const yes = (res.yes || []).slice(-10);
      const mids = yes
        .map((p) => (p.bid && p.ask ? (p.bid + p.ask) / 2 : p.ask || p.bid))
        .filter((x) => x != null)
        .map((x) => x.toFixed(2));
      if (mids.length >= 2) m.yesTrend = mids.join(' → ');
    } catch { /* momentum is optional */ }
  }));
}

/** Slate. Fast mode: only the rolling 5/15/60-min crypto markets. */
export async function fetchSlate() {
  const collected = await fetchActiveMarkets();

  if (config.slateMode === 'fast') {
    const fast = collected
      .filter((m) => FAST_RE.test(m.slug))
      .filter((m) => sane(m, 2.5 * 60_000) && tightSpread(m))
      .sort((a, b) => a.expiration - b.expiration);
    await attachMomentum(fast);
    return fast;
  }

  const all = collected.filter((m) => sane(m, 5 * 60_000));
  // Prefer markets with real activity, then mix in the soonest-closing ones.
  const byVolume = [...all].sort((a, b) => b.volume - a.volume);
  const bySoonest = [...all]
    .filter((m) => m.expiration)
    .sort((a, b) => a.expiration - b.expiration);

  const slate = [];
  const seen = new Set();
  for (const m of [...byVolume.slice(0, 12), ...bySoonest.slice(0, 8)]) {
    if (!seen.has(m.slug)) { seen.add(m.slug); slate.push(m); }
    if (slate.length >= 16) break;
  }
  return slate;
}

/** Fetch one market by ticker (for marking/resolving off-slate positions). */
export async function fetchMarket(ticker) {
  const map = kv.get(KV_EVENT_MAP) || {};
  // Fallback: World tickers are EVENT-SUFFIX, e.g. WXNBAMOVE-26LJAM-GSW.
  const eventTicker = map[ticker] || ticker.split('-').slice(0, -1).join('-');
  const res = await callToolJson('world_get_market', {
    event_ticker: eventTicker,
    with_nested_markets: true,
  });
  const markets = res.markets || res.event?.markets || [];
  const m = markets.find((x) => x.ticker === ticker);
  if (!m) throw new Error(`world market ${ticker} not found under ${eventTicker}`);
  const s = simplify(m);
  rememberEvents([s]);
  return s;
}

/** Simulated taker buy at the ask. */
export function paperBuy(market, side, usd) {
  const idx = SIDE_INDEX[side];
  const price = market.buy?.[idx] || market.prices?.[idx];
  if (!price || price <= 0 || price >= 1) return null;
  return { price, shares: usd / price };
}

/** Simulated taker sell at the bid. */
export function paperSellPrice(market, side) {
  const idx = SIDE_INDEX[side];
  const price = market.sell?.[idx] || market.prices?.[idx];
  if (!price || price <= 0) return null;
  return price;
}

/** Mid-price mark. */
export function markPrice(market, side) {
  return market.prices?.[SIDE_INDEX[side]] ?? null;
}

/** $ payout per share once resolved, else null. */
export function resolutionPayout(market, side) {
  if (market.winningOutcomeIndex == null) return null;
  return market.winningOutcomeIndex === SIDE_INDEX[side] ? 1 : 0;
}
