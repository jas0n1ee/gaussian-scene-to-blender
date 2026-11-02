import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TourStore } from "../lib/tour/store.mjs";
import { quaternionFromAngles as q } from "../lib/tour/core.mjs";
import { runProcess } from "../lib/tour/encoder.mjs";

test("route persistence, strict frame matching, actual MP4 encode and 25fps probe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "camera-tour-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracks = [
    {
      id: "G",
      label: "3DGS",
      kind: "gaussian",
      sha256: "g_hash",
      display_sh_degree: 0,
    },
    { id: "B_base", label: "LOD0", kind: "model", sha256: "b_hash" },
  ];
  const store = new TourStore({
    directory: root,
    alignmentId: "a",
    resolveTracks: async () => tracks,
  });
  assert.equal(
    (await store.capabilities()).ready,
    true,
    "FFmpeg / libx264 must be available for integration test",
  );
  const tour = {
    schema_version: 1,
    coordinate_frame: "project",
    world_up: "+Z",
    alignment_id: "a",
    settings: { speed: 5, acceleration: 5 },
    points: [
      { id: "a", position: [0, 0, 0], quaternion: q(0, 0) },
      { id: "b", position: [0, 0.05, 0], quaternion: q(0, 0) },
    ],
  };
  const saved = await store.saveRoute("route", tour);
  assert.equal((await store.route("route")).sha256, saved.sha256);
  await assert.rejects(
    store.createJob({
      route_id: "route",
      route_sha256: "old",
      track_ids: ["G"],
      resolution: [640, 360],
    }),
    /路线已发生变化/,
  );
  const j = await store.createJob({
    route_id: "route",
    route_sha256: saved.sha256,
    track_ids: ["G", "B_base"],
    resolution: [640, 360],
  });
  await assert.rejects(store.finish(j.id), /尚未采集完整/);
  const png = path.join(root, "sample.png");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=640x360",
    "-frames:v",
    "1",
    png,
  ]);
  const bytes = await fs.readFile(png),
    frames = await store.frames(j.id);
  const meta = (track, i) => ({
    asset_sha256: track.sha256,
    timestamp_us: frames[i].timestamp_us,
    camera_to_world: frames[i].camera_to_world,
    fov: frames[i].fov,
    ready: true,
    pending_pages: 0,
    sorting: false,
    lod_pending: false,
  });
  await assert.rejects(
    store.saveFrame(j.id, "G", 0, bytes, {
      ...meta(tracks[0], 0),
      sorting: true,
    }),
    /尚未就绪/,
  );
  await assert.rejects(
    store.saveFrame(j.id, "G", 0, bytes, {
      ...meta(tracks[0], 0),
      timestamp_us: 1,
    }),
    /帧相机/,
  );
  for (const tr of tracks)
    for (let i = 0; i < j.frame_count; i++)
      await store.saveFrame(j.id, tr.id, i, bytes, meta(tr, i));
  await assert.rejects(
    store.saveFrame(j.id, "G", 0, bytes, meta(tracks[0], 0)),
    /不连续/,
  );
  await store.finish(j.id);
  for (let i = 0; i < 200; i++) {
    if ((await store.job(j.id)).status !== "encoding") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = await store.job(j.id);
  assert.equal(done.status, "complete", done.error);
  assert.equal(done.outputs.length, 3);
  for (const o of done.outputs) {
    assert.equal(o.fps, 25);
    assert.equal(o.frames, j.frame_count);
    assert.equal(o.duration, j.frame_count / 25);
    await fs.stat(await store.publicFile(j.id, o.file));
  }
  await assert.rejects(store.publicFile(j.id, "../../secret"), /不属于/);
  const cancelled = await store.createJob({
    route_id: "route",
    route_sha256: saved.sha256,
    track_ids: ["G"],
    resolution: [640, 360],
  });
  await store.saveFrame(cancelled.id, "G", 0, bytes, meta(tracks[0], 0));
  await assert.rejects(store.resume(cancelled.id), /只有已停止/);
  await store.cancel(cancelled.id);
  await assert.rejects(
    store.saveFrame(cancelled.id, "G", 0, bytes, meta(tracks[0], 0)),
    /停止接收/,
  );
  const framePath = path.join(store.jobDir(cancelled.id), "frames", "G", "000000.png");
  tracks[0].sha256 = "changed";
  await assert.rejects(store.resume(cancelled.id), /显示资产或坐标已改变/);
  tracks[0].sha256 = "g_hash";
  await fs.writeFile(framePath, Buffer.alloc(bytes.length));
  await assert.rejects(store.resume(cancelled.id), /帧文件已改变/);
  assert.equal((await store.job(cancelled.id)).status, "cancelled");
  await fs.writeFile(framePath, bytes);
  const framesPath = path.join(store.jobDir(cancelled.id), "frames.json"), frozenFrames = await fs.readFile(framesPath);
  await fs.writeFile(framesPath, "[]");
  await assert.rejects(store.resume(cancelled.id), /冻结路线或相机表已改变/);
  await fs.writeFile(framesPath, frozenFrames);
  const resumed = await store.resume(cancelled.id);
  assert.equal(resumed.status, "capturing");
  assert.equal(resumed.received.G, 1);
  assert.equal(resumed.resume_count, 1);
  assert.deepEqual(await fs.readFile(framePath), bytes);
  assert.deepEqual(await fs.readFile(framesPath), frozenFrames);
  await store.saveFrame(cancelled.id, "G", 1, bytes, meta(tracks[0], 1));
  await store.cancel(cancelled.id);
  assert.equal((await store.list()).routes.length, 1);
  await store.close();
});

test("export service independently enforces its frame budget without creating a partial job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tour-export-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TourStore({
    directory: root,
    alignmentId: "a",
    resolveTracks: async () => [{ id: "G", sha256: "g" }],
  });
  store.capability = { ready: true };
  const route = {
    schema_version: 1,
    alignment_id: "a",
    coordinate_frame: "project",
    world_up: "+Z",
    points: [
      { id: "a", position: [0, 0, 1], quaternion: q(0, 0) },
      { id: "b", position: [0, 2100, 1], quaternion: q(0, 0) },
    ],
  };
  const saved = await store.saveRoute("long", route);
  await assert.rejects(
    store.createJob({
      route_id: "long",
      route_sha256: saved.sha256,
      track_ids: ["G"],
      resolution: [640, 360],
    }),
    /预览可用.*导出暂限 10 分钟/,
  );
  assert.equal(
    await fs
      .stat(path.join(root, "exports"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});
