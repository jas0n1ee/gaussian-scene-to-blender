// Renderer-independent camera tour format and deterministic 25 Hz compiler.
// Coordinates: project XYZ, world +Z up, camera -Z forward / +Y up.
export const TOUR_SCHEMA = 1;
export const FPS = 25;
export const MAX_EXPORT_FRAMES = 15000;
const MAX_PREVIEW_SECONDS = 3600;
export const DEFAULT_SETTINGS = Object.freeze({
  speed: 3,
  acceleration: 1.5,
  turnRate: 35,
  smoothness: 0.65,
  duration: null,
  fov: 60,
});
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const len = (v) => Math.hypot(...v);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dist = (a, b) => len(sub(a, b));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const finite = (n, lo, hi, label) => {
  if (!Number.isFinite(n) || n < lo || n > hi)
    throw new Error(`${label} 超出范围 ${lo}–${hi}`);
  return n;
};
const vector = (v, n, label) => {
  if (
    !Array.isArray(v) ||
    v.length !== n ||
    v.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e8)
  )
    throw new Error(`${label} 无效`);
  return [...v];
};

export function anglesFromQuaternion(q) {
  const [x, y, z, w] = q;
  const forward = [
    -2 * (x * z + y * w),
    2 * (x * w - y * z),
    2 * (x * x + y * y) - 1,
  ];
  return {
    yaw: Math.atan2(forward[0], forward[1]),
    pitch: Math.asin(clamp(forward[2], -1, 1)),
  };
}
export function quaternionFromAngles(yaw, pitch) {
  const a = (Math.PI / 2 + pitch) / 2,
    b = -yaw / 2;
  return [
    Math.sin(a) * Math.cos(b),
    Math.sin(a) * Math.sin(b),
    Math.cos(a) * Math.sin(b),
    Math.cos(a) * Math.cos(b),
  ];
}
export function cameraMatrix(position, q) {
  const [x, y, z, w] = q;
  return [
    [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      position[0],
    ],
    [
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      position[1],
    ],
    [
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
      position[2],
    ],
    [0, 0, 0, 1],
  ];
}
const quatAngle = (a, b) => 2 * Math.acos(clamp(Math.abs(dot(a, b)), 0, 1));

export function normalizeTour(
  input,
  { alignmentId = null, requirePath = false } = {},
) {
  if (input?.schema_version !== TOUR_SCHEMA)
    throw new Error("不支持的路线文件版本");
  if (input.coordinate_frame !== "project" || input.world_up !== "+Z")
    throw new Error("路线坐标须为 project / +Z");
  if (
    typeof input.alignment_id !== "string" ||
    !input.alignment_id ||
    (alignmentId && input.alignment_id !== alignmentId)
  )
    throw new Error("路线与当前场景坐标版本不匹配");
  if (
    !Array.isArray(input.points) ||
    input.points.length > 100 ||
    (requirePath && input.points.length < 2)
  )
    throw new Error("路线需要 2–100 个机位");
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  finite(settings.speed, 0.05, 100, "巡航速度");
  finite(settings.acceleration, 0.05, 50, "加速度");
  finite(settings.turnRate, 1, 180, "转头速度");
  finite(settings.smoothness, 0, 1, "路径平滑程度");
  finite(settings.fov, 15, 110, "视角");
  if (settings.duration !== null)
    finite(settings.duration, 0.08, MAX_PREVIEW_SECONDS, "目标时长");
  const ids = new Set();
  const points = input.points.map((p, i) => {
    if (
      typeof p.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(p.id) ||
      ids.has(p.id)
    )
      throw new Error("机位 ID 无效或重复");
    ids.add(p.id);
    const q = vector(p.quaternion, 4, "朝向");
    const norm = len(q);
    if (norm < 0.9 || norm > 1.1) throw new Error("朝向四元数未归一化");
    const hold = finite(p.hold ?? 0, 0, 60, "停留时间");
    const thumbnail =
      typeof p.thumbnail === "string" &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.thumbnail) &&
      p.thumbnail.length < 80000
        ? p.thumbnail
        : null;
    return {
      id: p.id,
      name: String(p.name || `机位 ${i + 1}`).slice(0, 80),
      position: vector(p.position, 3, "位置"),
      quaternion: q.map((v) => v / norm),
      lock_orientation: p.lock_orientation !== false,
      hold,
      ...(thumbnail ? { thumbnail } : {}),
    };
  });
  return {
    schema_version: TOUR_SCHEMA,
    name: String(input.name || "未命名路线").slice(0, 100),
    alignment_id: input.alignment_id,
    coordinate_frame: "project",
    world_up: "+Z",
    camera_axes: { forward: "-Z", up: "+Y" },
    units: "scene_units",
    settings,
    points,
  };
}

// Shape-preserving angular interpolation: unwrap yaw first; no pitch overshoot.
function angularCurve(keys) {
  const slopes = keys
    .slice(1)
    .map((k, i) => (k.v - keys[i].v) / (k.u - keys[i].u));
  const tangents = keys.map((_, i) => {
    if (i === 0 || i === keys.length - 1) return 0;
    const a = slopes[i - 1],
      b = slopes[i];
    if (a * b <= 0) return 0;
    const h0 = keys[i].u - keys[i - 1].u,
      h1 = keys[i + 1].u - keys[i].u;
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
  });
  return (u) => {
    if (u <= keys[0].u) return keys[0].v;
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].u < u) i++;
    if (u >= keys.at(-1).u) return keys.at(-1).v;
    const h = keys[i + 1].u - keys[i].u,
      t = (u - keys[i].u) / h;
    return hermite(
      keys[i].v,
      keys[i + 1].v,
      tangents[i] * h,
      tangents[i + 1] * h,
      t,
    );
  };
}
const hermite = (a, b, m0, m1, t) =>
  (2 * t * t * t - 3 * t * t + 1) * a +
  (t * t * t - 2 * t * t + t) * m0 +
  (-2 * t * t * t + 3 * t * t) * b +
  (t * t * t - t * t) * m1;

function geometry(tour) {
  const { points, settings } = tour;
  let anchors = points
    .map((p, i) => ({
      ...anglesFromQuaternion(p.quaternion),
      u: i,
      locked: p.lock_orientation,
    }))
    .filter((a) => a.locked);
  if (!anchors.length)
    anchors = [{ ...anglesFromQuaternion(points[0].quaternion), u: 0 }];
  for (let i = 1; i < anchors.length; i++) {
    while (anchors[i].yaw - anchors[i - 1].yaw > Math.PI)
      anchors[i].yaw -= 2 * Math.PI;
    while (anchors[i].yaw - anchors[i - 1].yaw < -Math.PI)
      anchors[i].yaw += 2 * Math.PI;
  }
  const yawAt = angularCurve(anchors.map((a) => ({ u: a.u, v: a.yaw })));
  const pitchAt = angularCurve(anchors.map((a) => ({ u: a.u, v: a.pitch })));
  const tangent = (i) => {
    if (!i || i === points.length - 1 || points[i].hold > 0) return [0, 0, 0];
    const a = points[i - 1].position,
      b = points[i].position,
      c = points[i + 1].position;
    const da = dist(a, b),
      db = dist(b, c);
    if (Math.min(da, db) < 1e-7) return [0, 0, 0];
    // A bounded cardinal tangent prevents large swings from uneven point spacing.
    const v = sub(c, a),
      scale =
        Math.min(1, (2 * Math.min(da, db)) / Math.max(len(v), 1e-8)) *
        settings.smoothness *
        0.5;
    return v.map((x) => x * scale);
  };
  const nodes = [];
  const steps = 160;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].position,
      b = points[i + 1].position,
      m0 = tangent(i),
      m1 = tangent(i + 1);
    for (let k = 0; k < steps; k++) {
      const f = k / steps,
        u = i + f;
      nodes.push({
        u,
        position: a.map((x, j) => hermite(x, b[j], m0[j], m1[j], f)),
        yaw: yawAt(u),
        pitch: pitchAt(u),
        key: k === 0 ? i : null,
      });
    }
  }
  const u = points.length - 1;
  nodes.push({
    u,
    position: [...points.at(-1).position],
    yaw: yawAt(u),
    pitch: pitchAt(u),
    key: u,
  });
  for (const n of nodes) n.quaternion = quaternionFromAngles(n.yaw, n.pitch);
  return nodes;
}

// Interpolate on the distance axis with shared C1 derivatives. Linear chords
// introduced a velocity jump at each dense sample; treating those artificial
// jumps as physical acceleration used to slow the entire tour many times over.
function createSchedule(tour) {
  const raw = geometry(tour),
    { speed, acceleration, turnRate } = tour.settings;
  const omega = (turnRate * Math.PI) / 180,
    radius = 1;
  const nodes = [],
    ds = [0];
  let length = 0;
  for (const n of raw) {
    const previous = nodes.at(-1);
    const dl = previous ? dist(previous.position, n.position) : 0;
    const d = previous
      ? Math.hypot(
          dl,
          radius * Math.hypot(n.yaw - previous.yaw, n.pitch - previous.pitch),
        )
      : 0;
    if (previous && d < 1e-9) {
      if (n.key !== null) previous.keys.push(n.key);
      continue;
    }
    if (previous) {
      ds.push(d);
      length += dl;
    }
    nodes.push({ ...n, keys: n.key === null ? [] : [n.key] });
  }
  if (nodes.length < 2)
    throw new Error("路线没有位置或朝向变化，请增加一个不同机位");
  const scalarSlope = (left, right, a, b) =>
    left * right <= 0
      ? 0
      : (3 * (a + b)) / ((2 * b + a) / left + (b + 2 * a) / right);
  for (let i = 0; i < nodes.length; i++) {
    const previous = nodes[Math.max(0, i - 1)],
      next = nodes[Math.min(nodes.length - 1, i + 1)];
    const a = ds[i] || ds[1],
      b = ds[i + 1] || ds.at(-1);
    const before = i
      ? sub(nodes[i].position, previous.position).map((x) => x / a)
      : null;
    const after =
      i < nodes.length - 1
        ? sub(next.position, nodes[i].position).map((x) => x / b)
        : null;
    nodes[i].dp =
      before && after
        ? before.map((x, j) => (x * b + after[j] * a) / (a + b))
        : [...(before || after)];
    for (const field of ["yaw", "pitch"]) {
      const left = i ? (nodes[i][field] - previous[field]) / a : null;
      const right =
        i < nodes.length - 1 ? (next[field] - nodes[i][field]) / b : null;
      nodes[i]["d" + field] =
        left !== null && right !== null
          ? scalarSlope(left, right, a, b)
          : (left ?? right);
    }
    if (
      nodes[i].keys.some(
        (k) => tour.points[k].hold > 0 || tour.settings.smoothness === 0,
      )
    ) {
      nodes[i].dp = [0, 0, 0];
      nodes[i].dyaw = 0;
      nodes[i].dpitch = 0;
    }
  }
  const caps = nodes.map(() => Infinity),
    edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i],
      b = nodes[i + 1],
      d = ds[i + 1];
    // A cubic's first derivative is a quadratic Bezier. Its three controls
    // bound speed, and its two second-derivative controls bound acceleration
    // throughout the interval, not just at arbitrary numerical sample times.
    const p0 = a.dp,
      p2 = b.dp,
      p1 = sub(b.position, a.position).map(
        (x, j) => (3 * x) / d - p0[j] - p2[j],
      );
    const maxFirst = Math.max(len(p0), len(p1), len(p2));
    const maxSecond = (2 * Math.max(dist(p1, p0), dist(p2, p1))) / d;
    const w0 = [a.dyaw, a.dpitch],
      w2 = [b.dyaw, b.dpitch];
    const w1 = [
      (3 * (b.yaw - a.yaw)) / d - w0[0] - w2[0],
      (3 * (b.pitch - a.pitch)) / d - w0[1] - w2[1],
    ];
    const maxAngular = Math.max(len(w0), len(w1), len(w2));
    let cap = Math.min(
      speed / Math.max(maxFirst, 1e-12),
      omega / Math.max(maxAngular, 1e-12),
    );
    if (maxSecond > 1e-12)
      cap = Math.min(cap, Math.sqrt((acceleration * 0.45) / maxSecond));
    caps[i] = Math.min(caps[i], cap);
    caps[i + 1] = Math.min(caps[i + 1], cap);
    edges.push({ ds: d, accel: (acceleration * 0.45) / Math.max(1, maxFirst) });
  }
  caps[0] = caps[caps.length - 1] = 0;
  for (let i = 1; i < nodes.length - 1; i++)
    if (
      nodes[i].keys.some(
        (k) => tour.points[k].hold > 0 || tour.settings.smoothness === 0,
      )
    )
      caps[i] = 0;
  for (let i = 1; i < caps.length; i++)
    caps[i] = Math.min(
      caps[i],
      Math.sqrt(caps[i - 1] ** 2 + 2 * edges[i - 1].accel * edges[i - 1].ds),
    );
  for (let i = caps.length - 2; i >= 0; i--)
    caps[i] = Math.min(
      caps[i],
      Math.sqrt(caps[i + 1] ** 2 + 2 * edges[i].accel * edges[i].ds),
    );
  let time = 0;
  const intervals = [],
    keyTimes = [];
  for (let i = 0; i < nodes.length; i++) {
    for (const key of nodes[i].keys) {
      keyTimes.push({ point_id: tour.points[key].id, time });
      const hold = tour.points[key].hold;
      if (hold) {
        intervals.push({
          start: time,
          end: time + hold,
          a: nodes[i],
          b: nodes[i],
          v0: 0,
          v1: 0,
          ds: 0,
          hold: true,
        });
        time += hold;
      }
    }
    if (i === nodes.length - 1) break;
    const d = edges[i].ds,
      dt = (2 * d) / Math.max(1e-12, caps[i] + caps[i + 1]);
    intervals.push({
      start: time,
      end: time + dt,
      a: nodes[i],
      b: nodes[i + 1],
      v0: caps[i],
      v1: caps[i + 1],
      ds: d,
      hold: false,
    });
    time += dt;
  }
  return { nodes, intervals, keyTimes, length, duration: time };
}
function sampleSchedule(schedule, t) {
  const list = schedule.intervals;
  if (t >= schedule.duration) return poseOf(schedule.nodes.at(-1));
  let lo = 0,
    hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  const s = list[lo],
    dt = s.end - s.start,
    local = clamp(t - s.start, 0, dt);
  if (s.hold) return poseOf(s.a);
  const f = clamp(
    (s.v0 * local + ((s.v1 - s.v0) * local * local) / (2 * dt)) / s.ds,
    0,
    1,
  );
  const yaw = hermite(s.a.yaw, s.b.yaw, s.a.dyaw * s.ds, s.b.dyaw * s.ds, f);
  const pitch = hermite(
    s.a.pitch,
    s.b.pitch,
    s.a.dpitch * s.ds,
    s.b.dpitch * s.ds,
    f,
  );
  return {
    position: s.a.position.map((x, j) =>
      hermite(x, s.b.position[j], s.a.dp[j] * s.ds, s.b.dp[j] * s.ds, f),
    ),
    quaternion: quaternionFromAngles(yaw, pitch),
    yaw,
    pitch,
  };
}

function poseOf(n) {
  return {
    position: [...n.position],
    quaternion: [...n.quaternion],
    yaw: n.yaw,
    pitch: n.pitch,
  };
}
function stretchSchedule(schedule, factor) {
  let end = 0;
  const remap = new Map();
  for (const s of schedule.intervals) {
    const oldStart = s.start,
      oldEnd = s.end,
      dt = (oldEnd - oldStart) * (s.hold ? 1 : factor);
    remap.set(oldStart, end);
    s.start = end;
    s.end = end + dt;
    remap.set(oldEnd, s.end);
    end = s.end;
    if (!s.hold) {
      s.v0 /= factor;
      s.v1 /= factor;
    }
  }
  schedule.keyTimes = schedule.keyTimes.map((k) => ({
    ...k,
    time: remap.get(k.time) ?? end,
  }));
  schedule.duration = end;
}
function limits(schedule) {
  const dt = 1 / 100;
  let last = null,
    lastV = null,
    maxSpeed = 0,
    maxAcceleration = 0,
    maxTurn = 0;
  for (let t = 0; t <= schedule.duration + dt; t += dt) {
    const p = sampleSchedule(schedule, Math.min(t, schedule.duration));
    if (last) {
      const v = sub(p.position, last.position).map((x) => x / dt);
      maxSpeed = Math.max(maxSpeed, len(v));
      maxTurn = Math.max(
        maxTurn,
        ((quatAngle(p.quaternion, last.quaternion) / dt) * 180) / Math.PI,
      );
      if (lastV)
        maxAcceleration = Math.max(maxAcceleration, dist(v, lastV) / dt);
      lastV = v;
    }
    last = p;
  }
  return {
    max_speed: maxSpeed,
    max_acceleration: maxAcceleration,
    max_turn_rate: maxTurn,
  };
}

export function compileTour(input) {
  const tour = normalizeTour(input, { requirePath: true }),
    schedule = createSchedule(tour);
  if (
    !Number.isFinite(schedule.duration) ||
    schedule.duration > MAX_PREVIEW_SECONDS
  )
    throw new Error("路线超过一小时，请提高速度或拆分路线");
  const minDuration = schedule.duration;
  if (tour.settings.duration !== null) {
    if (tour.settings.duration - 1 / FPS + 0.001 < minDuration)
      throw new Error(
        `目标时长过短；当前速度与转向限制至少需要 ${(minDuration + 1 / FPS).toFixed(2)} 秒`,
      );
    const holds = tour.points.reduce((s, p) => s + p.hold, 0);
    stretchSchedule(
      schedule,
      (Math.round(tour.settings.duration * FPS) / FPS - 1 / FPS - holds) /
        Math.max(0.001, schedule.duration - holds),
    );
  }
  let frameCount = Math.max(
    2,
    tour.settings.duration === null
      ? Math.ceil(schedule.duration * FPS) + 1
      : Math.round(tour.settings.duration * FPS),
  );
  if (frameCount > MAX_PREVIEW_SECONDS * FPS)
    throw new Error("路线超过一小时，请提高速度或拆分路线");
  // The final waypoint is sampled exactly; the final frame is held for 1/25 s.
  let motionDuration = (frameCount - 1) / FPS;
  const holds = tour.points.reduce((s, p) => s + p.hold, 0);
  stretchSchedule(
    schedule,
    (motionDuration - holds) / Math.max(0.001, schedule.duration - holds),
  );
  let metrics = limits(schedule);
  if (
    metrics.max_speed > tour.settings.speed * 1.005 ||
    metrics.max_turn_rate > tour.settings.turnRate * 1.005 ||
    metrics.max_acceleration > tour.settings.acceleration * 1.005
  )
    throw new Error("轨迹运动校验未通过，请调整问题机位；不会自动拖慢整条路线");
  const sample = (time) => ({
    ...sampleSchedule(schedule, clamp(time, 0, motionDuration)),
    fov: tour.settings.fov,
  });
  return {
    schema_version: 1,
    compiler: "camera-tour-core/2",
    fps: FPS,
    frame_count: frameCount,
    duration: frameCount / FPS,
    motion_duration: motionDuration,
    min_duration: minDuration,
    path_length: schedule.length,
    metrics,
    key_times: schedule.keyTimes,
    preview_nodes: schedule.nodes.map((n) => ({
      position: n.position,
      quaternion: n.quaternion,
    })),
    sample,
    frames: () =>
      Array.from({ length: frameCount }, (_, i) => {
        const p = sample(i / FPS);
        return {
          index: i,
          timestamp_us: i * 40000,
          time: i / FPS,
          ...p,
          camera_to_world: cameraMatrix(p.position, p.quaternion),
        };
      }),
  };
}

// Export resource policy is separate from path compilation and preview.
export function exportLimitMessage(compiled) {
  return compiled.frame_count > MAX_EXPORT_FRAMES
    ? `预览可用；此路线约 ${(compiled.duration / 60).toFixed(1)} 分钟，视频导出暂限 10 分钟。请调整运动参数或分段导出。`
    : null;
}
