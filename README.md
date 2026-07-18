<p align="center">
  <img src="public/xona-logo.jpg" height="72" alt="Xona" />
  &nbsp;&nbsp;&nbsp;
  <img src="public/world-logo.jpg" height="72" alt="World" />
</p>

<h1 align="center">Xona World — Autonomous Prediction-Market Arena</h1>

<p align="center">
  Three LLMs trade real prediction markets head-to-head, on-chain, by themselves.
  Same bankroll, same markets, same rules — only the model differs. Live PnL decides who's smartest.
</p>

---

## The contenders

| Agent | Model (via OpenRouter) | Vendor |
|---|---|---|
| **Kimi K3** | `moonshotai/kimi-k3` | Moonshot AI |
| **GPT-5.6 Sol** | `openai/gpt-5.6-sol` | OpenAI |
| **Grok 4.5** | `x-ai/grok-4.5` | xAI |

Each starts with an equal share of one shared Solana wallet and trades the **World**
prediction market (the fully on-chain market that runs inside Phantom) through the
[paybox](https://paybox.sh) MCP. Every buy settles on Solana; the dashboard streams
each decision, position, and equity tick live.

## How a trade actually works

It is **not** a single prompt. Every cycle (default 6 min) the engine runs this loop
per active model:

1. **Gather** — pull the live World market slate (rolling 5/15/60-min crypto up/down
   markets) and, for each, the recent implied-probability path from `world_market_prices`.
2. **Decide** — one OpenRouter call per model with the full portfolio + market slate +
   momentum context, returning strict-JSON actions (`open` / `close` / hold). The models
   compete: each prompt includes rivals' current equity.
3. **Resolve & mark** — settle expired positions, mark open ones to market, auto-redeem
   settled winners, and rebalance the treasury (convert idle World `CASH` back to USDC
   when the spendable balance runs low).
4. **Execute** — each `open` places a real `world_buy_outcome` order, sized as a % of
   that model's bankroll and capped for risk. The order *parks* at paybox.
5. **Sign** — the **signing cockpit** (see below) signs the parked order in-browser with
   the wallet's key; the fill settles on Solana. A position is only recorded once the
   on-chain fill confirms, so the ledger never diverges from the wallet.
6. **Snapshot** — equity per model is snapshotted and streamed to the dashboard over SSE.

So it's a **per-cycle, stateless single-shot decision** per model — no multi-step agent
loop, no long-term memory. Each cycle the model sees a fresh, complete picture
(portfolio, markets, momentum, rivals) and decides. State lives in the database and the
on-chain wallet, not in the model's context. See [Roadmap](#roadmap) for where memory
and multi-step reasoning could go.

## Architecture

```
src/
  config.js        env + the agent lineup
  engine.js        the arena loop (gather → decide → execute → sign → snapshot)
  llm.js           OpenRouter JSON-mode caller
  venues/
    world.js       World market data + order placement via paybox MCP
    paper.js       Limitless public data (fallback / paper venue)
  paybox/
    oauth.js       OAuth 2.1 (dynamic registration + PKCE + refresh)
    mcp.js         MCP streamable-HTTP client
    live.js        on-chain buys, redemptions, treasury rebalancing, deposits
    signer.js      envelope construction for the signing app
  cockpit.html     the in-browser signing cockpit
  api.js           REST + SSE + static dashboard
scripts/
  cockpit-headless.js   runs the cockpit in headless Chrome (24/7 signing)
web/               React dashboard (Vite + lightweight-charts)
```

## Run it locally

```bash
npm install && npm --prefix web install
cp .env.example .env          # fill in the values below
npm run web:build

npm start                     # engine + API + dashboard on :4587
npm run cockpit               # headless signing cockpit (keep running)
```

Dashboard: **http://localhost:4587**. For frontend hot-reload during development,
`npm run web:dev` serves on `:5183` and proxies the API.

### Required `.env`

| Key | What it is |
|---|---|
| `OPENROUTER_API_KEY` | For the model calls. Without it the arena runs but agents stay idle. |
| `PAYBOX_SIGNING_KEY` | The `pbxk1.…` signing key from the paybox app ("Generate signing key"). |
| `COCKPIT_TOKEN` | Required on any public deploy — gates the cockpit endpoints. |
| `LIVE_TRADING` | `1` for real on-chain trades, `0` for market-data-only. |

Connecting the wallet is a one-time browser step: open the dashboard, click
**World MCP → connect**, and approve in paybox. Tokens persist in the local SQLite DB.

## The signing cockpit

Paybox binds each trade to a **browser signing session** — a headless server can't sign
on its own. The cockpit hosts paybox's own signing app in an iframe and bridges its
protocol to the engine's session, so parked trades sign automatically. Run it as a
visible tab (`/cockpit`) or headless (`npm run cockpit`); keep it running for live
trading. On a laptop, `caffeinate -dims npm run cockpit` prevents sleep.

## Deploying to a server

> **Region matters.** Paybox geofences trades. Blocked regions include US, UK, DE, FR,
> NL, SG, JP, AU and others. Use a VPS in a non-blocked region (e.g. India/Bangalore,
> Indonesia, Canada/Toronto), or every trade fails a region check.

```bash
git clone <repo> && cd xona-world
npm install && npm --prefix web install && npm run web:build
# copy your .env AND xona-world.db (carries wallet OAuth + binding — no re-consent)
pm2 start "npm start"       --name xona-world-engine
pm2 start "npm run cockpit" --name xona-world-cockpit
```

## Controls

The dashboard lets you **pause/resume** any model and **reallocate** the whole bankroll
into one model (PnL-preserving), and **fund** the shared wallet (copy the Solana address
for a direct USDC transfer, or buy via card through MoonPay). Deposits auto-split evenly
across the active models on the next cycle.

## Roadmap

- Per-model long-term memory (lessons from past resolutions carried into the prompt)
- Multi-step reasoning / tool-use loops instead of single-shot decisions
- Copy-trading: let others mirror a model's positions for a performance fee

## ⚠️ Disclaimer

This software places **real cryptocurrency trades with real money** on prediction
markets. It is experimental, provided **as-is with no warranty**, and can lose funds —
prediction-market spreads alone are a steady drag, and LLM trading has no guaranteed
edge. Nothing here is financial advice. You are solely responsible for any funds you put
into the wallet. Only use funds you can afford to lose. Check that prediction-market
trading is legal in your jurisdiction before running it.

## License

[MIT](LICENSE) © Xona Labs
