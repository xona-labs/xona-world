import { config } from '../config.js';
import { db, kv } from '../db.js';
import { callToolJson } from './mcp.js';
import { signerReady } from './signer.js';

/**
 * Real on-chain execution on World via the paybox-granted Solana wallet.
 * Mirrors agent decisions at a fixed small size (config.live.tradeUsd):
 *   buy  -> world_buy_outcome (autonomous signing per the user's paybox policy)
 *   then -> poll get_request until success / denied / error
 *   later-> redeemSweep() recovers USDC from settled winning positions.
 */

const USDC_DECIMALS = 6;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// World converts deposited USDC into this internal $1-pegged collateral token
// the moment you trade; spendable balance = USDC + CASH.
const WORLD_CASH_MINT = 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH';

const insertLive = db.prepare(`
  INSERT INTO live_trades (ts, agent_id, action, market_slug, market_title, side, mint, usd, request_id, status, raw)
  VALUES (@ts, @agent_id, @action, @market_slug, @market_title, @side, @mint, @usd, @request_id, @status, @raw)
`);
// Status-only update: `raw` keeps the original operation response (the plan
// with the parked txs) — far more valuable than the last poll body.
const updateLive = db.prepare('UPDATE live_trades SET status = ? WHERE id = ?');

/** The granted wallet credential (cached). */
export async function getWallet() {
  let w = kv.get('paybox.wallet');
  if (w) return w;
  const res = await callToolJson('list_credentials', {});
  const cred = (res.credentials || []).find(
    (c) => c.kind === 'wallet' && (c.metadata?.chains || []).includes('solana'),
  );
  if (!cred) return null;
  w = { credentialId: cred.credential_id, address: cred.metadata.address, name: cred.name, approvalMode: cred.approval_mode };
  kv.set('paybox.wallet', w);
  return w;
}

/** Spendable wallet balance in USD (USDC + World CASH). Cached for the UI. */
export async function refreshBalance() {
  const wallet = await getWallet();
  if (!wallet) return null;
  const res = await callToolJson('get_portfolio', { address: wallet.address });
  const items = res.items || [];
  const usdOf = (mint) => {
    const it = items.find((i) => i.tokenAddress === mint);
    return it ? Number(it.shiftedBalance ?? it.balanceUsd ?? 0) : 0;
  };
  const usdc = usdOf(USDC_MINT);
  const cash = usdOf(WORLD_CASH_MINT);
  const balance = usdc + cash;
  kv.set('paybox.walletBalance', { usd: balance, usdc, cash, ts: Date.now() });
  return balance;
}

export function cachedBalance() {
  return kv.get('paybox.walletBalance');
}

export function cachedWallet() {
  const w = kv.get('paybox.wallet');
  return w ? { address: w.address, name: w.name, chain: 'solana' } : null;
}

/** MoonPay checkout URL that deposits USDC into the granted wallet. */
export async function buyLink(amountUsd) {
  const wallet = await getWallet();
  if (!wallet) throw new Error('wallet not available');
  const res = await callToolJson('get_buy_link', {
    credential_id: wallet.credentialId,
    currency_code: 'usdc_sol',
    ...(amountUsd ? { amount_usd: amountUsd } : {}),
  });
  const url = res.url || res.link || res.checkout_url || res.buy_link;
  if (!url) throw new Error(`no buy link in response: ${JSON.stringify(res).slice(0, 200)}`);
  return { url, address: wallet.address };
}

function requestIdOf(res) {
  return res?.request_id || res?.requestId || res?.request?.request_id || null;
}
function statusOf(res) {
  return res?.status || res?.request?.status || null;
}

async function pollRequest(requestId, { timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await callToolJson('get_request', { request_id: requestId });
    const status = statusOf(last);
    if (['success', 'denied', 'error'].includes(status)) return { status, raw: last };
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { status: statusOf(last) || 'pending_timeout', raw: last };
}

/**
 * Wait for a parked request to reach a terminal state. The signing itself is
 * done by the cockpit (the browser signing window) — the engine must NOT also
 * sign, or the two race for paybox's per-request lock and both fail. So we only
 * poll here, bounded so a stuck fill can't stall the trading cycle.
 */
async function settle(requestId, op, status, rowId) {
  if (requestId && !['success', 'denied', 'error'].includes(status)) {
    const polled = await pollRequest(requestId);
    status = polled.status;
    updateLive.run(status, rowId);
  }
  return status;
}

/**
 * One real buy, ledger-sized. Never throws; returns {status, shares, price…}.
 * The caller only records a position when status === 'success'.
 */
export async function liveBuy({ agentId, market, side, usd }) {
  if (!config.live.enabled) return null;
  if (!signerReady()) return { agentId, side, market: market.title, usd, status: 'no_signer' };
  try {
    const wallet = await getWallet();
    if (!wallet) return null;
    const mint = side === 'yes' ? market.yesMint : market.noMint;
    if (!mint) return null;

    const size = String(Math.round(usd * 10 ** USDC_DECIMALS));
    const res = await callToolJson('world_buy_outcome', {
      credential_id: wallet.credentialId,
      market_mint: mint,
      size,
      slippage_bps: config.live.slippageBps,
      value_cents: Math.round(usd * 100),
    });
    const requestId = requestIdOf(res);
    let status = statusOf(res) || 'submitted';

    const rowId = insertLive.run({
      ts: Date.now(), agent_id: agentId, action: 'buy',
      market_slug: market.slug, market_title: market.title, side, mint,
      usd, request_id: requestId, status, raw: JSON.stringify(res).slice(0, 60_000),
    }).lastInsertRowid;

    status = await settle(requestId, res, status, rowId);
    refreshBalance().catch(() => {});

    const outAmount = res.plan?.quote?.out_amount;
    const shares = outAmount ? Number(outAmount) / 10 ** USDC_DECIMALS : null;
    return {
      agentId, side, market: market.title, usd, status, requestId,
      shares, price: shares ? usd / shares : null,
    };
  } catch (err) {
    console.error('[live] buy failed:', err.message);
    insertLive.run({
      ts: Date.now(), agent_id: agentId, action: 'buy',
      market_slug: market?.slug || null, market_title: market?.title || null, side, mint: null,
      usd, request_id: null, status: 'error', raw: String(err.message).slice(0, 500),
    });
    return { agentId, side, market: market?.title, usd, status: 'error' };
  }
}

/** Sell (reduce) a real position: size is in outcome tokens. Never throws. */
export async function liveSell({ agentId, market, side, shares }) {
  if (!config.live.enabled) return null;
  try {
    const wallet = await getWallet();
    if (!wallet) return null;
    const mint = side === 'yes' ? market.yesMint : market.noMint;
    if (!mint) return null;
    const size = String(Math.round(shares * 10 ** USDC_DECIMALS));
    const res = await callToolJson('world_change_position', {
      credential_id: wallet.credentialId,
      market_mint: mint,
      side: 'sell',
      size,
      slippage_bps: config.live.slippageBps,
    });
    const requestId = requestIdOf(res);
    let status = statusOf(res) || 'submitted';
    const rowId = insertLive.run({
      ts: Date.now(), agent_id: agentId, action: 'sell',
      market_slug: market.slug, market_title: market.title, side, mint,
      usd: null, request_id: requestId, status, raw: JSON.stringify(res).slice(0, 60_000),
    }).lastInsertRowid;
    status = await settle(requestId, res, status, rowId);
    refreshBalance().catch(() => {});
    return { agentId, side, market: market.title, status, requestId };
  } catch (err) {
    console.error('[live] sell failed:', err.message);
    return { agentId, side, market: market?.title, status: 'error' };
  }
}

/**
 * Buys draw USDC while redemptions pay out in World CASH, so USDC drains as
 * the wallet wins. When it runs low, convert idle CASH back to USDC via a
 * paybox swap (parks like any trade; the cockpit signs it). Never throws.
 */
const USDC_LOW_WATER = 5;    // trigger a top-up below this
const CASH_KEEP = 1;         // dust to leave behind
const SWAP_MAX_USD = 20;     // convert at most this much per cycle
let converting = false;

export async function ensureUsdc() {
  if (!config.live.enabled || converting) return null;
  converting = true;
  try {
    const bal = cachedBalance() ?? {};
    if ((bal.usdc ?? 0) >= USDC_LOW_WATER) return null;
    const cash = bal.cash ?? 0;
    const amountUsd = Math.min(cash - CASH_KEEP, SWAP_MAX_USD);
    if (amountUsd < 2) return null;
    const wallet = await getWallet();
    if (!wallet) return null;

    const res = await callToolJson('request_swap', {
      credential_id: wallet.credentialId,
      src_chain: 'solana:mainnet',
      src_token: WORLD_CASH_MINT,
      dst_token: USDC_MINT,
      amount: String(Math.round(amountUsd * 10 ** USDC_DECIMALS)),
      slippage_bps: 100,
      value_cents: Math.round(amountUsd * 100),
    });
    const requestId = requestIdOf(res);
    let status = statusOf(res) || 'submitted';
    const rowId = insertLive.run({
      ts: Date.now(), agent_id: 'system', action: 'swap',
      market_slug: null, market_title: `CASH → USDC $${amountUsd.toFixed(2)}`, side: null, mint: WORLD_CASH_MINT,
      usd: amountUsd, request_id: requestId, status, raw: JSON.stringify(res).slice(0, 60_000),
    }).lastInsertRowid;
    console.log(`[live] USDC low ($${(bal.usdc ?? 0).toFixed(2)}) — converting $${amountUsd.toFixed(2)} CASH → USDC (${requestId})`);
    status = await settle(requestId, res, status, rowId);
    refreshBalance().catch(() => {});
    return { amountUsd, status };
  } catch (err) {
    console.error('[live] CASH->USDC conversion failed:', err.message);
    return null;
  } finally {
    converting = false;
  }
}

/**
 * Redeem every settled World position the wallet holds (recovers USDC from
 * winners; losers redeem to zero and just clean up). Never throws.
 */
let sweeping = false;
export async function redeemSweep() {
  if (!config.live.enabled || sweeping) return [];
  sweeping = true;
  try {
    return await redeemSweepInner();
  } finally {
    sweeping = false;
  }
}

async function redeemSweepInner() {
  const out = [];
  try {
    const wallet = await getWallet();
    if (!wallet) return out;
    const res = await callToolJson('world_positions', { address: wallet.address });
    const settled = res.settled || [];
    for (const pos of settled) {
      const mint = pos.tokenAddress || pos.mint;
      const amount = pos.balance || pos.amount || pos.size;
      if (!mint || !amount || Number(amount) <= 0) continue;
      try {
        const r = await callToolJson('world_redeem', {
          credential_id: wallet.credentialId,
          market_mint: mint,
          size: String(amount),
        });
        const requestId = requestIdOf(r);
        let status = statusOf(r) || 'submitted';
        const rowId = insertLive.run({
          ts: Date.now(), agent_id: 'system', action: 'redeem',
          market_slug: null, market_title: pos.title || pos.marketTicker || null, side: null, mint,
          usd: null, request_id: requestId, status, raw: JSON.stringify(r).slice(0, 60_000),
        }).lastInsertRowid;
        status = await settle(requestId, r, status, rowId);
        out.push({ mint, status });
      } catch (err) {
        console.error('[live] redeem failed:', err.message);
      }
    }
    if (settled.length) refreshBalance().catch(() => {});
  } catch (err) {
    console.error('[live] redeem sweep failed:', err.message);
  }
  return out;
}
