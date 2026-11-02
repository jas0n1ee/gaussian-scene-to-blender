import { chromium } from 'playwright';
const url = process.argv[2];
const out = process.argv[3];
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 }).catch(e => errors.push('GOTO ' + e.message));
await page.waitForTimeout(30000);
await page.screenshot({ path: out });
console.log(JSON.stringify({ errors: errors.slice(0, 8), title: await page.title() }, null, 1));
await browser.close();
