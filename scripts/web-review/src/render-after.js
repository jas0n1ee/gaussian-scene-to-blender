import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const params = new URLSearchParams(location.search);
const revision = params.get('revision');
const view = params.get('view');
if (!/^[A-Za-z0-9_-]+$/.test(revision || '') || !/^V\d+$/.test(view || '')) throw new Error('结果版本或机位无效');
const get = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};
try {
  const [cameraRecord, state] = await Promise.all([get(`/file/views/${view}/camera.json`), get('/api/state')]);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e8ebe6');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6c756e, 2.3));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(-5, -6, 12); scene.add(light);
  const image = cameraRecord.image_geometry?.resolution || [1200, 800];
  const fov = 2 * Math.atan((cameraRecord.sensor_height_mm || 24) / (2 * (cameraRecord.lens_mm || 22))) * 180 / Math.PI;
  const camera = new THREE.PerspectiveCamera(fov, image[0] / image[1], cameraRecord.clip_start || .05, cameraRecord.clip_end || 300);
  const matrix = new THREE.Matrix4().set(...cameraRecord.camera_to_world.flat());
  matrix.decompose(camera.position, camera.quaternion, new THREE.Vector3());
  camera.updateMatrixWorld();
  let transform = state.display.B.asset_to_project;
  try { transform = (await get(`/file/results/${revision}/B_${revision}.export.json`)).asset_to_project || transform; } catch { /* use base export convention */ }
  const gltf = await new GLTFLoader().loadAsync(`/file/results/${revision}/B_${revision}.glb`);
  gltf.scene.applyMatrix4(new THREE.Matrix4().set(...transform.flat()));
  scene.add(gltf.scene);
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('result'), antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(image[0], image[1], false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.render(scene, camera);
  window.__renderReady = true;
} catch (error) {
  window.__renderError = error.message;
}
