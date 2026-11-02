import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileTour,
  normalizeTour,
  quaternionFromAngles as q,
  anglesFromQuaternion,
  exportLimitMessage,
} from "../lib/tour/core.mjs";
import { renderTourJob } from "../lib/tour/render-job.mjs";
const point = (id, position, yaw = 0, extra = {}) => ({
  id,
  position,
  quaternion: q(yaw, 0),
  ...extra,
});
const route = (points) => ({
  schema_version: 1,
  alignment_id: "test",
  coordinate_frame: "project",
  world_up: "+Z",
  points,
});

test("deterministic 25fps frames include exact endpoints and shared camera convention", () => {
  const r = route([point("a", [0, 0, 1]), point("b", [0, 30, 1])]);
  const c = compileTour(r),
    frames = c.frames();
  assert.deepEqual(frames, compileTour(r).frames());
  assert.deepEqual(frames[0].position, [0, 0, 1]);
  assert.deepEqual(frames.at(-1).position, [0, 30, 1]);
  assert.equal(c.duration, frames.length / 25);
  assert.equal(frames[10].timestamp_us, 400000);
  assert.deepEqual(
    frames[0].camera_to_world.map((row) => row[3]),
    [0, 0, 1, 1],
  );
  assert.ok(c.metrics.max_speed <= 3.02);
  assert.ok(c.metrics.max_acceleration <= 1.53);
  const middle = frames.slice(
    Math.floor(frames.length * 0.4),
    Math.floor(frames.length * 0.6),
  );
  const steps = middle
    .slice(1)
    .map((f, i) =>
      Math.hypot(...f.position.map((v, j) => v - middle[i].position[j])),
    );
  assert.ok(
    Math.max(...steps) / Math.min(...steps) < 1.05,
    "arc length speed remains steady on a straight section",
  );
});
test("yaw crosses ±180 via short arc, locked points are respected and no roll is introduced", () => {
  const c = compileTour(
    route([
      point("a", [0, 0, 2], (179 * Math.PI) / 180),
      point("b", [0, 5, 2], (-179 * Math.PI) / 180),
    ]),
  );
  const mid = c.sample(c.motion_duration / 2);
  assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.02);
  for (const yaw of [0, 1, -2, Math.PI]) {
    const a = anglesFromQuaternion(q(yaw, 0.4));
    assert.ok(Math.abs(a.yaw - yaw) < 1e-10);
    assert.ok(Math.abs(a.pitch - 0.4) < 1e-10);
  }
});
test("unlocked orientation is not a key; hold and stationary turns work", () => {
  const r = route([
    point("a", [0, 0, 1], 0, { hold: 1 }),
    point("b", [0, 0, 1], Math.PI / 2),
    point("c", [5, 0, 1], Math.PI / 2, { hold: 1 }),
  ]);
  const c = compileTour(r);
  assert.deepEqual(c.sample(0.5).position, [0, 0, 1]);
  assert.ok(c.metrics.max_turn_rate <= 35.1);
  const key = c.key_times[1];
  assert.ok(Math.abs(c.sample(key.time).yaw - Math.PI / 2) < 1e-8);
  r.points[1].lock_orientation = false;
  r.points[2].quaternion = q(0, 0);
  const u = compileTour(r);
  assert.ok(Math.abs(u.sample(u.key_times[1].time).yaw) < 1e-8);
});
test("curved path limits physical acceleration and can be slowed to target duration", () => {
  const r = route([
    point("a", [0, 0, 1]),
    point("b", [0, 10, 1], Math.PI / 2),
    point("c", [10, 10, 1], Math.PI),
  ]);
  const c = compileTour(r);
  assert.ok(c.metrics.max_acceleration <= 1.53);
  assert.ok(c.metrics.max_speed <= 3.02);
  assert.ok(c.metrics.max_turn_rate <= 35.1);
  for (const k of c.key_times) {
    const p = r.points.find((p) => p.id === k.point_id);
    assert.ok(
      Math.hypot(
        ...c.sample(k.time).position.map((x, j) => x - p.position[j]),
      ) < 1e-7,
    );
  }
  const slowed = compileTour({
    ...r,
    settings: { duration: c.motion_duration + 5 },
  });
  assert.ok(slowed.duration > c.duration + 4.9);
  assert.throws(
    () => compileTour({ ...r, settings: { duration: 1 } }),
    /时长过短/,
  );
});
test("bad formats, coordinates, infinities and no-motion routes are rejected", () => {
  const r = route([point("a", [0, 0, 1]), point("b", [0, 1, 1])]);
  assert.throws(() => normalizeTour(r, { alignmentId: "another" }), /坐标版本/);
  assert.throws(
    () =>
      compileTour({
        ...r,
        points: [point("a", [0, 0, 1]), point("b", [0, 0, 1])],
      }),
    /没有位置/,
  );
  assert.throws(
    () => compileTour({ ...r, settings: { speed: NaN } }),
    /巡航速度/,
  );
  assert.throws(
    () =>
      compileTour({
        ...r,
        points: [point("a", [NaN, 0, 1]), point("b", [0, 1, 1])],
      }),
    /位置/,
  );
});
test("uneven curved paths still satisfy limits after frame quantization", () => {
  let seed = 4;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let k = 0; k < 8; k++) {
    const points = Array.from(
      { length: 3 + Math.floor(random() * 4) },
      (_, i) => ({
        ...point(`P${i}`, [random() * 15, random() * 15, random() * 3]),
        quaternion: q((random() - 0.5) * 6, (random() - 0.5) * 2),
        hold: random() > 0.9 ? 0.5 : 0,
      }),
    );
    const { metrics: m } = compileTour(route(points));
    assert.ok(m.max_speed <= 3.03);
    assert.ok(m.max_acceleration <= 1.53);
    assert.ok(m.max_turn_rate <= 35.35);
  }
});
test("33-point loop stays locally smooth without inflating to a 24-minute tour", () => {
  const input = JSON.parse(
    readFileSync(
      new URL("./fixtures/tour-33-loop.json", import.meta.url),
      "utf8",
    ),
  );
  const c = compileTour(input);
  assert.equal(c.key_times.length, 33);
  assert.ok(
    c.duration > 120 && c.duration < 300,
    `unexpected duration ${c.duration}`,
  );
  assert.equal(exportLimitMessage(c), null);
  assert.ok(c.metrics.max_acceleration <= 1.5 * 1.005);
  for (const key of c.key_times) {
    const original = input.points.find((p) => p.id === key.point_id),
      p = c.sample(key.time);
    assert.ok(
      Math.hypot(...p.position.map((v, j) => v - original.position[j])) < 1e-8,
    );
    const alignment = Math.abs(
      p.quaternion.reduce((sum, v, j) => sum + v * original.quaternion[j], 0),
    );
    assert.ok(alignment > 1 - 1e-10);
  }
  const slower = compileTour({
    ...input,
    settings: { ...input.settings, speed: 3 },
  });
  assert.ok(
    slower.duration >= c.duration,
    "raising the speed limit must not slow the route",
  );
});
test("long-route preview is available independently of the video export cap", () => {
  const c = compileTour(
    route([point("a", [0, 0, 1]), point("b", [0, 2100, 1])]),
  );
  assert.ok(c.duration > 600);
  assert.match(exportLimitMessage(c), /预览可用.*导出暂限 10 分钟/);
  assert.ok(c.sample(620).position.every(Number.isFinite));
});
test("coincident points retain hold/key order without phantom quaternion distance", () => {
  const same = q(1, 0.3),
    a = { id: "a", position: [0, 0, 1], quaternion: same },
    b = { ...a, id: "b" };
  assert.throws(() => compileTour(route([a, b])), /没有位置/);
  const c = compileTour(
    route([a, { ...b, hold: 1 }, { ...a, id: "c", position: [0, 10, 1] }]),
  );
  assert.deepEqual(
    c.key_times.map((k) => k.point_id),
    ["a", "b", "c"],
  );
  assert.deepEqual(c.sample(0.5).position, [0, 0, 1]);
});
test("render orchestrator supplies identical frames to each version and restores on failure", async () => {
  const job = { tracks: [{ id: "G" }, { id: "B" }], frame_count: 2 },
    frames = [
      { index: 0, timestamp_us: 0 },
      { index: 1, timestamp_us: 40000 },
    ];
  const seen = [];
  let ended = false,
    finished = false;
  const adapter = {
    begin: async () => {},
    render: async (t, f) => {
      seen.push([t.id, f]);
      return { blob: "png", meta: { ready: true } };
    },
    end: async () => {
      ended = true;
    },
  };
  await renderTourJob({
    job,
    frames,
    adapter,
    upload: async () => {},
    finish: async () => {
      finished = true;
    },
  });
  assert.equal(seen[0][1], seen[2][1]);
  assert.equal(seen[1][1], seen[3][1]);
  assert.ok(ended && finished);
  ended = finished = false;
  adapter.render = async () => {
    throw new Error("missing page");
  };
  await assert.rejects(
    renderTourJob({
      job,
      frames,
      adapter,
      upload: async () => {},
      finish: async () => {
        finished = true;
      },
    }),
    /missing page/,
  );
  assert.ok(ended && !finished);
});

test("render resumes at each track's persisted count without replacing existing frames", async () => {
  const frames = [0, 1, 2].map(index => ({ index, timestamp_us: index * 40000 }));
  const job = { tracks: [{ id: "G" }, { id: "B" }], frame_count: 3, received: { G: 2, B: 0 } };
  const rendered = [], uploaded = [];
  let ended = false, finished = false;
  const adapter = {
    begin: async () => {},
    render: async (track, frame) => { rendered.push([track.id, frame.index]); return { blob: "png", meta: {} }; },
    end: async () => { ended = true; },
  };
  await renderTourJob({ job, frames, adapter,
    upload: async (track, index) => uploaded.push([track.id, index]),
    finish: async () => { finished = true; } });
  assert.deepEqual(rendered, [["G", 2], ["B", 0], ["B", 1], ["B", 2]]);
  assert.deepEqual(uploaded, rendered);
  assert.ok(ended && finished);
  await assert.rejects(renderTourJob({ job: { ...job, received: { G: 4 } }, frames, adapter }), /已采集帧数无效/);
});
