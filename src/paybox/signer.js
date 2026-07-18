import crypto from 'node:crypto';
import { kv } from '../db.js';
import { callToolJson } from './mcp.js';

/**
 * The "signing app", server-side. Paybox parks each live trade until a signing
 * window holding an Ed25519 agent key resolves the MoonX wallet binding and
 * posts app-signed envelopes; the MoonX MPC secret stays on paybox's side and
 * the server verifies every envelope against the plan it pinned at park time.
 * We ARE that signing window: one persistent agent keypair, held in kv.
 */

/**
 * The agent keypair comes from a paybox-issued signing key: `pbxk1.` +
 * base64url(JSON {p: <pub hex>, s: <priv hex>}) — copied from the paybox app
 * into PAYBOX_SIGNING_KEY. Paybox pre-registers the pubkey when it issues the
 * token, so only a pasted key (never a self-generated one) can sign.
 */
function loadKeypair() {
  const token = (process.env.PAYBOX_SIGNING_KEY || '').trim();
  if (!token) throw new Error('PAYBOX_SIGNING_KEY is not set (paste the pbxk1.… key from the paybox app)');
  const body = token.startsWith('pbxk1.') ? token.slice(6) : token;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('PAYBOX_SIGNING_KEY is not a valid pbxk1 token');
  }
  const apiPub = String(parsed.p ?? parsed.apiPubHex ?? '').toLowerCase().replace(/^0x/, '');
  let priv = String(parsed.s ?? parsed.apiPrivHex ?? '').toLowerCase().replace(/^0x/, '');
  if (!apiPub || !priv) throw new Error('pbxk1 token missing key material');
  if (priv.length === 128) priv = priv.slice(0, 64); // seed||pub form
  // Wrap the raw 32-byte seed in a PKCS#8 envelope for node:crypto.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(priv, 'hex'),
  ]);
  return {
    privateKey: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
    apiPub,
  };
}

export function signerReady() {
  try { loadKeypair(); return true; } catch { return false; }
}

function signEnvelope(privateKey, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const signature = crypto.sign(null, body, privateKey);
  return { signed_body: body.toString('hex'), agent_signature: signature.toString('hex') };
}

/**
 * Solana signing payload: the tx's message bytes, i.e. the serialized tx minus
 * its signature section (compact-u16 count + 64 bytes per slot), hex-encoded.
 */
function solanaMessageHex(tx) {
  if (tx.vm !== 'solana' || !tx.transaction) return null;
  const buf = Buffer.from(tx.transaction, 'base64');
  // compact-u16 shortvec: 7 bits per byte, high bit = continuation
  let count = 0, shift = 0, i = 0;
  for (;;) {
    const b = buf[i++];
    count |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return buf.subarray(i + count * 64).toString('hex');
}

/**
 * Resolve the MoonX binding once and cache it — resolving marks the request
 * as "being completed" (blocking its refresh), so the resolve must not run
 * per-request. The signing window keeps the same cache in memory.
 */
async function resolveBinding(requestId) {
  const cached = kv.get('paybox.moonxBinding');
  if (cached?.key_id) return cached;
  const { privateKey, apiPub } = loadKeypair();
  const { signed_body, agent_signature } = signEnvelope(privateKey, { issued_at: new Date().toISOString() });
  const res = await callToolJson('moonx_resolve_binding', {
    request_id: requestId,
    api_pub: apiPub,
    signed_body,
    agent_signature,
  });
  const key_id = res.key_id ?? res.keyId ?? res.binding?.key_id ?? res.binding?.keyId ?? null;
  const derivation_path = res.derivation_path ?? res.derivationPath ?? res.binding?.derivation_path ?? res.binding?.derivationPath ?? null;
  if (!key_id) throw new Error(`binding unresolved: ${JSON.stringify(res).slice(0, 300)}`);
  const binding = { key_id, derivation_path };
  kv.set('paybox.moonxBinding', binding);
  return binding;
}

/**
 * Complete a parked operation. `op` is the full response of the initiating
 * tool call (world_buy_outcome / world_change_position / world_redeem):
 * commit the geofence, refresh to get a freshly-parked plan, sign one
 * envelope per tx, and post them back. Mirrors the paybox signing window.
 */
// One signing flow at a time — parallel completions can trip each other's
// server-side locks.
let signingChain = Promise.resolve();

export function completeRequest(requestId, op) {
  const run = signingChain.then(async () => {
    try {
      return await completeOnce(requestId, op);
    } catch (err) {
      // The signing window re-runs the whole flow on transient failures; do
      // the same after letting any server-side quote/refresh lock expire.
      console.error(`[signer] first attempt failed (${err.message}), retrying in 20s`);
      await new Promise((r) => setTimeout(r, 20_000));
      return completeOnce(requestId, op);
    }
  });
  signingChain = run.catch(() => {});
  return run;
}

async function completeOnce(requestId, op) {
  const { privateKey, apiPub } = loadKeypair();
  if (!op?.refresh_url || !op?.refresh_token) throw new Error('operation has no refresh_url/refresh_token');

  if (!op.plan?.txs?.length) throw new Error('operation has no plan');

  // POST with the current token; on 401 token_expired renew once via
  // get_request and retry — the signing window's exact behavior.
  let bearer = op.refresh_token;
  const post = async (url) => {
    let res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });
    if (res.status === 401) {
      const rq = await callToolJson('get_request', { request_id: requestId });
      if (!rq?.refresh_token) throw new Error('refresh token expired and could not be renewed');
      bearer = rq.refresh_token;
      res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });
    }
    return res;
  };

  const tag = requestId.slice(0, 8);

  // 1. Refresh: re-quotes and parks fresh txs to sign. A 409 lock usually
  //    clears once the initial quote's freshness window lapses — back off and
  //    retry before falling back to the original plan.
  let txs = op.plan.txs;
  let refreshedOk = false;
  for (const delayMs of [0, 12_000, 20_000]) {
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    const r = await post(op.refresh_url);
    console.log(`[signer] ${tag} refresh: ${r.status}`);
    if (r.ok) {
      const refreshed = await r.json();
      if (refreshed?.plan?.txs?.length) { txs = refreshed.plan.txs; refreshedOk = true; }
      break;
    }
    if (r.status !== 409) throw new Error(`refresh failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
  if (!refreshedOk) console.log(`[signer] ${tag} refresh stayed locked; signing original plan`);

  // 2. Geofence commit (region check). 409 = already authoritative, fine.
  if (op.geofence_url) {
    const g = await post(op.geofence_url);
    console.log(`[signer] ${tag} geofence: ${g.status}`);
    if (!g.ok && g.status !== 409) {
      throw new Error(`geofence commit failed (${g.status}): ${(await g.text()).slice(0, 200)}`);
    }
  }

  // 3. Binding (cached after the one-time resolve).
  let { key_id, derivation_path } = op.plan.binding || {};
  if (!key_id) ({ key_id, derivation_path } = await resolveBinding(requestId));
  console.log(`[signer] ${tag} binding: key_id=${String(key_id).slice(0, 12)}… path=${derivation_path}`);
  console.log(`[signer] ${tag} signing ${txs.length} tx(s)`);

  // 4. One agent-signed envelope per parked tx, in plan order.
  const issued_at = new Date().toISOString();
  const envelopes = txs.map((tx) => {
    const raw_signing_payload =
      tx.raw_signing_payload ?? tx.sighash ?? tx.signing_payload ?? solanaMessageHex(tx);
    if (!raw_signing_payload) throw new Error(`tx missing signing payload: ${JSON.stringify(Object.keys(tx))}`);
    const { signed_body, agent_signature } = signEnvelope(privateKey, {
      raw_signing_payload, key_id, derivation_path, issued_at,
    });
    return { api_pub: apiPub, signed_body, agent_signature };
  });

  // 5. Same field the signing window uses.
  const result = await callToolJson('submit_envelopes', {
    request_id: requestId,
    envelopes_json: JSON.stringify(envelopes),
  });
  console.log(`[signer] ${requestId.slice(0, 8)} submit: ${JSON.stringify(result).slice(0, 200)}`);
  return result;
}
