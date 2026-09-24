import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewServer } from '../server.mjs';

const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2XcAAAAASUVORK5CYII=';
const camera = { alignment_id: 'test_alignment', camera_to_world: [[1,0,0,0],[0,1,0,0],[0,0,1,1.6],[0,0,0,1]], projection: 'PERSP', capture: { G: { ready: true, pending_pages: 0 } } };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-review-test-'));
  const pkg = path.join(root, 'reviews', 'R33');
  await fs.mkdir(path.join(pkg, 'display'), { recursive: true });
  const manifest = {
    schema_version: 1, review_id: 'R33', project_id: 'test', project_root: '../..', base_revision: 'R33', alignment_id: 'test_alignment', alignment_file: 'alignment.json',
    assets: { B: { path: 'model.blend', sha256: 'sourceB' }, G: { path: 'scan.ply', sha256: 'sourceG' } },
    display_assets: { B: { path: 'reviews/R33/display/B_R33.glb', source_sha256: 'sourceB' }, G: { path: 'reviews/R33/display/G_R33.rad', source_sha256: 'sourceG' } },
    views: [], issues: [], next_issue_number: 1, results: [], reserved_result: { revision: 'R34' },
  };
  await fs.writeFile(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(pkg, 'alignment.json'), JSON.stringify({ alignment_id: 'test_alignment', B: { source_to_project: camera.camera_to_world }, G: { source_to_project: camera.camera_to_world } }));
  await fs.writeFile(path.join(pkg, 'display', 'B_R33.glb'), Buffer.alloc(128, 1));
  await fs.writeFile(path.join(pkg, 'display', 'G_R33.rad'), Buffer.from('0123456789'));
  await fs.writeFile(path.join(pkg, 'display', 'G_R33-0.radc'), Buffer.from('abcdefghij'));
  const instance = await createReviewServer({ manifestPath: path.join(pkg, 'manifest.json'), port: 0 });
  const close = () => new Promise((resolve) => instance.server.close(resolve)).then(() => fs.rm(root, { recursive: true, force: true }));
  return { ...instance, root, pkg, close };
}

async function post(base, url, body, method = 'POST') {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { response, value: await response.json() };
}

test('legacy package remains readable and RAD chunks support byte ranges', async (t) => {
  const app = await fixture(); t.after(app.close);
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.equal(state.manifest.assets.B.path, 'model.blend');
  assert.equal(state.display.G.url, '/display/G_R33.rad');
  const range = await fetch(app.url + '/display/G_R33-0.radc', { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), 'cdef');
  const escape = await fetch(app.url + '/file/views/../manifest.json');
  assert.notEqual(escape.status, 200);
});

test('view, two issues, edit history, result gate and human review survive reload', async (t) => {
  const app = await fixture(); t.after(app.close);
  const saved = await post(app.url, '/api/views', { camera, G: onePixel, B_before: onePixel });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.value.view_id, 'V0001');
  const annotation = [{ source_image: 'G', xywh: [.2,.2,.3,.3] }];
  const first = await post(app.url, '/api/issues', { view_id: 'V0001', comment: '门洞宽度', annotations: annotation });
  const second = await post(app.url, '/api/issues', { view_id: 'V0001', comment: '墙面位置', annotations: [] });
  assert.equal(first.value.issue_id, 'R33_I1');
  assert.equal(second.value.issue_id, 'R33_I2');
  const edited = await post(app.url, '/api/issues', { issue_id: 'R33_I1', view_id: 'V0001', comment: '门洞加宽', annotations: annotation });
  assert.equal(edited.value.history.length, 1);
  const refused = await post(app.url, '/api/issues/R33_I1/review', { status: 'accepted', result_revision: 'R34' });
  assert.equal(refused.response.status, 404);
  assert.notEqual(refused.value.error, undefined);
  const resultDir = path.join(app.pkg, 'results', 'R34', 'views', 'V0001');
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, 'B_after.png'), Buffer.from(onePixel.split(',')[1], 'base64'));
  const noResponse = await post(app.url, '/api/issues/R33_I1/review', { status: 'accepted', result_revision: 'R34' });
  assert.notEqual(noResponse.response.status, 200);
  await fs.writeFile(path.join(app.pkg, 'results', 'R34', 'responses.json'), JSON.stringify({ result_revision: 'R34', issues: { R33_I1: { response: '已调整门洞' } } }));
  const approved = await post(app.url, '/api/issues/R33_I1/review', { status: 'accepted', result_revision: 'R34' });
  assert.equal(approved.value.status, 'accepted');
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.equal(state.views.length, 1);
  assert.equal(state.issues.length, 2);
  assert.equal(state.issues[0].resolved_in_revision, 'R34');
  assert.equal((await fs.readdir(path.join(app.pkg, 'views', 'V0001'))).length, 3);
  assert.equal((await fs.readFile(path.join(app.pkg, 'manifest.json'), 'utf8')).includes('model.blend'), true);
});

test('failed capture does not create a view or advance manifest', async (t) => {
  const app = await fixture(); t.after(app.close);
  const failed = await post(app.url, '/api/views', { camera, G: 'not a PNG', B_before: onePixel });
  assert.equal(failed.response.status, 400);
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.deepEqual(state.manifest.views, []);
  assert.deepEqual(await fs.readdir(path.join(app.pkg, 'views')).catch(() => []), []);
  const retried = await post(app.url, '/api/views', { camera, G: onePixel, B_before: onePixel });
  assert.equal(retried.value.view_id, 'V0001');
});

test('published revision is default; captures and issues retain R34 provenance', async (t) => {
  const app = await fixture(); t.after(app.close);
  const dir = path.join(app.pkg, 'results/R34'); await fs.mkdir(dir, {recursive:true});
  await fs.writeFile(path.join(dir, 'B_R34.glb'), 'model');
  await fs.writeFile(path.join(dir, 'B_R34.export.json'), JSON.stringify({glb_sha256:'r34-hash'}));
  const mf = path.join(app.pkg,'manifest.json'); const manifest = JSON.parse(await fs.readFile(mf));
  manifest.results=[{revision:'R34'}]; await fs.writeFile(mf,JSON.stringify(manifest));
  await fs.writeFile(path.join(app.pkg,'review-session.json'),JSON.stringify({mode:'result',result_revision:'R34'}));
  const state = await (await fetch(app.url+'/api/state')).json();
  assert.equal(state.activeRevision,'R34'); assert.equal(state.resultModels[0].sha256,'r34-hash');
  const wrong=await post(app.url,'/api/views',{camera,G:onePixel,B_before:onePixel,model_revision:'R34'});
  assert.notEqual(wrong.response.status,201);
  const saved=await post(app.url,'/api/views',{camera:{...camera,render_settings:{B_before:{asset_sha256:'r34-hash'}}},G:onePixel,B_before:onePixel,model_revision:'R34'});
  assert.equal(saved.response.status,201); assert.equal(saved.value.camera.model_revision,'R34');
  const issue=await post(app.url,'/api/issues',{view_id:saved.value.view_id,comment:'R34 new problem'});
  assert.equal(issue.value.issue_id,'R34_I1'); assert.equal(issue.value.base_revision,'R34');
  const legacy=await post(app.url,'/api/views',{camera,G:onePixel,B_before:onePixel});
  const old=await post(app.url,'/api/issues',{view_id:legacy.value.view_id,comment:'R33 original'});
  assert.equal(old.value.issue_id,'R33_I1'); assert.equal(old.value.base_revision,'R33');
});
