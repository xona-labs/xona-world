import { config } from '../config.js';

/**
 * Paper venue backed by Limitless Exchange public market data.
 * Real markets, real prices, simulated fills — the training ground until the
 * paybox World MCP connection is authorized and the live venue takes over.
 *
 * Price convention: prices are in [0, 1] USD per share; a winning share pays $1.
 * sideIndex: yes = 0, no = 1 (matches Limitless `prices` array).
 */

export const name = 'limitless';

const SIDE_INDEX = { yes: 0, no: 1 };

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Limitless ${res.status} for ${url}`);
  return res.json();
}

function simplify(m) {
  const minsToExpiry = m.expirationTimestamp
    ? Math.round((m.expirationTimestamp - Date.now()) / 60_000)
    : null;
  return {
    slug: m.slug,
    title: m.title,
    categories: m.categories || [],
    prices: m.prices || null,                  // [yes, no] mid prices
    buy: m.tradePrices?.buy?.market || null,   // [yes, no] taker buy prices
    sell: m.tradePrices?.sell?.market || null, // [yes, no] taker sell prices
    volume: Number(m.volumeFormatted || 0),
    expiration: m.expirationTimestamp || null,
    minsToExpiry,
    expired: !!m.expired,
    winningOutcomeIndex: m.winningOutcomeIndex ?? null,
  };
}

function tradeable(m) {
  return (
    m.tradeType === 'clob' &&
    !m.expired &&
    !m.hidden &&
    m.status === 'FUNDED' &&
    Array.isArray(m.prices) &&
    m.prices.length === 2 &&
    m.expirationTimestamp &&
    m.expirationTimestamp > Date.now() + 90_000 // skip markets about to lock
  );
}

/**
 * A curated slate: fast crypto up/down markets (they resolve in minutes and
 * keep the arena moving) plus the highest-volume longer markets for variety.
 */
export async function fetchSlate() {
  // The API caps limit at 25; page through the first few pages.
  const pages = await Promise.all(
    [1, 2, 3, 4].map((page) =>
      getJson(`${config.limitlessApi}/markets/active?limit=25&page=${page}`).catch(() => ({ data: [] })),
    ),
  );
  const all = pages.flatMap((p) => p.data || []).filter(tradeable);

  const isFast = (m) => (m.categories || []).some((c) => /min|hourly/i.test(String(c)));
  const fast = all.filter(isFast).sort((a, b) => a.expirationTimestamp - b.expirationTimestamp);
  const slow = all
    .filter((m) => !isFast(m))
    .sort((a, b) => Number(b.volumeFormatted || 0) - Number(a.volumeFormatted || 0));

  const slate = [...fast.slice(0, 8), ...slow.slice(0, 8)];
  return slate.map(simplify);
}

/** Fetch a single market (used to price/resolve positions off the slate). */
export async function fetchMarket(slug) {
  const m = await getJson(`${config.limitlessApi}/markets/${encodeURIComponent(slug)}`);
  return simplify(m);
}

/** Simulated taker buy. Returns the fill or null if the market isn't priceable. */
export function paperBuy(market, side, usd) {
  const idx = SIDE_INDEX[side];
  // An empty orderbook reports 0 — fall back to the mid price in that case.
  const price = market.buy?.[idx] || market.prices?.[idx];
  if (!price || price <= 0 || price >= 1) return null;
  return { price, shares: usd / price };
}

/** Simulated taker sell of an open position at current prices. */
export function paperSellPrice(market, side) {
  const idx = SIDE_INDEX[side];
  const price = market.sell?.[idx] || market.prices?.[idx];
  if (!price || price <= 0) return null;
  return price;
}

/** Mid-price used for mark-to-market. */
export function markPrice(market, side) {
  const idx = SIDE_INDEX[side];
  return market.prices?.[idx] ?? null;
}

/** For a resolved market: what one share of `side` pays out. */
export function resolutionPayout(market, side) {
  if (market.winningOutcomeIndex == null) return null;
  return market.winningOutcomeIndex === SIDE_INDEX[side] ? 1 : 0;
}
