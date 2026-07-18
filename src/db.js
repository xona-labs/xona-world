import Database from 'better-sqlite3';
import { config, AGENTS } from './config.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  color TEXT NOT NULL,
  starting_bankroll REAL NOT NULL,
  cash REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  market_title TEXT NOT NULL,
  side TEXT NOT NULL,               -- yes | no
  shares REAL NOT NULL,
  entry_price REAL NOT NULL,
  cost REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed | resolved
  current_price REAL,
  exit_price REAL,
  proceeds REAL,
  pnl REAL,
  close_reason TEXT,
  expiration INTEGER,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_positions_agent_status ON positions(agent_id, status);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  position_id INTEGER,
  action TEXT NOT NULL,             -- open | close | resolve
  market_title TEXT NOT NULL,
  side TEXT NOT NULL,
  shares REAL NOT NULL,
  price REAL NOT NULL,
  usd REAL NOT NULL,
  pnl REAL,
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  summary TEXT,
  commentary TEXT,
  raw TEXT,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  positions_value REAL NOT NULL,
  PRIMARY KEY (agent_id, ts)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS live_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- buy | redeem
  market_slug TEXT,
  market_title TEXT,
  side TEXT,
  mint TEXT,
  usd REAL,
  request_id TEXT,
  status TEXT,                      -- pending_* | success | denied | error
  raw TEXT
);
`);

// Migrations for columns added after the initial schema.
const positionCols = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
if (!positionCols.includes('venue')) {
  db.exec("ALTER TABLE positions ADD COLUMN venue TEXT NOT NULL DEFAULT 'limitless'");
}
const agentCols = db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
if (!agentCols.includes('paused')) {
  db.exec('ALTER TABLE agents ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
}

// Seed agents (idempotent; never resets an existing agent's cash).
const insertAgent = db.prepare(`
  INSERT OR IGNORE INTO agents (id, label, vendor, model, color, starting_bankroll, cash)
  VALUES (@id, @label, @vendor, @model, @color, @bankroll, @bankroll)
`);
for (const a of AGENTS) {
  insertAgent.run({ ...a, bankroll: config.startingBankroll });
}
// Keep display fields in sync with the config lineup (cash is never touched).
const syncAgent = db.prepare('UPDATE agents SET label=@label, vendor=@vendor, model=@model, color=@color WHERE id=@id');
for (const a of AGENTS) syncAgent.run(a);

export const kv = {
  get(k) {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? JSON.parse(row.v) : null;
  },
  set(k, v) {
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, JSON.stringify(v));
  },
  del(k) {
    db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  },
};
