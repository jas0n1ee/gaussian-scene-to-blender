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
    await fs.writeFile(path.join(resultDir, 'responses.json'), JSON.stringify({ result_revision: 'R34', issues: { R33_I1: { response: '已补墙' } } }));
    await fs.writeFile(path.join(resultDir, 'views', view.view_id, 'B_after.png'), Buffer.from(onePixel.split(',')[1], 'base64'));
    const updated = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    updated.results.push({ revision: 'R34', directory: 'results/R34' });
    await fs.writeFile(manifestPath, JSON.stringify(updated));
    assert.equal(JSON.parse(command('publish-result', manifestPath, '--revision', 'R34')).phase, 'result_ready');
    const resumed = command('start', manifestPath);
    assert.match(resumed, /"mode": "result"/);
    assert.equal(JSON.parse(command('pause', manifestPath)).phase, 'paused');
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
