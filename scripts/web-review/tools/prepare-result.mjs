import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureResultDirectory } from './result-directory.mjs';
import { activeIssuesForRevision, feedbackRevision } from '../lib/review-round.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const manifestPath = arg('--manifest'), revision = arg('--revision'), blend = arg('--blend'), responsesPath = arg('--responses');
const blender = arg('--blender', '/Applications/Blender.app/Contents/MacOS/Blender');
const chrome = arg('--chrome');
if (!manifestPath || !/^[A-Za-z0-9_-]+$/.test(revision || '') || !blend || !responsesPath) {
  throw new Error('Usage: node tools/prepare-result.mjs --manifest PATH --revision R34 --blend INDEPENDENT.blend --responses responses.json');
}
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
});
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
const fullManifest = path.resolve(manifestPath);
const manifest = JSON.parse(await fs.readFile(fullManifest, 'utf8'));
if (revision === manifest.base_revision || manifest.results?.some((item) => item.revision === revision)) throw new Error('结果版本不能覆盖基础版或已登记版本');
const sourceBlend = path.resolve(blend);
const sourceHash = await digest(sourceBlend);
if (sourceHash === manifest.assets.B.sha256) throw new Error('修订 .blend 与基础模型相同；请先独立另存并完成修改');
const responses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
if (responses.result_revision !== revision || !responses.issues || typeof responses.issues !== 'object') throw new Error('responses.json 版本或结构不匹配');
const packageDir = path.dirname(fullManifest);
const session = await fs.readFile(path.join(packageDir, 'review-session.json'), 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const sourceRevision = feedbackRevision(manifest, session);
const issues = [];
for (const id of manifest.issues || []) {
  const issue = JSON.parse(await fs.readFile(path.join(packageDir, 'issues', `${id}.json`), 'utf8'));
  issues.push(issue);
}
const activeIssues = activeIssuesForRevision(issues, sourceRevision, manifest.base_revision).map((issue) => issue.issue_id);
if (!activeIssues.length) throw new Error('没有待处理的人类意见');
for (const id of activeIssues) if (typeof responses.issues[id]?.response !== 'string' || !responses.issues[id].response.trim()) throw new Error(`${id} 缺少处理说明`);
const scopedResponses = { ...responses, issues: Object.fromEntries(activeIssues.map((id) => [id, responses.issues[id]])) };
const resultDir = path.join(packageDir, 'results', revision);
await ensureResultDirectory(resultDir, { reviewId: manifest.review_id, baseRevision: manifest.base_revision, revision });
const raw = path.join(resultDir, `B_${revision}.raw.glb`), final = path.join(resultDir, `B_${revision}.glb`);
await run(blender, ['--background', '--python', path.join(toolDir, 'export_glb.py'), '--', '--input', sourceBlend, '--output', raw, '--revision', revision]);
await run(process.execPath, [path.join(toolDir, 'optimize-glb.mjs'), raw, final]);
const report = JSON.parse(await fs.readFile(raw.replace(/\.glb$/, '.export.json'), 'utf8'));
report.glb_path = final;
report.glb_sha256 = await digest(final);
report.glb_bytes = (await fs.stat(final)).size;
report.optimization = { pipeline: 'glTF Transform dedup(material), flatten, join, prune' };
await fs.writeFile(path.join(resultDir, `B_${revision}.export.json`), `${JSON.stringify(report, null, 2)}\n`);
await fs.rm(raw);
await fs.rm(raw.replace(/\.glb$/, '.export.json'));
await fs.writeFile(path.join(resultDir, 'responses.json'), `${JSON.stringify(scopedResponses, null, 2)}\n`);
await run(process.execPath, [path.join(toolDir, 'render-after.mjs'), '--manifest', fullManifest, '--revision', revision, ...(chrome ? ['--chrome', chrome] : [])]);
manifest.results ??= [];
manifest.results.push({ revision, directory: `results/${revision}`, status: 'awaiting_human_review' });
const temp = `${fullManifest}.${process.pid}.tmp`;
await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
await fs.rename(temp, fullManifest);
process.stdout.write(`${revision} 已登记，可在网页刷新并人工复核。\n`);
