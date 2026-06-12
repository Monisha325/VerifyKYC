/**
 * VeriKYC Screenshot Loop
 *
 * Usage: node scripts/screenshot.js [url] [label]
 *   node scripts/screenshot.js http://localhost:3000/login login
 *   node scripts/screenshot.js http://localhost:3000/admin/queue queue
 *
 * Screenshots are saved to assets/screenshots/<label>-<timestamp>.png
 *
 * Skips PROCESSING/loading states: waits up to 5 s for spinner to disappear
 * before capturing. If a spinner is still visible, it captures anyway and
 * prints a warning so the screenshot-loop review can flag the frame.
 */

const puppeteer  = require('puppeteer');
const path       = require('path');
const fs         = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'assets', 'screenshots');

const [,, url = 'http://localhost:3000', label = 'page'] = process.argv;

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log(`Navigating to ${url} …`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

  // Wait for loading spinners to clear (PROCESSING state guard)
  try {
    await page.waitForFunction(
      () => !document.querySelector('[data-loading="true"], .animate-spin'),
      { timeout: 5_000 },
    );
  } catch {
    console.warn('⚠️  Loading indicator still visible — capturing anyway');
  }

  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(SCREENSHOT_DIR, `${label}-${ts}.png`);
  await page.screenshot({ path: file, fullPage: true });

  console.log(`✅  Screenshot saved: ${file}`);
  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
