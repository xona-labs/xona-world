import crypto from 'node:crypto';
import { config } from '../config.js';
import { kv } from '../db.js';

/**
 * OAuth 2.1 client for api.paybox.sh (World MCP).
 * Dynamic client registration + PKCE + refresh tokens. The one human step is
 * approving the authorize page (wallet consent) in a browser; everything else
 * is headless and survives restarts via the kv store.
 */

const KV_CLIENT = 'paybox.client';
const KV_TOKENS = 'paybox.tokens';
const KV_PENDING = 'paybox.pendingAuth';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function redirectUri() {
  return `${config.publicUrl}/oauth/callback`;
}

async function ensureClient() {
  let client = kv.get(KV_CLIENT);
  if (client && client.redirect_uri === redirectUri()) return client;
  const res = await fetch(`${config.paybox.issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'xona-world-arena',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp offline_access',
    }),
  });
  if (!res.ok) throw new Error(`paybox client registration failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  client = { client_id: data.client_id, redirect_uri: redirectUri() };
  kv.set(KV_CLIENT, client);
  return client;
}

/** Build the authorize URL the user opens to approve access (PKCE). */
export async function buildAuthorizeUrl() {
  const client = await ensureClient();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  kv.set(KV_PENDING, { verifier, state, created: Date.now() });

  const url = new URL(`${config.paybox.issuer}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', client.redirect_uri);
  url.searchParams.set('scope', 'mcp offline_access');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Handle the redirect back from paybox: exchange code for tokens. */
export async function handleCallback(code, state) {
  const pending = kv.get(KV_PENDING);
  if (!pending || pending.state !== state) throw new Error('OAuth state mismatch');
  const client = await ensureClient();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirect_uri,
    client_id: client.client_id,
    code_verifier: pending.verifier,
  });
  const res = await fetch(`${config.paybox.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = await res.json();
  storeTokens(tokens);
  kv.del(KV_PENDING);
  return true;
}

function storeTokens(tokens) {
  kv.set(KV_TOKENS, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || kv.get(KV_TOKENS)?.refresh_token || null,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
  });
}

export async function forceRefresh() {
  return refresh();
}

async function refresh() {
  const stored = kv.get(KV_TOKENS);
  if (!stored?.refresh_token) return null;
  const client = await ensureClient();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: client.client_id,
  });
  const res = await fetch(`${config.paybox.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    console.error('[paybox] token refresh failed:', res.status);
    return null;
  }
  const tokens = await res.json();
  storeTokens(tokens);
  return kv.get(KV_TOKENS);
}

/** Valid access token or null (never throws). Refreshes when near expiry. */
export async function getAccessToken() {
  let stored = kv.get(KV_TOKENS);
  if (!stored?.access_token) return null;
  if (stored.expires_at && Date.now() > stored.expires_at - 60_000) {
    stored = await refresh();
  }
  return stored?.access_token || null;
}

export function isConnected() {
  return !!kv.get(KV_TOKENS)?.access_token;
}

export function disconnect() {
  kv.del(KV_TOKENS);
}
