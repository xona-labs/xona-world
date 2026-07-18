import { config } from '../config.js';
import { kv } from '../db.js';
import { getAccessToken, forceRefresh } from './oauth.js';

/**
 * Minimal MCP client (streamable HTTP) for the paybox World server.
 * Handles initialize / tools list / tools call over JSON or SSE responses,
 * and keeps the Mcp-Session-Id header across calls.
 */

let sessionId = null;
let initialized = false;
let nextId = 1;

async function rpc(method, params, opts = {}) {
  try {
    return await rpcOnce(method, params, opts);
  } catch (err) {
    // One forced refresh + retry on a rejected token (access tokens are short-lived).
    if (String(err.message).includes('401')) {
      const refreshed = await forceRefresh();
      if (refreshed) return rpcOnce(method, params, opts);
    }
    throw err;
  }
}

async function rpcOnce(method, params, { notify = false } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('paybox not connected');

  const payload = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const res = await fetch(config.paybox.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (res.status === 401) {
    initialized = false;
    throw new Error('paybox 401 (token rejected)');
  }
  if (res.status === 202 || notify) return null;
  if (!res.ok) throw new Error(`paybox MCP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream')) {
    const text = await res.text();
    for (const chunk of text.split('\n\n')) {
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === payload.id) return unwrap(msg);
      } catch {}
    }
    throw new Error('paybox MCP: no matching SSE response');
  }
  return unwrap(await res.json());
}

function unwrap(msg) {
  if (msg.error) throw new Error(`paybox MCP error ${msg.error.code}: ${msg.error.message}`);
  return msg.result;
}

async function ensureInitialized() {
  if (initialized) return;
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'xona-world-arena', version: '0.1.0' },
  });
  await rpc('notifications/initialized', {}, { notify: true });
  initialized = true;
}

/** List the World MCP tools; cached in kv for the dashboard + venue mapping. */
export async function listTools({ force = false } = {}) {
  const cached = kv.get('paybox.tools');
  if (cached && !force) return cached;
  await ensureInitialized();
  const result = await rpc('tools/list', {});
  const tools = (result?.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || null,
  }));
  kv.set('paybox.tools', tools);
  return tools;
}

/** Call a World MCP tool by name. */
export async function callTool(name, args) {
  await ensureInitialized();
  return rpc('tools/call', { name, arguments: args || {} });
}

/** Call a tool and parse its JSON payload (structuredContent or text content). */
export async function callToolJson(name, args) {
  const result = await callTool(name, args);
  if (result?.isError) {
    const msg = result?.content?.[0]?.text || 'unknown tool error';
    throw new Error(`${name} failed: ${String(msg).slice(0, 300)}`);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`${name}: empty tool result`);
  return JSON.parse(text);
}

export function cachedTools() {
  return kv.get('paybox.tools') || null;
}

/** Read an MCP resource (e.g. the wallet-sign app HTML). Cached in kv. */
export async function readResource(uri, { force = false } = {}) {
  const cacheKey = `paybox.resource.${uri}`;
  const cached = kv.get(cacheKey);
  if (cached && !force) return cached;
  await ensureInitialized();
  const result = await rpc('resources/read', { uri });
  const text = result?.contents?.[0]?.text || '';
  if (text) kv.set(cacheKey, text);
  return text;
}

/** Call a tool and return the RAW MCP result (content array etc.). */
export async function callToolRaw(name, args) {
  await ensureInitialized();
  return rpc('tools/call', { name, arguments: args || {} });
}

export function resetSession() {
  sessionId = null;
  initialized = false;
}
