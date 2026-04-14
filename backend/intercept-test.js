const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const PROFILE_DIR = path.join(os.homedir(), '.cwv-browser-profile');
(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ['--no-sandbox'], viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  // Go to summary page
  await page.goto('https://search.google.com/search-console/core-web-vitals/summary?resource_id=https%3A%2F%2Fwww.ambitionbox.com%2F&device=2', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '/tmp/gsc-summary.png' });
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.slice(0, 2000));
  // Find all links on this page
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="drilldown"], a[href*="cwv"]')).map(a => ({ text: a.innerText?.trim().slice(0,40), href: a.href }))
  );
  console.log('\nLinks:', JSON.stringify(links, null, 2));
  await context.close();
})();
