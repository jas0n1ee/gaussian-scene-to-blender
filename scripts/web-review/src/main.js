import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import './style.css';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const matrix4 = (rows) => new THREE.Matrix4().set(...rows.flat());
const data = { state: null, issue: null, viewId: null, boxes: [], drawing: null, navHot: false, frozen: false, keys: new Set(), moving: false, gReady: false, bReady: false, gSplat: null, spark: null, revision: null, lastGNetwork: 0, captureBusy: false, capturePending: false, savingIssue: false, modelCache: new Map(), modelRoot: null, loadedVersion: null, modelLoadToken: 0 };

const sceneG = new THREE.Scene();
sceneG.background = new THREE.Color('#202624');
const sceneB = new THREE.Scene();
sceneB.background = new THREE.Color('#e8ebe6');
sceneB.add(new THREE.HemisphereLight(0xffffff, 0x6c756e, 2.3));
const light = new THREE.DirectionalLight(0xffffff, 2.0);
light.position.set(-5, -6, 12);
sceneB.add(light);

const cameraG = new THREE.PerspectiveCamera(60, 1.5, .05, 300);
const cameraB = new THREE.PerspectiveCamera(60, 1.5, .05, 300);
const pose = { position: new THREE.Vector3(0, -5, 1.6), quaternion: new THREE.Quaternion(), yaw: 0, pitch: 0 };
const up = new THREE.Vector3(0, 0, 1);
const makeRenderer = (canvas) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
};
let rendererG, rendererB;
try {
  rendererG = makeRenderer($('g-canvas'));
  rendererB = makeRenderer($('b-canvas'));
} catch (error) {
  $('global-status').textContent = `WebGL 初始化失败：${error.message}`;
}

function setStatus(message, error = false) {
  $('global-status').textContent = message;
  $('global-status').style.color = error ? '#b13335' : '';
}
function setDialogMessage(message, error = false) {
  $('dialog-message').textContent = message;
  $('dialog-message').style.color = error ? '#b13335' : '';
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function cameraFromRecord(record) {
  if (!record?.camera_to_world) return;
  const scale = new THREE.Vector3();
  matrix4(record.camera_to_world).decompose(pose.position, pose.quaternion, scale);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  pose.yaw = Math.atan2(forward.x, forward.y);
  pose.pitch = Math.asin(THREE.MathUtils.clamp(forward.z, -.999, .999));
  const resolution = record.image_geometry?.resolution || [1200, 800];
  const aspect = resolution[0] / resolution[1];
  const fov = record.projection === 'ORTHO' ? 60 : 2 * Math.atan((record.sensor_height_mm || 24) / (2 * (record.lens_mm || 22))) * 180 / Math.PI;
  for (const c of [cameraG, cameraB]) {
    c.fov = fov;
    c.aspect = aspect;
    c.near = record.clip_start || .05;
    c.far = record.clip_end || 300;
    c.updateProjectionMatrix();
  }
}
function updateQuaternion() {
  const forward = new THREE.Vector3(Math.sin(pose.yaw) * Math.cos(pose.pitch), Math.cos(pose.yaw) * Math.cos(pose.pitch), Math.sin(pose.pitch));
  const view = new THREE.Matrix4().lookAt(pose.position, pose.position.clone().add(forward), up);
  pose.quaternion.setFromRotationMatrix(view);
}
function applyPose() {
  for (const camera of [cameraG, cameraB]) {
    camera.position.copy(pose.position);
    camera.quaternion.copy(pose.quaternion);
    camera.updateMatrixWorld();
  }
}
function syncSize() {
  if (!rendererG || !rendererB) return;
  const width = Math.max(2, $('g-canvas').parentElement.clientWidth);
  const height = Math.max(2, Math.round(width / 1.5));
  const bw = Math.max(2, $('b-canvas').parentElement.clientWidth);
  const bh = Math.max(2, Math.round(bw / 1.5));
  rendererG.setSize(width, height, false);
  rendererB.setSize(bw, bh, false);
  cameraG.aspect = 1.5;
  cameraB.aspect = 1.5;
  cameraG.updateProjectionMatrix();
  cameraB.updateProjectionMatrix();
}
if (rendererG && rendererB) {
  new ResizeObserver(syncSize).observe($('g-canvas').parentElement);
  new ResizeObserver(syncSize).observe($('b-canvas').parentElement);
}
function tickNavigation(dt) {
  if (!data.navHot || data.frozen || $('review-dialog').classList.contains('hidden') === false) return;
  const keys = data.keys;
  if (!keys.size) return;
  const turn = 1.25 * dt;
  if (keys.has('ArrowLeft')) pose.yaw -= turn;
  if (keys.has('ArrowRight')) pose.yaw += turn;
  if (keys.has('ArrowUp')) pose.pitch = Math.min(1.45, pose.pitch + turn);
  if (keys.has('ArrowDown')) pose.pitch = Math.max(-1.45, pose.pitch - turn);
  updateQuaternion();
  const move = Number($('speed').value) * dt;
  const forward = new THREE.Vector3(Math.sin(pose.yaw), Math.cos(pose.yaw), 0);
  const right = new THREE.Vector3(forward.y, -forward.x, 0);
  if (keys.has('KeyW')) pose.position.addScaledVector(forward, move);
  if (keys.has('KeyS')) pose.position.addScaledVector(forward, -move);
  if (keys.has('KeyD')) pose.position.addScaledVector(right, move);
  if (keys.has('KeyA')) pose.position.addScaledVector(right, -move);
  if (keys.has('KeyE')) pose.position.z += move;
  if (keys.has('KeyQ')) pose.position.z -= move;
}
let previousFrame = performance.now();
let frameCounter = 0;
let fpsAt = previousFrame;
function frame(time) {
  const dt = Math.min((time - previousFrame) / 1000, .06);
  previousFrame = time;
  if (document.hidden) { requestAnimationFrame(frame); return; }
  tickNavigation(dt);
  applyPose();
  if (rendererG && rendererB && !data.captureBusy && $('review-dialog').classList.contains('hidden')) {
    rendererG.render(sceneG, cameraG);
    rendererB.render(sceneB, cameraB);
  }
  frameCounter++;
  if (time - fpsAt > 1500) {
    const fps = Math.round(frameCounter * 1000 / (time - fpsAt));
    const pending = pagerPending();
    const p = pose.position;
    const where = `x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)} · z ${p.z.toFixed(1)} · 朝向 ${THREE.MathUtils.radToDeg(pose.yaw).toFixed(0)}°`;
    $('nav-state').textContent = `${data.frozen ? '机位已冻结' : data.navHot ? '导航中' : '鼠标移入左视图导航'} · ${where} · ${fps} FPS`;
    if (data.gReady) $('g-status').textContent = pending > 0 ? `LoD 加载中 · ${pending} 页待处理` : '流式 LoD 已加载';
    frameCounter = 0;
    fpsAt = time;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
window.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (movementKeys.has(event.code) && data.navHot && !data.frozen && $('review-dialog').classList.contains('hidden')) {
    data.keys.add(event.code);
    if (!event.repeat) tickNavigation(1 / 30);
    event.preventDefault();
  }
});
window.addEventListener('keyup', (event) => data.keys.delete(event.code));
window.addEventListener('blur', () => data.keys.clear());
$('g-panel').addEventListener('mouseenter', () => { data.navHot = true; });
$('g-panel').addEventListener('mouseleave', () => { data.navHot = false; data.keys.clear(); });
$('refresh-button').onclick = () => refresh().catch((e) => setStatus(e.message, true));

function pagerPending() {
  const pager = data.gSplat?.paged?.pager;
  if (!pager) return 0;
  const missing = (pager.fetchPriority || []).filter(({ splats, chunk }) => !pager.getSplatsChunk(splats, chunk)).length;
  return missing + (pager.lodTreeUpdates?.length || 0);
}
async function waitForGaussian() {
  if (!data.gReady || !data.bReady) throw new Error('双侧显示资产尚未加载');
  await data.gSplat.initialized;
  const start = performance.now();
  let stableSince = 0;
  while (performance.now() - start < 20000) {
    const pending = pagerPending();
    if (pending === 0) {
      if (!stableSince) stableSince = performance.now();
      if (performance.now() - stableSince > 1400) return;
    } else stableSince = 0;
    await sleep(120);
  }
  throw new Error('高斯分页仍在加载；请稍后重试，不会保存缺页截图');
}
async function captureView() {
  if (data.capturePending) return;
  if (!data.gReady || !data.bReady || data.loadedVersion !== $('model-version').value) return;
  const version = data.loadedVersion;
  const model = version === 'base' ? data.state.display.B : data.state.resultModels.find(m => m.revision === version);
  data.capturePending = true;
  $('model-version').disabled = true;
  data.frozen = true;
  data.keys.clear();
  $('record-button').disabled = true;
  try {
    setStatus('等待高斯 LoD 页完成…');
    await waitForGaussian();
    data.captureBusy = true;
    const width = 1200, height = 800;
    rendererG.setPixelRatio(1); rendererB.setPixelRatio(1);
    rendererG.setSize(width, height, false); rendererB.setSize(width, height, false);
    cameraG.aspect = cameraB.aspect = width / height;
    cameraG.updateProjectionMatrix(); cameraB.updateProjectionMatrix();
    applyPose();
    rendererG.render(sceneG, cameraG);
    rendererB.render(sceneB, cameraB);
    await sleep(200);
    rendererG.render(sceneG, cameraG);
    rendererB.render(sceneB, cameraB);
    const G = rendererG.domElement.toDataURL('image/png');
    const B_before = rendererB.domElement.toDataURL('image/png');
    const camera = {
      alignment_id: data.state.manifest.alignment_id,
      coordinate_frame: 'project', camera_axes: { forward: '-Z', up: '+Y' },
      camera_to_world: matrixToRows(new THREE.Matrix4().compose(pose.position, pose.quaternion, new THREE.Vector3(1, 1, 1))),
      projection: 'PERSP', lens_mm: 22, sensor_width_mm: 36,
      sensor_height_mm: 2 * 22 * Math.tan(THREE.MathUtils.degToRad(cameraG.fov) / 2),
      sensor_fit: 'VERTICAL', shift_x: 0, shift_y: 0,
      clip_start: cameraG.near, clip_end: cameraG.far,
      image_geometry: { resolution: [width, height], resolution_percentage: 100, pixel_aspect: [1, 1] },
      render_settings: { G: { engine: 'Spark 2.2.0', asset_sha256: data.state.display.G.sha256, paged: true, pending_pages: pagerPending(), input_sh_degree: data.state.display.G.input_sh_degree ?? null, lod_splat_scale: 1, paged_ext_splats: true }, B_before: { engine: 'Three.js', asset_sha256: model.sha256, tone_mapping: 'default', exposure: 1 } },
      capture: { G: { ready: pagerPending() === 0, pending_pages: pagerPending() } },
    };
    setStatus('保存机位和双图…');
    const saved = await api('/api/views', 'POST', { camera, G, B_before, model_revision: version === 'base' ? data.state.manifest.base_revision : version });
    await refresh();
    openEditor(saved.view_id);
    setStatus(`已保存 ${saved.view_id}`);
  } catch (error) {
    setStatus(`截图失败：${error.message}`, true);
    data.frozen = false;
  } finally {
    data.captureBusy = false;
    data.capturePending = false;
    $('model-version').disabled = false;
    rendererG?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    rendererB?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    syncSize();
    $('record-button').disabled = !(data.gReady && data.bReady && data.loadedVersion === $('model-version').value);
  }
}
$('record-button').onclick = captureView;
function matrixToRows(m) {
  const e = m.elements;
  return [[e[0], e[4], e[8], e[12]], [e[1], e[5], e[9], e[13]], [e[2], e[6], e[10], e[14]], [e[3], e[7], e[11], e[15]]];
}

async function loadScenes() {
  const { display, alignment } = data.state;
  if (display.B && rendererB) {
    $('b-status').textContent = '加载 GLB…';
    try {
      await showModel($('model-version').value);
      data.bReady = true;
    } catch (error) { $('b-status').textContent = `模型失败：${error.message}`; }
  } else $('b-status').textContent = 'GLB 未准备';
  if (display.G && rendererG) {
    $('g-status').textContent = '加载 RAD…';
    try {
      data.spark = new SparkRenderer({ renderer: rendererG, lodSplatScale: 1, pagedExtSplats: true });
      sceneG.add(data.spark);
      data.gSplat = new SplatMesh({ url: display.G.url, paged: true });
      data.gSplat.applyMatrix4(matrix4(display.G.asset_to_project || alignment.G.source_to_project));
      sceneG.add(data.gSplat);
      await data.gSplat.initialized;
      data.gReady = true;
      $('g-status').textContent = '扫描索引已加载 · 等待视点分页';
    } catch (error) { $('g-status').textContent = `扫描失败：${error.message}`; }
  } else $('g-status').textContent = 'RAD 未准备';
  $('record-button').disabled = !(data.gReady && data.bReady && data.loadedVersion === $('model-version').value);
  $('asset-note').textContent = data.gReady && data.bReady
    ? '完整扫描以 LoD 分页加载；远处区域会随相机移动自动换入。冻结截图会等待当前分页稳定。'
    : '显示资产尚未齐备。请先在独立副本准备 GLB 和完整扫描 RAD，并登记到 manifest.display_assets。';
  setStatus(data.gReady && data.bReady ? '双视图可用' : '等待显示资产准备');
}

function renderModelChoices() {
  const select = $('model-version');
  const selected = data.loadedVersion === null ? data.state.activeRevision || 'base' : select.value;
  select.replaceChildren();
  const base = document.createElement('option');
  base.value = 'base'; base.textContent = `${data.state.manifest.base_revision} 基础版`;
  select.appendChild(base);
  for (const model of data.state.resultModels || []) {
    const option = document.createElement('option');
    option.value = model.revision; option.textContent = `${model.revision} 修订版`;
    select.appendChild(option);
  }
  select.value = [...select.options].some((option) => option.value === selected) ? selected : (data.state.activeRevision || 'base');
  select.disabled = data.capturePending || !data.state.display.B;
}

async function showModel(version) {
  const token = ++data.modelLoadToken;
  data.bReady = false;
  $('record-button').disabled = true;
  const model = version === 'base'
    ? { url: data.state.display.B.url, asset_to_project: data.state.display.B.asset_to_project || data.state.alignment.B.source_to_project }
    : data.state.resultModels.find((item) => item.revision === version);
  if (!model) throw new Error(`找不到 ${version} 的 GLB`);
  $('b-status').textContent = `加载 ${version === 'base' ? data.state.manifest.base_revision : version}…`;
  let root = data.modelCache.get(version);
  if (!root) {
    const gltf = await new GLTFLoader().loadAsync(model.url);
    root = gltf.scene;
    root.applyMatrix4(matrix4(model.asset_to_project || data.state.alignment.B.source_to_project));
    data.modelCache.set(version, root);
  }
  if (token !== data.modelLoadToken) return;
  data.loadedVersion = version;
  data.bReady = true;
  if (data.modelRoot) sceneB.remove(data.modelRoot);
  sceneB.add(root);
  data.modelRoot = root;
  $('b-status').textContent = `${version === 'base' ? data.state.manifest.base_revision : version} 模型已加载`;
  $('record-button').disabled = !(data.gReady && data.bReady && !data.captureBusy);
}
$('model-version').onchange = async (event) => {
  try { await showModel(event.target.value); } catch (error) { $('b-status').textContent = `模型失败：${error.message}`; }
};

function renderSidebar() {
  const issues = data.state.issues.filter((item) => !item.deleted_at);
  $('package-label').textContent = `${data.state.manifest.project_id || '项目'} · ${data.state.manifest.base_revision}`;
  $('issue-count').textContent = String(issues.length);
  const counts = Object.groupBy(issues, (i) => i.status);
  $('summary').innerHTML = `<span>待处理 ${counts.submitted?.length || 0}</span><span>草稿 ${counts.draft?.length || 0}</span><span>通过 ${counts.accepted?.length || 0}</span><span>退回 ${counts.returned?.length || 0}</span>`;
  $('view-list').innerHTML = `<div class="list-label">已存机位 · ${data.state.views.length}</div>${data.state.views.length ? data.state.views.map((v) => `<button data-view="${esc(v.view_id)}">${esc(v.view_id)} · 定位 / 新意见</button>`).join('') : '<div class="empty">暂无机位，漫游后点“记录新机位”。</div>'}`;
  $('issue-list').innerHTML = `<div class="list-label">问题列表</div>${issues.length ? issues.map((i) => `<button class="issue-card" data-issue="${esc(i.issue_id)}"><strong>${esc(i.issue_id)}</strong><small>${esc(i.status)}</small><p>${esc(i.comment)}</p></button>`).join('') : '<div class="empty">暂无意见。</div>'}`;
  for (const button of $('view-list').querySelectorAll('[data-view]')) button.onclick = () => { const id = button.dataset.view; locateView(id); openEditor(id); };
  for (const button of $('issue-list').querySelectorAll('[data-issue]')) button.onclick = () => openIssue(button.dataset.issue);
}
async function refresh() {
  data.state = await api('/api/state');
  renderSidebar();
  renderModelChoices();
  return data.state;
}
function locateView(id) {
  const view = data.state.views.find((v) => v.view_id === id);
  if (!view) return;
  cameraFromRecord(view.camera);
  data.frozen = true;
  setStatus(`已定位 ${id}`);
}

function openEditor(viewId, issue = null) {
  data.viewId = viewId;
  data.issue = issue;
  data.boxes = structuredClone(issue?.annotations || []);
  data.frozen = true;
  data.keys.clear();
  $('review-dialog').classList.remove('hidden');
  $('dialog-kicker').textContent = `${viewId} · ${data.state.views.find(v => v.view_id === viewId)?.camera.model_revision || data.state.manifest.base_revision}`;
  $('dialog-title').textContent = issue ? `编辑 ${issue.issue_id}` : '记录新问题';
  $('issue-comment').value = issue?.comment || '';
  $('issue-g-image').src = `/file/views/${encodeURIComponent(viewId)}/G.png`;
  $('issue-b-image').src = `/file/views/${encodeURIComponent(viewId)}/B_before.png`;
  $('after-column').classList.add('hidden');
  $('delete-issue').classList.toggle('hidden', !issue);
  $('accept-issue').classList.add('hidden');
  $('return-issue').classList.add('hidden');
  setDialogMessage('');
  paintBoxes();
  if (issue) loadResult(issue).catch((e) => setDialogMessage(e.message, true));
}
function closeEditor() {
  $('review-dialog').classList.add('hidden');
  data.frozen = false;
  data.keys.clear();
  data.drawing = null;
  $('nav-state').textContent = '请把鼠标放在左视图上，再开始用键盘控制相机移动';
}
function openIssue(id) {
  const issue = data.state.issues.find((item) => item.issue_id === id);
  if (!issue) return;
  locateView(issue.view_id);
  openEditor(issue.view_id, issue);
}
async function loadResult(issue) {
  const versions = (data.state.manifest.results || []).map((r) => r.revision).filter(Boolean).reverse();
  if (data.state.manifest.reserved_result?.revision) versions.push(data.state.manifest.reserved_result.revision);
  for (const revision of [...new Set(versions)]) {
    const image = `/file/results/${encodeURIComponent(revision)}/views/${encodeURIComponent(issue.view_id)}/B_after.png`;
    let result;
    try { result = await api(`/file/results/${encodeURIComponent(revision)}/responses.json`); } catch { continue; }
    if (!result.issues?.[issue.issue_id]?.response) continue;
    const response = await fetch(image, { method: 'HEAD' });
    if (!response.ok) continue;
    data.revision = revision;
    $('issue-after-image').src = image;
    $('result-revision').textContent = revision;
    $('after-column').classList.remove('hidden');
    $('accept-issue').classList.remove('hidden');
    $('return-issue').classList.remove('hidden');
    $('result-response').textContent = result.issues[issue.issue_id].response;
    return;
  }
  data.revision = null;
}
function paintBoxes() {
  for (const [source, id] of [['G', 'issue-g-overlay'], ['B_before', 'issue-b-overlay']]) {
    const svg = $(id);
    svg.replaceChildren();
    for (const box of data.boxes.filter((a) => a.source_image === source)) {
      const [x, y, w, h] = box.xywh;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x * 100); rect.setAttribute('y', y * 100);
      rect.setAttribute('width', w * 100); rect.setAttribute('height', h * 100);
      svg.appendChild(rect);
    }
  }
  $('box-count').textContent = `${data.boxes.length} 个框`;
}
function coordinates(event, svg) {
  const r = svg.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (event.clientY - r.top) / r.height))];
}
for (const [source, id] of [['G', 'issue-g-overlay'], ['B_before', 'issue-b-overlay']]) {
  const svg = $(id);
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    svg.setPointerCapture(event.pointerId);
    data.drawing = { source, start: coordinates(event, svg) };
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('draft'); svg.appendChild(rect); data.drawing.rect = rect;
  });
  svg.addEventListener('pointermove', (event) => {
    if (!data.drawing || data.drawing.source !== source) return;
    const end = coordinates(event, svg), start = data.drawing.start;
    const x = Math.min(start[0], end[0]), y = Math.min(start[1], end[1]);
    data.drawing.rect.setAttribute('x', x * 100); data.drawing.rect.setAttribute('y', y * 100);
    data.drawing.rect.setAttribute('width', Math.abs(end[0] - start[0]) * 100);
    data.drawing.rect.setAttribute('height', Math.abs(end[1] - start[1]) * 100);
  });
  svg.addEventListener('pointerup', (event) => {
    if (!data.drawing || data.drawing.source !== source) return;
    const end = coordinates(event, svg), start = data.drawing.start;
    const x = Math.min(start[0], end[0]), y = Math.min(start[1], end[1]);
    const w = Math.abs(end[0] - start[0]), h = Math.abs(end[1] - start[1]);
    if (w > .002 && h > .002) data.boxes.push({ source_image: source, xywh: [x, y, w, h] });
    data.drawing = null;
    paintBoxes();
  });
}
$('remove-box').onclick = () => { data.boxes.pop(); paintBoxes(); };
$('close-dialog').onclick = () => { closeEditor(); setStatus('请把鼠标放在左视图上，再开始用键盘控制相机移动'); };
$('new-at-view').onclick = () => openEditor(data.viewId);
const quickPhrases = [
  '框选区域细节缺失',
  '框选区域物体朝向错误',
  '框选区域细节有误',
  '框选区域建模 LoD 提一层',
];
function appendQuickPhrase(index) {
  if ($('review-dialog').classList.contains('hidden')) return;
  const textarea = $('issue-comment');
  const current = textarea.value;
  textarea.value = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${quickPhrases[index]}`;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
for (const button of document.querySelectorAll('[data-phrase]')) {
  button.onclick = () => appendQuickPhrase(Number(button.dataset.phrase) - 1);
}
window.addEventListener('keydown', (event) => {
  if ($('review-dialog').classList.contains('hidden') || !event.altKey || event.ctrlKey || event.metaKey) return;
  const match = /^Digit([1-4])$/.exec(event.code);
  if (!match) return;
  event.preventDefault();
  appendQuickPhrase(Number(match[1]) - 1);
});
async function saveIssue(submit) {
  if (data.savingIssue) return;
  data.savingIssue = true;
  $('save-draft').disabled = $('submit-issue').disabled = true;
  try {
    const issue = await api('/api/issues', 'POST', { view_id: data.viewId, issue_id: data.issue?.issue_id, comment: $('issue-comment').value, annotations: data.boxes, submit });
    closeEditor();
    setStatus(`${submit ? '意见已提交' : '草稿已保存'}：${issue.issue_id}。请把鼠标放在左视图上继续漫游。`);
    try { await refresh(); } catch (error) { setStatus(`意见已保存，但列表刷新失败：${error.message}`, true); }
  } catch (error) { setDialogMessage(error.message, true); }
  finally {
    data.savingIssue = false;
    $('save-draft').disabled = $('submit-issue').disabled = false;
  }
}
$('save-draft').onclick = () => saveIssue(false);
$('submit-issue').onclick = () => saveIssue(true);
$('delete-issue').onclick = async () => {
  if (!data.issue || !confirm(`删除 ${data.issue.issue_id}？记录会保留删除历史。`)) return;
  try { await api(`/api/issues/${data.issue.issue_id}`, 'DELETE'); await refresh(); closeEditor(); setStatus('意见已删除，请把鼠标放在左视图上继续漫游。'); } catch (error) { setDialogMessage(error.message, true); }
};
for (const [id, status] of [['accept-issue', 'accepted'], ['return-issue', 'returned']]) $(id).onclick = async () => {
  try {
    await api(`/api/issues/${data.issue.issue_id}/review`, 'POST', { status, result_revision: data.revision });
    await refresh(); openIssue(data.issue.issue_id);
    setDialogMessage(status === 'accepted' ? '已人工确认通过' : '已退回继续修改');
  } catch (error) { setDialogMessage(error.message, true); }
};

async function start() {
  await refresh();
  cameraFromRecord(data.state.homeCamera || data.state.views?.[0]?.camera);
  const params = new URLSearchParams(location.search);
  const position = ['x', 'y', 'z'].map((key) => Number(params.get(key)));
  if (['x', 'y', 'z'].every((key) => params.has(key)) && position.every((value) => Number.isFinite(value) && Math.abs(value) < 1000)) {
    pose.position.set(...position);
  }
  if (params.has('yaw') || params.has('pitch')) {
    const yaw = Number(params.get('yaw') || 0), pitch = Number(params.get('pitch') || 0);
    if (Number.isFinite(yaw) && Number.isFinite(pitch) && Math.abs(yaw) <= 360 && Math.abs(pitch) <= 85) {
      pose.yaw = THREE.MathUtils.degToRad(yaw);
      pose.pitch = THREE.MathUtils.degToRad(pitch);
      updateQuaternion();
    }
  }
  applyPose();
  syncSize();
  await loadScenes();
}
start().catch((error) => setStatus(`打开审阅包失败：${error.message}`, true));
