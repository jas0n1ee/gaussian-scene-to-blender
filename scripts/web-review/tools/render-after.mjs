import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createReviewServer } from '../server.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const manifestPath = arg('--manifest');
const revision = arg('--revision');
const chrome = arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
if (!manifestPath || !/^[A-Za-z0-9_-]+$/.test(revision || '')) throw new Error('Usage: node tools/render-after.mjs --manifest PATH --revision R34 [--chrome PATH]');
const app = await createReviewServer({ manifestPath, port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const state = await app.store.state();
  const resultDir = path.join(app.store.packageDir, 'results', revision);
  const model = path.join(resultDir, `B_${revision}.glb`);
  if (!(await fs.stat(model).catch(() => null))) throw new Error(`缺少 ${model}`);
  for (const { view_id: viewId } of state.views) {
    if (!state.issues.some((issue) => issue.view_id === viewId && !issue.deleted_at)) continue;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${app.url}/render-after.html?revision=${encodeURIComponent(revision)}&view=${encodeURIComponent(viewId)}`);
    await page.waitForFunction(() => window.__renderReady || window.__renderError, undefined, { timeout: 60000 });
    const error = await page.evaluate(() => window.__renderError);
    if (error) throw new Error(`${viewId}: ${error}`);
    const base64 = await page.locator('#result').evaluate((canvas) => canvas.toDataURL('image/png').split(',')[1]);
    const output = path.join(resultDir, 'views', viewId, 'B_after.png');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, Buffer.from(base64, 'base64'));
    process.stdout.write(`${viewId}: ${output}\n`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => app.server.close(resolve));
}
