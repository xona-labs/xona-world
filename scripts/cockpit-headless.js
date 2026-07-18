#!/usr/bin/env node
/**
 * Headless signing cockpit: keeps /cockpit open in headless Chrome so parked
 * trades sign 24/7 without a human browser tab. Run next to the engine:
 *   node scripts/cockpit-headless.js
 * Env: COCKPIT_URL (default http://localhost:4587/cockpit), COCKPIT_TOKEN.
 */
import puppeteer from 'puppeteer';

const base = process.env.COCKPIT_URL || 'http://localhost:4587/cockpit';
const token = process.env.COCKPIT_TOKEN || '';
const url = token ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : base;

const FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // Signing must never be throttled the way background tabs are.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: FLAGS });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`[cockpit-page] ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[cockpit-page] pageerror: ${err.message}`));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  console.log(`[cockpit-headless] open: ${base}`);

  // Watchdog: reload if the page stops updating its heartbeat.
  setInterval(async () => {
    try {
      const beat = await page.evaluate(() => window.__cockpitBeat || 0);
      if (Date.now() - beat > 90_000) {
        console.error('[cockpit-headless] heartbeat stale, reloading');
        await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
      }
    } catch (err) {
      console.error(`[cockpit-headless] watchdog: ${err.message}`);
    }
  }, 30_000);

  browser.on('disconnected', () => {
    console.error('[cockpit-headless] browser died, restarting in 5s');
    setTimeout(() => run().catch(fatal), 5_000);
  });
}

function fatal(err) {
  console.error(`[cockpit-headless] fatal: ${err.message}; retrying in 15s`);
  setTimeout(() => run().catch(fatal), 15_000);
}

run().catch(fatal);
