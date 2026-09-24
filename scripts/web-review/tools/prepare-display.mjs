import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const manifestPath = arg('--manifest');
const blender = arg('--blender', '/Applications/Blender.app/Contents/MacOS/Blender');
const builder = arg('--builder', path.join(process.env.HOME || '', '.cache/3dgs-web-review/spark/rust/target/release/build-lod'));
if (!manifestPath) throw new Error('Usage: node tools/prepare-display.mjs --manifest PATH [--blender PATH] [--builder PATH]');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function shDegree(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString('latin1').split('end_header')[0];
    const rest = (header.match(/property\s+\w+\s+f_rest_\d+/g) || []).length;
    const degree = Math.sqrt(rest / 3 + 1) - 1;
    return Number.isInteger(degree) ? degree : null;
  } finally { await handle.close(); }
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}
const fullManifest = path.resolve(manifestPath);
const packageDir = path.dirname(fullManifest);
const manifest = JSON.parse(await fs.readFile(fullManifest, 'utf8'));
const projectRoot = path.resolve(packageDir, manifest.project_root);
const sourceB = path.resolve(projectRoot, manifest.assets.B.path);
const sourceG = path.resolve(projectRoot, manifest.assets.G.path);
const inputShDegree = await shDegree(sourceG);
if (manifest.display_assets && !process.argv.includes('--replace')) throw new Error('display_assets 已存在；如需重建，请先建立新的测试包或显式传 --replace');
if (await digest(sourceB) !== manifest.assets.B.sha256 || await digest(sourceG) !== manifest.assets.G.sha256) throw new Error('基础模型或扫描哈希与 manifest 不一致');
const displayDir = path.join(packageDir, 'display');
await fs.mkdir(displayDir, { recursive: true });
const revision = manifest.base_revision;
const glb = path.join(displayDir, `B_${revision}.glb`);
const rawGlb = path.join(displayDir, `B_${revision}.raw.glb`);
await run(blender, ['--background', '--python', path.join(toolDir, 'export_glb.py'), '--', '--input', sourceB, '--output', rawGlb, '--revision', revision]);
await run(process.execPath, [path.join(toolDir, 'optimize-glb.mjs'), rawGlb, glb]);
await fs.rm(rawGlb);
const rawReport = rawGlb.replace(/\.glb$/, '.export.json');
const reportPath = glb.replace(/\.glb$/, '.export.json');
const optimizedReport = JSON.parse(await fs.readFile(rawReport, 'utf8'));
optimizedReport.glb_path = glb;
optimizedReport.glb_sha256 = await digest(glb);
optimizedReport.glb_bytes = (await fs.stat(glb)).size;
optimizedReport.optimization = { pipeline: 'glTF Transform dedup(material), flatten, join, prune', purpose: 'reduce GLB draw calls without changing model geometry' };
await fs.writeFile(reportPath, `${JSON.stringify(optimizedReport, null, 2)}\n`);
await fs.rm(rawReport);
const glbReport = JSON.parse(await fs.readFile(glb.replace(/\.glb$/, '.export.json'), 'utf8'));
if (glbReport.source_sha256 !== manifest.assets.B.sha256) throw new Error('GLB 报告的源哈希不匹配');
const tempScan = path.join(displayDir, `G_${revision}_source.ply`);
await fs.copyFile(sourceG, tempScan, fsConstants.COPYFILE_FICLONE);
try {
  await run(builder, ['--quality', '--rad-chunked', '--max-sh=3', tempScan]);
} finally {
  await fs.rm(tempScan, { force: true });
}
const rad = path.join(displayDir, `G_${revision}_source-lod.rad`);
if (!(await fs.stat(rad)).size) throw new Error('RAD 文件为空');
const files = (await fs.readdir(displayDir)).filter((name) => name === path.basename(rad) || (name.startsWith(`G_${revision}_source-lod-`) && name.endsWith('.radc'))).sort();
const chunks = {};
for (const name of files) chunks[name] = { bytes: (await fs.stat(path.join(displayDir, name))).size, sha256: await digest(path.join(displayDir, name)) };
const rel = (file) => path.relative(projectRoot, file);
const report = {
  schema_version: 1, created_at: new Date().toISOString(), source_blend_sha256: manifest.assets.B.sha256,
  source_scan_sha256: manifest.assets.G.sha256, glb_report: rel(glb.replace(/\.glb$/, '.export.json')),
  rad_builder: builder, rad_options: ['--quality', '--rad-chunked', '--max-sh=3'], chunks,
  input_sh_degree: inputShDegree,
};
await fs.writeFile(path.join(displayDir, 'prepare-report.json'), `${JSON.stringify(report, null, 2)}\n`);
manifest.display_assets = {
  B: { path: rel(glb), path_base: 'project_root', kind: 'glb', sha256: await digest(glb), source_sha256: manifest.assets.B.sha256, asset_to_project: glbReport.asset_to_project, export_report: rel(glb.replace(/\.glb$/, '.export.json')) },
  G: { path: rel(rad), path_base: 'project_root', kind: 'rad_chunked', sha256: await digest(rad), source_sha256: manifest.assets.G.sha256, input_sh_degree: inputShDegree, asset_to_project: JSON.parse(await fs.readFile(path.join(packageDir, manifest.alignment_file), 'utf8')).G.source_to_project, generation_report: rel(path.join(displayDir, 'prepare-report.json')) },
};
const tempManifest = `${fullManifest}.${process.pid}.tmp`;
await fs.writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`);
await fs.rename(tempManifest, fullManifest);
process.stdout.write(`显示资产准备完成：\n${glb}\n${rad}\n`);
