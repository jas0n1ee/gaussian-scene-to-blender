import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ReviewStore } from '../lib/review-store.mjs';
import { activeIssuesForRevision, feedbackRevision } from '../lib/review-round.mjs';

const runtimeDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(runtimeDir, 'server.mjs');
const command = process.argv[2];
const option = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const manifestArg = option('--manifest');
if (!['start', 'status', 'finish', 'pause', 'adopt-feedback', 'publish-result'].includes(command) || !manifestArg) {
  throw new Error('Usage: node tools/review-session.mjs <start|status|finish|pause|adopt-feedback|publish-result> --manifest /absolute/path/manifest.json [--port 0] [--revision R34]');
}

const manifestPath = path.resolve(manifestArg);
const packageDir = path.dirname(manifestPath);
const statePath = path.join(packageDir, 'review-session.json');
const logPath = path.join(packageDir, 'review-service.log');
const lockPath = path.join(packageDir, '.review-session.lock');
const now = () => new Date().toISOString();
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.stat(file).then((stat) => stat.isFile()).catch(() => false);

async function saveState(value) {
  const temp = `${statePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temp, statePath);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readState() {
  if (!await exists(statePath)) return null;
  const state = await readJson(statePath);
  if (state.schema_version !== 1 || state.manifest_path !== manifestPath) {
    throw new Error('已有 Review 会话状态属于其他审阅包或版本；请先核对 review-session.json');
  }
  return state;
}

async function withLock(work) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = await readJson(lockPath).catch(() => ({}));
    if (!old.pid || !alive(old.pid)) {
      await fs.rm(lockPath, { force: true });
      handle = await fs.open(lockPath, 'wx');
    } else {
      throw new Error(`另一个 Agent 正在管理此审阅包（PID ${old.pid}）`);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: now() }));
    await handle.close();
    return await work();
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(lockPath, { force: true });
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ownedProcess(pid) {
  if (!alive(pid)) return false;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes(serverPath) && result.stdout.includes(manifestPath);
}

async function health(state) {
  if (!state?.url || !ownedProcess(state.pid)) return false;
  try {
    const response = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const value = await response.json();
    return value.manifest_path === manifestPath && value.pid === state.pid;
  } catch { return false; }
}

async function stopOwned(state) {
  if (!state?.pid || !ownedProcess(state.pid)) return;
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 40 && ownedProcess(state.pid); attempt++) await delay(100);
  if (ownedProcess(state.pid)) throw new Error(`无法停止本轮 Review 服务 PID ${state.pid}`);
}

function run(commandName, args) {
  const result = spawnSync(commandName, args, { cwd: runtimeDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandName} 退出码 ${result.status}`);
}

async function ensureRuntime() {
  if (!await fs.stat(path.join(runtimeDir, 'node_modules')).then((stat) => stat.isDirectory()).catch(() => false)) {
    run('npm', ['ci']);
  }
  run('npm', ['run', 'build']);
}

async function issueCounts(manifest, revision = null) {
  const counts = { submitted: 0, draft: 0, accepted: 0, returned: 0, deleted: 0 };
  for (const id of manifest.issues || []) {
    const issue = await readJson(path.join(packageDir, 'issues', `${id}.json`));
    if (revision && (issue.base_revision || manifest.base_revision) !== revision) continue;
    if (issue.deleted_at) counts.deleted++;
    else counts[issue.status] = (counts[issue.status] || 0) + 1;
  }
  return counts;
}

async function start() {
  const old = await readState();
  if (old?.phase === 'feedback_submitted') throw new Error('意见已交给 Agent；先完成修订并 publish-result，或使用新的审阅包');
  if (old?.phase === 'reviewing' && await health(old)) {
    return { ...old, reused: true, healthy: true };
  }
  const store = await new ReviewStore(manifestPath).initialize();
  const [b, g] = await Promise.all([store.verifyAsset('B'), store.verifyAsset('G')]);
  if (!b || !g) throw new Error('B/完整 G 显示资产未准备；先运行 prepare-display.mjs，不能以空白页面开始 Review');
  await ensureRuntime();
  const port = Number(option('--port', '0'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须在 0–65535 范围内');
  const offset = await fs.stat(logPath).then((stat) => stat.size).catch(() => 0);
  const log = await fs.open(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [serverPath, '--manifest', manifestPath, '--port', String(port)], {
      cwd: runtimeDir, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    child.unref();
  } finally { await log.close(); }
  let url = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const output = (await fs.readFile(logPath)).subarray(offset).toString('utf8');
    url = /网页审阅器：(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] || null;
    if (url) break;
    if (!alive(child.pid)) throw new Error(`Review 服务启动失败；查看 ${logPath}`);
    await delay(100);
  }
  if (!url) {
    await stopOwned({ pid: child.pid });
    throw new Error(`Review 服务未在 20 秒内就绪；查看 ${logPath}`);
  }
  const state = {
    schema_version: 1, manifest_path: manifestPath, review_id: store.manifest.review_id,
    base_revision: store.manifest.base_revision, phase: 'reviewing',
    mode: old?.mode || 'base', result_revision: old?.result_revision || null,
    url, pid: child.pid, started_at: now(), updated_at: now(),
  };
  if (!await health(state)) {
    await stopOwned(state);
    throw new Error(`Review 服务健康检查失败；查看 ${logPath}`);
  }
  try {
    const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.display?.B || !data.display?.G) throw new Error('显示资产未就绪');
  } catch (error) {
    await stopOwned(state);
    throw new Error(`Review 页面未就绪：${error.message}`);
  }
  await saveState(state);
  return { ...state, reused: false, healthy: true };
}

async function status() {
  const state = await readState();
  const manifest = await readJson(manifestPath);
  const revision = state?.mode === 'result' ? state.result_revision : manifest.base_revision;
  return { ...(state || { phase: 'unstarted', manifest_path: manifestPath }), healthy: await health(state), review_revision: revision, issues: await issueCounts(manifest, revision) };
}

async function finish() {
  const state = await readState();
  if (state?.phase !== 'reviewing') throw new Error('只有 reviewing 状态可以提交本轮 Review');
  const manifest = await readJson(manifestPath);
  const revision = state.mode === 'result' ? state.result_revision : manifest.base_revision;
  const counts = await issueCounts(manifest, revision);
  await stopOwned(state);
  const next = { ...state, phase: 'feedback_submitted', completed_revision: revision, completed_at: now(), url: null, pid: null, issue_counts: counts, updated_at: now() };
  await saveState(next);
  return next;
}

async function pause() {
  const state = await readState();
  if (state?.phase !== 'reviewing') throw new Error('只有 reviewing 状态可以暂停');
  await stopOwned(state);
  const next = { ...state, phase: 'paused', url: null, pid: null, updated_at: now() };
  await saveState(next);
  return next;
}

async function adoptFeedback() {
  if (await readState()) throw new Error('审阅包已有生命周期状态，不能再次接入历史反馈');
  const store = await new ReviewStore(manifestPath).initialize();
  const counts = await issueCounts(store.manifest, store.manifest.base_revision);
  const state = {
    schema_version: 1, manifest_path: manifestPath, review_id: store.manifest.review_id,
    base_revision: store.manifest.base_revision, phase: 'feedback_submitted',
    mode: 'base', result_revision: null, completed_revision: store.manifest.base_revision, url: null, pid: null,
    issue_counts: counts, adopted_legacy_feedback: true,
    started_at: null, updated_at: now(),
  };
  await saveState(state);
  return state;
}

async function publishResult() {
  const state = await readState();
  if (state?.phase !== 'feedback_submitted') throw new Error('必须先结束人工审阅，才能发布修订结果');
  const revision = option('--revision');
  if (!revision || !/^[A-Za-z0-9_-]+$/.test(revision)) throw new Error('请用 --revision 指定结果版本');
  const manifest = await readJson(manifestPath);
  if (!manifest.results?.some((entry) => entry.revision === revision)) throw new Error(`${revision} 未登记在 manifest.results`);
  const resultDir = path.join(packageDir, 'results', revision);
  if (!await exists(path.join(resultDir, `B_${revision}.glb`))) throw new Error('结果 GLB 缺失');
  const responses = await readJson(path.join(resultDir, 'responses.json'));
  if (responses.result_revision !== revision) throw new Error('结果回复的版本不匹配');
  const issues = await Promise.all((manifest.issues || []).map((id) => readJson(path.join(packageDir, 'issues', `${id}.json`))));
  for (const issue of activeIssuesForRevision(issues, feedbackRevision(manifest, state), manifest.base_revision)) {
    const id = issue.issue_id;
    if (!responses.issues?.[id]?.response) throw new Error(`${id} 缺少 Agent 回复`);
    const afterFile = path.join(resultDir, 'views', issue.view_id, 'B_after.png');
    if (!await exists(afterFile)) throw new Error(`${id} 缺少 B_after`);
    const [after, before] = await Promise.all([
      fs.readFile(afterFile), fs.readFile(path.join(packageDir, 'views', issue.view_id, 'B_before.png')),
    ]);
    const pngSize = (bytes) => {
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('结果图片不是有效 PNG');
      return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
    };
    if (pngSize(after) !== pngSize(before)) throw new Error(`${id} 的 B_after 与 B_before 尺寸不同`);
  }
  const next = { ...state, phase: 'result_ready', mode: 'result', result_revision: revision, updated_at: now() };
  await saveState(next);
  return next;
}

const result = command === 'status' ? await status() : await withLock(async () => {
  if (command === 'start') return start();
  if (command === 'finish') return finish();
  if (command === 'pause') return pause();
  if (command === 'adopt-feedback') return adoptFeedback();
  return publishResult();
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
