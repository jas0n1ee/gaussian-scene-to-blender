import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const now = () => new Date().toISOString();

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function decodePng(input) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input || '');
  if (!match) throw new Error('截图必须是 PNG');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 32 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('截图 PNG 无效');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) throw new Error('截图尺寸无效');
  return { bytes, width, height };
}

function validAnnotations(items) {
  if (!Array.isArray(items)) throw new Error('标注格式无效');
  for (const item of items) {
    if (!['G', 'B_before'].includes(item.source_image)) throw new Error('标注来源无效');
    const a = item.xywh;
    if (!Array.isArray(a) || a.length !== 4 || a.some((v) => !Number.isFinite(v))) throw new Error('框坐标无效');
    const [x, y, w, h] = a;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) throw new Error('框超出画面');
  }
}

export class ReviewStore {
  constructor(manifestPath) {
    this.manifestPath = path.resolve(manifestPath);
    this.packageDir = path.dirname(this.manifestPath);
    this.queue = Promise.resolve();
    this.verifiedFiles = new Map();
  }

  async initialize() {
    this.manifest = await readJson(this.manifestPath);
    if (this.manifest.schema_version !== 1) throw new Error('不支持的审阅包版本');
    this.projectRoot = path.resolve(this.packageDir, this.manifest.project_root || '.');
    if (!inside(this.projectRoot, this.packageDir)) throw new Error('审阅包不在项目目录中');
    this.alignment = await readJson(path.join(this.packageDir, this.manifest.alignment_file || 'alignment.json'));
    if (this.alignment.alignment_id !== this.manifest.alignment_id) throw new Error('alignment_id 不匹配');
    return this;
  }

  enqueue(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  assetPath(asset) {
    if (!asset?.path || path.isAbsolute(asset.path)) throw new Error('显示资产路径无效');
    const base = asset.path_base === 'manifest_directory' ? this.packageDir : this.projectRoot;
    const resolved = path.resolve(base, asset.path);
    if (!inside(this.projectRoot, resolved)) throw new Error('显示资产越过项目目录');
    return resolved;
  }

  async displayAsset(kind) {
    const asset = this.manifest.display_assets?.[kind];
    if (!asset) return null;
    const file = this.assetPath(asset);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      const real = await fs.realpath(file);
      if (!inside(await fs.realpath(this.projectRoot), real)) throw new Error('显示资产真实路径越过项目目录');
      if (asset.sha256) await this.verifyDigest(real, asset.sha256, stat);
      return { ...asset, file: real, bytes: stat.size };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async verifyDigest(file, expected, stat = null) {
    const info = stat || await fs.stat(file);
    const cached = this.verifiedFiles.get(file);
    if (cached?.sha256 === expected && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (hash.digest('hex') !== expected) throw new Error(`显示资产哈希不符：${path.basename(file)}`);
    this.verifiedFiles.set(file, { sha256: expected, size: info.size, mtimeMs: info.mtimeMs });
  }

  async verifyDisplayChunk(name) {
    const g = await this.displayAsset('G');
    if (!g) throw new Error('扫描显示资产未准备或哈希不符');
    const file = path.join(path.dirname(g.file), name);
    const real = await fs.realpath(file);
    if (!inside(path.dirname(g.file), real)) throw new Error('扫描分页真实路径越界');
    const reportPath = this.manifest.display_assets.G.generation_report;
    if (!reportPath) return real;
    const report = await readJson(this.assetPath({ path: reportPath }));
    const expected = report.chunks?.[name]?.sha256;
    if (!expected) throw new Error('扫描分页没有登记哈希');
    await this.verifyDigest(real, expected);
    return real;
  }

  async state() {
    this.manifest = await readJson(this.manifestPath);
    const issuesDir = path.join(this.packageDir, 'issues');
    const names = await fs.readdir(issuesDir).catch(() => []);
    const issues = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try { issues.push(await readJson(path.join(issuesDir, name))); } catch { /* show remaining valid records */ }
    }
    issues.sort((a, b) => (Number(a.issue_id?.match(/_I(\d+)$/)?.[1]) || 0) - (Number(b.issue_id?.match(/_I(\d+)$/)?.[1]) || 0));
    const views = [];
    for (const viewId of this.manifest.views || []) {
      try {
        const camera = await readJson(path.join(this.packageDir, 'views', viewId, 'camera.json'));
        views.push({ view_id: viewId, camera });
      } catch { /* invalid view will not appear */ }
    }
    const [b, g] = await Promise.all([this.displayAsset('B'), this.displayAsset('G')]);
    const resultModels = [];
    const resultsRoot = path.join(this.packageDir, 'results');
    for (const { revision } of this.manifest.results || []) {
      if (!/^[A-Za-z0-9_-]+$/.test(revision)) continue;
      const model = path.join(resultsRoot, revision, `B_${revision}.glb`);
      if (!(await fs.stat(model).then((stat) => stat.isFile()).catch(() => false))) continue;
      let assetToProject = null, report = {};
      try { report = await readJson(path.join(resultsRoot, revision, `B_${revision}.export.json`)); assetToProject = report.asset_to_project; } catch { /* original GLB axis convention */ }
      resultModels.push({ revision, sha256: report.glb_sha256, source_sha256: report.source_sha256, url: `/file/results/${encodeURIComponent(revision)}/B_${encodeURIComponent(revision)}.glb`, asset_to_project: assetToProject || b?.asset_to_project || null });
    }
    let session = null;
    try { session = await readJson(path.join(this.packageDir, 'review-session.json')); } catch {}
    const activeRevision = session?.mode === 'result' && resultModels.some(m => m.revision === session.result_revision) ? session.result_revision : 'base';
    let homeCamera = null;
    try { homeCamera = await readJson(path.join(this.packageDir, 'diagnostics', 'camera.json')); } catch { /* optional */ }
    return {
      manifest: this.manifest,
      alignment: this.alignment,
      display: {
        B: b ? { ...this.manifest.display_assets.B, url: '/asset/B' } : null,
        G: g ? { ...this.manifest.display_assets.G, url: `/display/${encodeURIComponent(path.basename(g.file))}` } : null,
      },
      views, issues, homeCamera, resultModels, activeRevision,
    };
  }

  async saveView(body) {
    return this.enqueue(async () => {
      this.manifest = await readJson(this.manifestPath);
      const g = decodePng(body.G);
      const b = decodePng(body.B_before);
      if (g.width !== b.width || g.height !== b.height) throw new Error('两侧截图尺寸不一致');
      const camera = structuredClone(body.camera || {});
      const revision = body.model_revision || this.manifest.base_revision;
      if (revision !== this.manifest.base_revision) {
        if (!this.manifest.results?.some(r => r.revision === revision)) throw new Error('未登记的模型版本');
        const report = await readJson(path.join(this.packageDir, 'results', revision, `B_${revision}.export.json`));
        if (!report.glb_sha256 || camera.render_settings?.B_before?.asset_sha256 !== report.glb_sha256) throw new Error('截图模型哈希与版本不一致');
      }
      camera.model_revision = revision;
      if (camera.alignment_id !== this.manifest.alignment_id) throw new Error('机位对齐版本不一致');
      if (!Array.isArray(camera.camera_to_world) || camera.camera_to_world.length !== 4 ||
        camera.camera_to_world.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((v) => !Number.isFinite(v)))) {
        throw new Error('相机矩阵无效');
      }
      if (camera.capture?.G?.pending_pages > 0 || camera.capture?.G?.ready === false) throw new Error('高斯分页未加载完成');
      const viewsRoot = path.join(this.packageDir, 'views');
      await fs.mkdir(viewsRoot, { recursive: true });
      const existing = await fs.readdir(viewsRoot);
      let sequence = Math.max(0, ...existing.map((n) => Number(/^V(\d+)$/.exec(n)?.[1]) || 0));
      let viewId;
      do { viewId = `V${String(++sequence).padStart(4, '0')}`; } while (existing.includes(viewId));
      camera.view_id = viewId;
      camera.schema_version = 1;
      camera.image_geometry = { ...(camera.image_geometry || {}), resolution: [g.width, g.height], resolution_percentage: 100, pixel_aspect: [1, 1] };
      camera.captured_at = now();
      const staging = path.join(viewsRoot, `.${viewId}.${process.pid}.tmp`);
      const final = path.join(viewsRoot, viewId);
      await fs.mkdir(staging);
      try {
        await Promise.all([
          fs.writeFile(path.join(staging, 'G.png'), g.bytes),
          fs.writeFile(path.join(staging, 'B_before.png'), b.bytes),
          fs.writeFile(path.join(staging, 'camera.json'), `${JSON.stringify(camera, null, 2)}\n`),
        ]);
        await fs.rename(staging, final);
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
      }
      this.manifest.views ??= [];
      this.manifest.views.push(viewId);
      await atomicJson(this.manifestPath, this.manifest);
      return { view_id: viewId, camera };
    });
  }

  async saveIssue(body) {
    return this.enqueue(async () => {
      this.manifest = await readJson(this.manifestPath);
      const { view_id: viewId, comment, annotations = [], submit = true } = body;
      if (!this.manifest.views?.includes(viewId)) throw new Error('机位不存在');
      if (typeof comment !== 'string' || !comment.trim()) throw new Error('请输入意见');
      validAnnotations(annotations);
      const viewCamera = await readJson(path.join(this.packageDir, 'views', viewId, 'camera.json'));
      const viewRevision = viewCamera.model_revision || this.manifest.base_revision;
      const issuesRoot = path.join(this.packageDir, 'issues');
      await fs.mkdir(issuesRoot, { recursive: true });
      let id = body.issue_id;
      let old = null;
      if (id) {
        if (!/^[-A-Za-z0-9_]+_I\d+$/.test(id)) throw new Error('问题编号无效');
        old = await readJson(path.join(issuesRoot, `${id}.json`));
        if (old.view_id !== viewId) throw new Error('已有问题不能换机位');
        if (old.deleted_at) throw new Error('已删除问题不能编辑');
      } else {
        const prefix = viewRevision === this.manifest.base_revision ? (this.manifest.review_id || viewRevision) : `${(this.manifest.review_id || '').match(/^(.*)R\d+$/)?.[1] || ''}${viewRevision}`;
        const names = await fs.readdir(issuesRoot);
        const max = Math.max(0, ...names.map((n) => n.startsWith(`${prefix}_I`) ? Number(n.slice(prefix.length + 2).match(/^(\d+)\.json$/)?.[1]) || 0 : 0));
        const next = Math.max(max + 1, viewRevision === this.manifest.base_revision ? Number(this.manifest.next_issue_number) || 1 : 1);
        id = `${prefix}_I${next}`;
      }
      const history = [...(old?.history || [])];
      if (old) history.push({ at: now(), action: 'edit', previous_comment: old.comment, previous_annotations: old.annotations });
      const issue = {
        schema_version: 1, issue_id: id, base_revision: old?.base_revision || viewRevision,
        view_id: viewId, alignment_id: this.manifest.alignment_id,
        comment: comment.trim(), annotations, status: submit ? 'submitted' : 'draft',
        created_at: old?.created_at || now(), updated_at: now(), history,
      };
      await atomicJson(path.join(issuesRoot, `${id}.json`), issue);
      this.manifest.issues ??= [];
      if (!this.manifest.issues.includes(id)) this.manifest.issues.push(id);
      if (viewRevision === this.manifest.base_revision) this.manifest.next_issue_number = Math.max(Number(this.manifest.next_issue_number) || 1, Number(id.match(/_I(\d+)$/)[1]) + 1);
      await atomicJson(this.manifestPath, this.manifest);
      return issue;
    });
  }

  async deleteIssue(id) {
    return this.enqueue(async () => {
      const file = path.join(this.packageDir, 'issues', `${id}.json`);
      const issue = await readJson(file);
      issue.history ??= [];
      issue.history.push({ at: now(), action: 'delete' });
      issue.deleted_at = now();
      issue.status = 'deleted';
      issue.updated_at = now();
      await atomicJson(file, issue);
      return issue;
    });
  }

  async reviewIssue(id, status, revision) {
    return this.enqueue(async () => {
      if (!['accepted', 'returned'].includes(status)) throw new Error('复核状态无效');
      if (!/^[A-Za-z0-9_-]+$/.test(revision || '')) throw new Error('结果版本无效');
      const file = path.join(this.packageDir, 'issues', `${id}.json`);
      const issue = await readJson(file);
      if (issue.deleted_at) throw new Error('已删除的问题不能复核');
      if (status === 'accepted') {
        const responses = await readJson(path.join(this.packageDir, 'results', revision, 'responses.json'));
        if (typeof responses.issues?.[id]?.response !== 'string' || !responses.issues[id].response.trim()) throw new Error('该问题缺少修订说明');
        const after = path.join(this.packageDir, 'results', revision, 'views', issue.view_id, 'B_after.png');
        const before = path.join(this.packageDir, 'views', issue.view_id, 'B_before.png');
        const [a, b] = await Promise.all([fs.readFile(after), fs.readFile(before)]);
        const size = (bytes) => {
          if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('结果图片无效');
          return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
        };
        if (size(a).join('x') !== size(b).join('x')) throw new Error('修改后图片尺寸与原图不同');
      }
      issue.history ??= [];
      issue.history.push({ at: now(), action: 'human_review', status, result_revision: revision });
      issue.status = status;
      issue.resolved_in_revision = status === 'accepted' ? revision : null;
      issue.updated_at = now();
      await atomicJson(file, issue);
      return issue;
    });
  }

  async verifyAsset(kind) {
    const asset = await this.displayAsset(kind);
    if (!asset) throw new Error(`${kind} 显示资产未准备`);
    const source = this.manifest.assets?.[kind];
    if (asset.source_sha256 && source?.sha256 && asset.source_sha256 !== source.sha256) throw new Error(`${kind} 显示资产来源不匹配`);
    return asset;
  }

  async sha256(file) {
    const bytes = await fs.readFile(file);
    return createHash('sha256').update(bytes).digest('hex');
  }
}

export { inside };
