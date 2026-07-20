import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (KEY=VALUE lines; no expansion). process.env wins.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

export const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '4587', 10),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4587}`,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'xona-world.db'),

  // Trading loop
  // 'fast' = only the rolling 5/15/60-min crypto markets; 'mixed' = everything.
  slateMode: process.env.SLATE_MODE || 'fast',
  cycleSeconds: parseInt(process.env.TRADE_CYCLE_SECONDS || '180', 10),
  startingBankroll: parseFloat(process.env.STARTING_BANKROLL || '1000'),
  maxTradeUsd: parseFloat(process.env.MAX_TRADE_USD || '150'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '6', 10),

  // LLM — OpenAI-compatible inference (Xona by default; any /v1 endpoint works).
  // INFERENCE_* is preferred; OPENROUTER_* kept as a fallback for older setups.
  inference: {
    baseUrl: (process.env.INFERENCE_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://api.xona-agent.com/v1').replace(/\/$/, ''),
    apiKey: process.env.INFERENCE_API_KEY || process.env.OPENROUTER_API_KEY || '',
  },

  // Market data (paper venue)
  limitlessApi: (process.env.LIMITLESS_API_URL || 'https://api.limitless.exchange').replace(/\/$/, ''),

  // Paybox / World MCP. The bare /mcp endpoint matches the token audience the
  // OAuth flow issues (the ?app=world variant wants a different resource aud).
  paybox: {
    mcpUrl: process.env.PAYBOX_MCP_URL || 'https://api.paybox.sh/mcp',
    issuer: process.env.PAYBOX_ISSUER || 'https://api.paybox.sh',
  },

  // Live on-chain mirroring: each agent "open" also buys the real outcome token
  // from the paybox-granted Solana wallet, at a fixed small size.
  live: {
    enabled: process.env.LIVE_TRADING !== '0',
    tradeUsd: parseFloat(process.env.LIVE_TRADE_USD || '0.5'),
    minWalletUsd: parseFloat(process.env.LIVE_MIN_WALLET_USD || '0.3'),
    slippageBps: parseInt(process.env.LIVE_SLIPPAGE_BPS || '100', 10),
  },
};

// The contenders. Same prompt, same bankroll, same markets — only the model differs.
// Monochrome UI: identity = lightness step + dash pattern (never color alone).
export const AGENTS = [
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    vendor: 'Moonshot AI',
    model: 'kimi-k3',
    color: '#f5f5f5',
    dash: 'solid',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    model: 'gpt-5.6-sol',
    color: '#b0b0b0',
    dash: 'dashed',
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    vendor: 'xAI',
    model: 'grok-4.5',
    color: '#6f6f6f',
    dash: 'dotted',
  },
];
