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

  // Watchdog: reload on a stale heartbeat, and — critically — fully relaunch
  // Chrome when it hits a region block. A VPN/network flip pins the browser to
  // the old egress IP, so a mere reload won't clear it; only a fresh process
  // picks up the new route. This self-heals the "pending pile-up" symptom.
  let regionStrikes = 0;
  setInterval(async () => {
    try {
      const beat = await page.evaluate(() => window.__cockpitBeat || 0);
      if (Date.now() - beat > 90_000) {
        console.error('[cockpit-headless] heartbeat stale, reloading');
        await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
      }
      const blocked = await page.evaluate(() =>
        /not available in region/i.test(document.body?.innerText || ''));
      if (blocked) {
        regionStrikes += 1;
        console.error(`[cockpit-headless] region block detected (${regionStrikes}/2) — turn VPN off / non-US`);
        if (regionStrikes >= 2) {
          console.error('[cockpit-headless] relaunching Chrome to pick up current network');
          regionStrikes = 0;
          await browser.close().catch(() => {});
          return; // 'disconnected' handler relaunches
        }
      } else {
        regionStrikes = 0;
      }
    } catch (err) {
      console.error(`[cockpit-headless] watchdog: ${err.message}`);
    }
  }, 30_000);

  let relaunching = false;
  browser.on('disconnected', () => {
    if (relaunching) return;
    relaunching = true;
    console.error('[cockpit-headless] browser gone, restarting in 5s');
    setTimeout(() => run().catch(fatal), 5_000);
  });
}

function fatal(err) {
  console.error(`[cockpit-headless] fatal: ${err.message}; retrying in 15s`);
  setTimeout(() => run().catch(fatal), 15_000);
}

run().catch(fatal);
