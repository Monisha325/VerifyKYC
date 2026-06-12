/**
 * Authenticated screenshot loop.
 * Logs in via the browser form, then captures protected pages WITHOUT
 * reloading (to avoid losing the in-memory JWT on full-page refresh).
 *
 * Usage: node scripts/screenshot-auth.js [email] [password]
 * Set APP_ID env var to override the reviewer-detail application ID.
 */

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'assets', 'screenshots');
const BASE           = 'http://localhost:3000';
const APP_ID         = process.env.APP_ID || 'cmpu1w8fq000s309nqs8w96rm';

const [,, email = 'reviewer@verikyc.dev', password = 'Reviewer#2026!VKyc'] = process.argv;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForContent(page, timeout = 18000) {
  // Wait for spinners + page loaders to clear.
  // Neon (serverless Postgres) cold-start queries can take 10–15 s on first hit.
  try {
    await page.waitForFunction(
      () => {
        // Lucide Loader2 uses animate-spin; PageLoader wraps it with a "Loading…" label
        const spinning = document.querySelector('.animate-spin');
        const pulsing  = document.querySelector('.animate-pulse');
        // Wait until both are gone — pulsing skeleton lines also indicate loading
        return !spinning;
      },
      { timeout },
    );
  } catch { /* capture anyway — better a loading screenshot than nothing */ }
  await sleep(1200); // extra settle for React state updates after API response
}

async function screenshot(page, label) {
  await waitForContent(page);
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(SCREENSHOT_DIR, `${label}-${ts}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  saved ${label}: ${path.basename(file)}  (url: ${page.url()})`);
  return file;
}

async function navigateAndShot(page, url, label) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
  return screenshot(page, label);
}

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // ── 1. Log in via the form ────────────────────────────────────────────────
  console.log(`\nLogging in as ${email} …`);
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

  await page.type('input[type="email"]',    email,    { delay: 50 });
  await page.type('input[type="password"]', password, { delay: 50 });

  // Navigate and wait together: click submit + wait for URL change
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);

  const postLoginUrl = page.url();
  if (postLoginUrl.includes('/login')) {
    console.error('  Login failed — still on login page. Check credentials.');
    await browser.close(); process.exit(1);
  }
  console.log(`  logged in, landed at: ${postLoginUrl}`);

  // ── 2. Dashboard (we are already here after login) ────────────────────────
  console.log('\nDashboard …');
  // If reviewer was sent to /dashboard, great. If sent to /admin/queue (because
  // of a redirect rule), navigate to /dashboard explicitly.
  if (!postLoginUrl.includes('/dashboard')) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle2', timeout: 20000 });
  }
  await screenshot(page, 'dashboard');

  // ── 3. Apply wizard ───────────────────────────────────────────────────────
  console.log('\nApply wizard …');
  await navigateAndShot(page, `${BASE}/apply`, 'apply-wizard');

  // ── 4. Reviewer queue ─────────────────────────────────────────────────────
  console.log('\nReviewer queue …');
  await navigateAndShot(page, `${BASE}/admin/queue`, 'reviewer-queue');

  // ── 5. Reviewer detail ────────────────────────────────────────────────────
  console.log('\nReviewer detail …');
  await navigateAndShot(page, `${BASE}/admin/${APP_ID}`, 'reviewer-detail');

  await browser.close();
  console.log('\nAll screenshots done.');
}

run().catch(err => { console.error(err); process.exit(1); });
