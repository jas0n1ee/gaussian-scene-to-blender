import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(process.argv[2], { waitUntil: 'networkidle' });
await page.waitForTimeout(12000);
await page.mouse.move(300, 420);
// turn around and walk north into the west open office
await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(1500); await page.keyboard.up('ArrowLeft');
await page.keyboard.down('w'); await page.waitForTimeout(3000); await page.keyboard.up('w');
await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(400); await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(1500);
await page.screenshot({ path: process.argv[3] });
const info = await page.evaluate(() => document.body.innerText.split('\n').filter(l => l.includes('FPS')).slice(0, 2));
console.log(JSON.stringify(info));
await browser.close();
