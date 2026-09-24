import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(runtime, 'tools', 'review-session.mjs');
const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2XcAAAAASUVORK5CYII=';
const camera = { alignment_id: 'test_alignment', camera_to_world: [[1,0,0,0],[0,1,0,0],[0,0,1,1.6],[0,0,0,1]], capture: { G: { ready: true, pending_pages: 0 } } };

function command(action, manifest, ...options) {
  const result = spawnSync(process.execPath, [cli, action, '--manifest', manifest, ...options], {
    cwd: runtime, encoding: 'utf8', timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `命令退出码 ${result.status}`);
  return result.stdout;
}

test('Agent starts, finishes, publishes and resumes one review package', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-session-test-'));
  const pkg = path.join(root, 'reviews', 'R33');
  const manifestPath = path.join(pkg, 'manifest.json');
  await fs.mkdir(path.join(pkg, 'display'), { recursive: true });
  const manifest = {
    schema_version: 1, review_id: 'R33', project_id: 'test', project_root: '../..', base_revision: 'R33',
    alignment_id: 'test_alignment', alignment_file: 'alignment.json',
    assets: { B: { path: 'model.blend', sha256: 'sourceB' }, G: { path: 'scan.ply', sha256: 'sourceG' } },
    display_assets: { B: { path: 'reviews/R33/display/B_R33.glb' }, G: { path: 'reviews/R33/display/G_R33.rad' } },
    views: [], issues: [], results: [], next_issue_number: 1,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(pkg, 'alignment.json'), JSON.stringify({ alignment_id: 'test_alignment' }));
  await fs.writeFile(path.join(pkg, 'display', 'B_R33.glb'), Buffer.alloc(128, 1));
  await fs.writeFile(path.join(pkg, 'display', 'G_R33.rad'), Buffer.alloc(128, 2));
  try {
    const started = command('start', manifestPath);
    const url = /"url": "(http:\/\/127\.0\.0\.1:\d+)"/.exec(started)?.[1];
    assert.ok(url, started);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.manifest_path, manifestPath);
    assert.equal(JSON.parse(command('status', manifestPath)).phase, 'reviewing');
    assert.match(command('start', manifestPath), /"reused": true/);

    const view = await (await fetch(`${url}/api/views`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera, G: onePixel, B_before: onePixel }),
    })).json();
    const issue = await (await fetch(`${url}/api/issues`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view_id: view.view_id, comment: '墙体缺失', annotations: [], submit: true }),
    })).json();
    assert.equal(issue.issue_id, 'R33_I1');
    const finished = JSON.parse(command('finish', manifestPath));
    assert.equal(finished.phase, 'feedback_submitted');
    assert.equal(finished.issue_counts.submitted, 1);
    assert.equal(JSON.parse(command('status', manifestPath)).healthy, false);
    assert.throws(() => command('start', manifestPath), /feedback_submitted|意见已交给 Agent/);

    const resultDir = path.join(pkg, 'results', 'R34');
    await fs.mkdir(path.join(resultDir, 'views', view.view_id), { recursive: true });
    await fs.writeFile(path.join(resultDir, 'B_R34.glb'), Buffer.alloc(128, 3));
    await fs.writeFile(path.join(resultDir, 'B_R34.export.json'), JSON.stringify({ glb_sha256: 'testR34' }));
    await fs.writeFile(path.join(resultDir, 'responses.json'), JSON.stringify({ result_revision: 'R34', issues: { R33_I1: { response: '已补墙' } } }));
    await fs.writeFile(path.join(resultDir, 'views', view.view_id, 'B_after.png'), Buffer.from(onePixel.split(',')[1], 'base64'));
    const updated = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    updated.results.push({ revision: 'R34', directory: 'results/R34' });
    await fs.writeFile(manifestPath, JSON.stringify(updated));
    assert.equal(JSON.parse(command('publish-result', manifestPath, '--revision', 'R34')).phase, 'result_ready');
    const resumed = command('start', manifestPath);
    assert.match(resumed, /"mode": "result"/);
    const resumedUrl = /"url": "(http:\/\/127\.0\.0\.1:\d+)"/.exec(resumed)?.[1];
    const nextView = await (await fetch(`${resumedUrl}/api/views`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_revision: 'R34', camera: { ...camera, render_settings: { B_before: { asset_sha256: 'testR34' } } }, G: onePixel, B_before: onePixel }),
    })).json();
    assert.ok(nextView.view_id, JSON.stringify(nextView));
    const nextIssue = await (await fetch(`${resumedUrl}/api/issues`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view_id: nextView.view_id, comment: 'R34 新意见', annotations: [], submit: true }),
    })).json();
    assert.ok(nextIssue.issue_id, JSON.stringify(nextIssue));
    const savedNextIssue = JSON.parse(await fs.readFile(path.join(pkg, 'issues', `${nextIssue.issue_id}.json`), 'utf8'));
    assert.equal(savedNextIssue.base_revision, 'R34');
    const secondFinished = JSON.parse(command('finish', manifestPath));
    assert.equal(secondFinished.completed_revision, 'R34');
    assert.equal(secondFinished.issue_counts.submitted, 1);

    const nextResult = path.join(pkg, 'results', 'R35');
    await fs.mkdir(path.join(nextResult, 'views', nextView.view_id), { recursive: true });
    await fs.writeFile(path.join(nextResult, 'B_R35.glb'), Buffer.alloc(128, 4));
    await fs.writeFile(path.join(nextResult, 'responses.json'), JSON.stringify({ result_revision: 'R35', issues: { [nextIssue.issue_id]: { response: '已处理 R34 意见' } } }));
    await fs.writeFile(path.join(nextResult, 'views', nextView.view_id, 'B_after.png'), Buffer.from(onePixel.split(',')[1], 'base64'));
    const finalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    finalManifest.results.push({ revision: 'R35', directory: 'results/R35' });
    await fs.writeFile(manifestPath, JSON.stringify(finalManifest));
    assert.equal(JSON.parse(command('publish-result', manifestPath, '--revision', 'R35')).phase, 'result_ready');
  } finally {
    try {
      const state = JSON.parse(command('status', manifestPath));
      if (state.phase === 'reviewing') command('pause', manifestPath);
    } catch { /* fixture may have failed before state creation */ }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('completed legacy feedback is adopted once without starting a server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-adopt-test-'));
  const pkg = path.join(root, 'reviews', 'R33');
  const manifestPath = path.join(pkg, 'manifest.json');
  await fs.mkdir(path.join(pkg, 'issues'), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    schema_version: 1, review_id: 'R33', project_root: '../..', base_revision: 'R33',
    alignment_id: 'test_alignment', alignment_file: 'alignment.json', issues: ['R33_I1'],
  }));
  await fs.writeFile(path.join(pkg, 'alignment.json'), JSON.stringify({ alignment_id: 'test_alignment' }));
  await fs.writeFile(path.join(pkg, 'issues', 'R33_I1.json'), JSON.stringify({ issue_id: 'R33_I1', status: 'submitted' }));
  try {
    const state = JSON.parse(command('adopt-feedback', manifestPath));
    assert.equal(state.phase, 'feedback_submitted');
    assert.equal(state.issue_counts.submitted, 1);
    assert.equal(state.adopted_legacy_feedback, true);
    assert.equal(JSON.parse(command('status', manifestPath)).healthy, false);
    assert.throws(() => command('adopt-feedback', manifestPath), /已有生命周期状态/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('web completion stops the Agent-started server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-web-finish-test-'));
  const pkg = path.join(root, 'reviews', 'R35');
  const manifestPath = path.join(pkg, 'manifest.json');
  await fs.mkdir(path.join(pkg, 'display'), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    schema_version: 1, review_id: 'R35', project_root: '../..', base_revision: 'R35',
    alignment_id: 'test_alignment', alignment_file: 'alignment.json',
    assets: { B: { path: 'model.blend' }, G: { path: 'scan.ply' } },
    display_assets: { B: { path: 'reviews/R35/display/B_R35.glb' }, G: { path: 'reviews/R35/display/G_R35.rad' } },
    views: [], issues: [], results: [],
  }));
  await fs.writeFile(path.join(pkg, 'alignment.json'), JSON.stringify({ alignment_id: 'test_alignment' }));
  await fs.writeFile(path.join(pkg, 'display', 'B_R35.glb'), Buffer.alloc(128, 1));
  await fs.writeFile(path.join(pkg, 'display', 'G_R35.rad'), Buffer.alloc(128, 2));
  let pid;
  try {
    const started = command('start', manifestPath);
    const url = /"url": "(http:\/\/127\.0\.0\.1:\d+)"/.exec(started)?.[1];
    pid = Number(/"pid": (\d+)/.exec(started)?.[1]);
    assert.ok(url);
    const response = await fetch(`${url}/api/review/finish`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).review_revision, 'R35');
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(250) }); }
      catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (attempt === 39) assert.fail('Review server remained reachable after completion');
    }
    assert.equal(JSON.parse(command('status', manifestPath)).phase, 'feedback_submitted');
  } finally {
    if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await fs.rm(root, { recursive: true, force: true });
  }
});
