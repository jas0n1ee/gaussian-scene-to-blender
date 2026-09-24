import { createHash } from 'node:crypto';
import { createReadStream, constants, promises as fs } from 'node:fs';
import path from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const fromPath = arg('--from');
const toPath = arg('--to');
if (!fromPath || !toPath) throw new Error('Usage: node tools/install-display.mjs --from PRACTICE/manifest.json --to FORMAL/manifest.json');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const sourceManifestPath = path.resolve(fromPath), targetManifestPath = path.resolve(toPath);
const source = await read(sourceManifestPath), target = await read(targetManifestPath);
if (target.display_assets || await fs.stat(path.join(path.dirname(targetManifestPath), 'display')).catch(() => false)) throw new Error('目标审阅包已有显示资产；拒绝覆盖');
if (source.base_revision !== target.base_revision || source.alignment_id !== target.alignment_id) throw new Error('审阅版本或坐标对齐不一致');
const sourceRoot = path.resolve(path.dirname(sourceManifestPath), source.project_root);
const targetRoot = path.resolve(path.dirname(targetManifestPath), target.project_root);
for (const kind of ['B', 'G']) {
  if (source.assets[kind].sha256 !== target.assets[kind].sha256) throw new Error(`${kind} 源哈希不一致`);
  const file = path.resolve(targetRoot, target.assets[kind].path);
  if (await digest(file) !== target.assets[kind].sha256) throw new Error(`${kind} 正式源文件哈希不符`);
}
const sourceDisplay = path.join(path.dirname(sourceManifestPath), 'display');
const targetDisplay = path.join(path.dirname(targetManifestPath), 'display');
const stage = `${targetDisplay}.${process.pid}.tmp`;
const scanReport = await read(path.join(sourceDisplay, 'prepare-report.json'));
if (scanReport.source_blend_sha256 !== target.assets.B.sha256 || scanReport.source_scan_sha256 !== target.assets.G.sha256) throw new Error('转换报告源哈希不符');
const sourceB = path.resolve(sourceRoot, source.display_assets.B.path);
const sourceG = path.resolve(sourceRoot, source.display_assets.G.path);
const sourceBHash = await digest(sourceB);
if (sourceBHash !== (await read(path.join(sourceDisplay, `B_${source.base_revision}.export.json`))).glb_sha256) throw new Error('优化 GLB 与报告哈希不符');
if (await digest(sourceG) !== source.display_assets.G.sha256) throw new Error('RAD 头文件哈希不符');
await fs.mkdir(stage);
try {
  const copy = async (from, name) => fs.copyFile(from, path.join(stage, name), constants.COPYFILE_FICLONE);
  const bName = `B_${target.base_revision}.glb`;
  await copy(sourceB, bName);
  for (const [name, record] of Object.entries(scanReport.chunks)) {
    const file = path.join(sourceDisplay, name);
    if (await digest(file) !== record.sha256) throw new Error(`${name} 哈希不符`);
    await copy(file, name);
  }
  const report = await read(path.join(sourceDisplay, `B_${source.base_revision}.export.json`));
  report.source_blend = path.resolve(targetRoot, target.assets.B.path);
  report.glb_path = path.join(targetDisplay, bName);
  report.glb_sha256 = sourceBHash;
  report.glb_bytes = (await fs.stat(sourceB)).size;
  await fs.writeFile(path.join(stage, `B_${target.base_revision}.export.json`), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(stage, 'prepare-report.json'), `${JSON.stringify(scanReport, null, 2)}\n`);
  await fs.rename(stage, targetDisplay);
} catch (error) {
  await fs.rm(stage, { recursive: true, force: true });
  throw error;
}
const rel = (name) => path.relative(targetRoot, path.join(targetDisplay, name));
const gName = path.basename(sourceG);
target.display_assets = {
  B: { ...source.display_assets.B, path: rel(`B_${target.base_revision}.glb`), sha256: sourceBHash, export_report: rel(`B_${target.base_revision}.export.json`) },
  G: { ...source.display_assets.G, path: rel(gName), generation_report: rel('prepare-report.json') },
};
target.preparation = { ...(target.preparation || {}), status: 'web_review_ready', interactive_tool_ready: true, pending: [] };
const temp = `${targetManifestPath}.${process.pid}.tmp`;
await fs.writeFile(temp, `${JSON.stringify(target, null, 2)}\n`);
await fs.rename(temp, targetManifestPath);
process.stdout.write(`显示资产已登记：${targetDisplay}\n正式 .blend/PLY 保持原样。\n`);
