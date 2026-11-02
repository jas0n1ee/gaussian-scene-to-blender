import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { anglesFromQuaternion } from "../lib/tour/core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortCheck = (signal) => {
  if (signal?.aborted) throw new Error("已取消");
};
const png = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法读取画面"))),
      "image/png",
    ),
  );

// Review is only one host adapter. The core and export store do not import it.
export function createTourRenderAdapter({
  data,
  pose,
  sceneG,
  sceneB,
  cameraG,
  cameraB,
  rendererG,
  rendererB,
  applyPose,
  syncSize,
  showModel,
}) {
  let saved = null,
    lastTrack = null;
  const modelCache = new Map();
  function setPose(p) {
    pose.position.fromArray(p.position);
    pose.quaternion.fromArray(p.quaternion);
    const a = anglesFromQuaternion(p.quaternion);
    pose.yaw = a.yaw;
    pose.pitch = a.pitch;
    for (const c of [cameraG, cameraB]) {
      if (p.fov) c.fov = p.fov;
      c.updateProjectionMatrix();
    }
    applyPose();
  }
  function snapshot() {
    return {
      position: pose.position.toArray(),
      quaternion: pose.quaternion.toArray(),
      fov: cameraG.fov,
    };
  }
  function gaussianStatus() {
    const s = data.spark,
      p = data.gSplat?.paged?.pager;
    const missing = p
      ? (p.fetchPriority || []).filter(
          ({ splats, chunk }) => !p.getSplatsChunk(splats, chunk),
        ).length
      : 0;
    const pending = missing + (p?.lodTreeUpdates?.length || 0);
    return {
      pending_pages: pending,
      sorting: !!s?.sorting,
      lod_pending: !!(
        s?.lodDirty ||
        s?.lodInitQueue?.length ||
        s?.lodUpdates?.length ||
        (s?.lodWorker?.queue !== null && s?.lodWorker?.queue !== undefined)
      ),
      splats: s?.activeSplats || 0,
    };
  }
  async function waitGaussian(signal) {
    const s = data.spark,
      start = performance.now();
    let stable = 0,
      signature = "";
    while (performance.now() - start < 90000) {
      abortCheck(signal);
      if (s.sorting) {
        await sleep(10);
        continue;
      }
      // Freeze the simulation clock, but keep driving the renderer's asynchronous
      // page -> LoD -> mapping -> depth sort pipeline at this exact camera.
      await s.update({ scene: sceneG, camera: cameraG });
      if (s.lodWorker) await s.lodWorker.exclusive(async () => {});
      rendererG.render(sceneG, cameraG);
      const status = gaussianStatus(),
        key = JSON.stringify([
          status.splats,
          s.current?.mappingVersion,
          s.display?.mappingVersion,
          s.currentLod?.timestamp,
        ]);
      const ready =
        status.pending_pages === 0 &&
        !status.sorting &&
        !status.lod_pending &&
        s.current?.mappingVersion === s.display?.mappingVersion &&
        !!s.currentLod;
      if (ready && key === signature) stable++;
      else stable = 0;
      signature = key;
      if (stable >= 2) {
        return { ...status, ready: true };
      }
      await sleep(status.pending_pages ? 25 : 5);
    }
    throw new Error("高斯分页或排序在 90 秒内未就绪；任务未生成缺页视频");
  }
  async function begin(job) {
    if (saved) throw new Error("已有导出任务");
    saved = {
      pose: snapshot(),
      version: data.loadedVersion,
      autoUpdate: data.spark.autoUpdate,
      minSortIntervalMs: data.spark.minSortIntervalMs,
      near: cameraG.near,
      far: cameraG.far,
    };
    data.captureBusy = true;
    data.frozen = true;
    data.keys.clear();
    data.tourExport = true;
    lastTrack = null;
    // An earlier live navigation update can still have a pending GPU readback.
    const start = performance.now();
    while (data.spark.sorting) {
      if (performance.now() - start > 30000)
        throw new Error("等待实时排序超时");
      await sleep(10);
    }
    data.spark.autoUpdate = false;
    data.spark.minSortIntervalMs = 0;
    for (const r of [rendererG, rendererB]) {
      r.setPixelRatio(1);
      r.setSize(job.width, job.height, false);
    }
    for (const c of [cameraG, cameraB]) {
      c.aspect = job.width / job.height;
      c.near = 0.05;
      c.far = 1000;
      c.updateProjectionMatrix();
    }
    rendererG.render(sceneG, cameraG);
  }
  async function render(track, frame, { signal } = {}) {
    abortCheck(signal);
    setPose(frame);
    if (track.id === "G") {
      const status = await waitGaussian(signal);
      rendererG.render(sceneG, cameraG);
      return { blob: await png(rendererG.domElement), meta: status };
    }
    if (track.id !== lastTrack) {
      let model = modelCache.get(track.id);
      if (!model) {
        const gltf = await new GLTFLoader().loadAsync(track.url);
        model = gltf.scene;
        model.applyMatrix4(
          new THREE.Matrix4().set(...track.asset_to_project.flat()),
        );
        modelCache.set(track.id, model);
      }
      if (data.modelRoot) sceneB.remove(data.modelRoot);
      sceneB.add(model);
      data.modelRoot = model;
      lastTrack = track.id;
    }
    rendererB.render(sceneB, cameraB);
    return { blob: await png(rendererB.domElement), meta: { ready: true } };
  }
  async function end() {
    if (!saved) return;
    const old = saved;
    saved = null;
    lastTrack = null;
    data.spark.autoUpdate = old.autoUpdate;
    data.spark.minSortIntervalMs = old.minSortIntervalMs;
    data.tourExport = false;
    data.captureBusy = false;
    data.frozen = false;
    for (const c of [cameraG, cameraB]) {
      c.near = old.near;
      c.far = old.far;
    }
    setPose(old.pose);
    for (const r of [rendererG, rendererB])
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    await showModel(old.version);
    syncSize();
  }
  return {
    snapshot,
    navigationSpeed: (value) => {
      document.getElementById("speed").value = String(value);
    },
    setPose,
    begin,
    render,
    end,
    ready: () => data.gReady && data.bReady && !data.capturePending,
    freeze: (value) => {
      data.frozen = value;
      data.keys.clear();
    },
    thumbnail: () => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      rendererG.render(sceneG, cameraG);
      canvas.getContext("2d").drawImage(rendererG.domElement, 0, 0, 160, 90);
      return canvas.toDataURL("image/jpeg", 0.65);
    },
    aspect: (value) => {
      data.tourAspect = value;
      document.body.classList.toggle("tour-mode", !!value);
      syncSize();
    },
  };
}
