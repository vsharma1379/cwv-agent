const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE_DIR = path.join(os.homedir(), '.cwv-browser-profile');

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox'],
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  const url = 'https://search.google.com/search-console/core-web-vitals/drilldown?resource_id=https%3A%2F%2Fwww.ambitionbox.com%2F&device=2';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);

  // Set rows per page to 100
  try {
    await page.locator('mat-select').last().click();
    await page.waitForTimeout(1000);
    await page.getByRole('option', { name: '100' }).click();
    await page.waitForTimeout(2000);
  } catch(e) { console.log('Could not change page size:', e.message); }

  // Click the first table row to see what detail appears
  const rows = page.locator('table tbody tr, mat-row, [role="row"]');
  const rowCount = await rows.count();
  console.log('Row count:', rowCount);

  if (rowCount > 0) {
    await rows.first().click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/gsc-row-click.png', fullPage: true });
    const text = await page.evaluate(() => document.body.innerText);
    console.log('After click text:\n', text.slice(0, 3000));
  }

  await context.close();
})();
