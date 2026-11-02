import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { normalizeTour, compileTour, exportLimitMessage } from "./core.mjs";
import { encodeTour, encoderCapabilities } from "./encoder.mjs";

const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const validId = (id) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id || ""))
    throw new Error("路线或任务 ID 无效");
  return id;
};
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const now = () => new Date().toISOString();
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n");
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

// Dependency injection keeps persistence and encoding usable without ReviewStore.
export class TourStore {
  constructor({ directory, alignmentId, resolveTracks, encoderOptions = {} }) {
    this.directory = path.resolve(directory);
    this.alignmentId = alignmentId;
    this.resolveTracks = resolveTracks;
    this.encoderOptions = encoderOptions;
    this.queue = Promise.resolve();
    this.running = new Map();
    this.frameCache = new Map();
    this.capability = null;
  }
  enqueue(work) {
    const p = this.queue.then(work);
    this.queue = p.catch(() => {});
    return p;
  }
  routePath(id) {
    return path.join(this.directory, "routes", `${validId(id)}.json`);
  }
  jobDir(id) {
    return path.join(this.directory, "exports", validId(id));
  }
  async capabilities() {
    return (this.capability ??= await encoderCapabilities(this.encoderOptions));
  }
  async list() {
    const routes = [];
    for (const n of await fs
      .readdir(path.join(this.directory, "routes"))
      .catch(() => [])) {
      if (!/^[\w-]+\.json$/.test(n)) continue;
      const r = await read(path.join(this.directory, "routes", n));
      routes.push({
        id: n.slice(0, -5),
        name: r.tour.name,
        points: r.tour.points.length,
        updated_at: r.updated_at,
        sha256: r.sha256,
      });
    }
    const jobs = [];
    for (const id of await fs
      .readdir(path.join(this.directory, "exports"))
      .catch(() => [])) {
      if (!/^[\w-]+$/.test(id)) continue;
      try {
        jobs.push(await this.job(id));
      } catch {
        /* unfinished creation has no job.json */
      }
    }
    return {
      routes: routes.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      jobs: jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      tracks: await this.resolveTracks(),
      encoder: await this.capabilities(),
    };
  }
  async route(id) {
    return read(this.routePath(id));
  }
  async saveRoute(id, input) {
    return this.enqueue(async () => {
      const tour = normalizeTour(input, { alignmentId: this.alignmentId });
      const record = {
        id: validId(id),
        tour,
        sha256: digest(tour),
        updated_at: now(),
      };
      await atomic(this.routePath(id), record);
      return record;
    });
  }
  async createJob(input) {
    return this.enqueue(async () => {
      const caps = await this.capabilities();
      if (!caps.ready) throw new Error(`编码器未就绪：${caps.error}`);
      const route = await this.route(input.route_id);
      if (input.route_sha256 !== route.sha256)
        throw new Error("路线已发生变化，请保存后重新生成");
      const compiled = compileTour(route.tour);
      const exportError = exportLimitMessage(compiled);
      if (exportError) throw new Error(exportError);
      const catalog = await this.resolveTracks();
      if (
        !Array.isArray(input.track_ids) ||
        !input.track_ids.length ||
        input.track_ids.length > 8 ||
        new Set(input.track_ids).size !== input.track_ids.length
      )
        throw new Error("请选择 1–8 个不同版本");
      const tracks = input.track_ids.map((id) => {
        const t = catalog.find((t) => t.id === id);
        if (!t) throw new Error(`版本不存在：${id}`);
        return t;
      });
      const [width, height] = input.resolution || [];
      if (
        ![
          [640, 360],
          [1280, 720],
          [1920, 1080],
        ].some((r) => r[0] === width && r[1] === height)
      )
        throw new Error("请选择支持的 16:9 分辨率");
      const id = `E_${randomUUID()}`,
        dir = this.jobDir(id),
        frames = compiled.frames();
      const job = {
        schema_version: 1,
        id,
        route_id: route.id,
        route_sha256: route.sha256,
        alignment_id: this.alignmentId,
        name: route.tour.name,
        created_at: now(),
        updated_at: now(),
        status: "capturing",
        server_pid: process.pid,
        width,
        height,
        fps: 25,
        frame_count: compiled.frame_count,
        duration: compiled.duration,
        frames_sha256: digest(frames),
        tracks,
        received: Object.fromEntries(tracks.map((t) => [t.id, 0])),
        outputs: [],
        render_settings: {
          G: {
            engine: "Spark 2.2.0",
            display_sh_degree:
              tracks.find((t) => t.id === "G")?.display_sh_degree ?? null,
            lod_splat_scale: 1,
            paged_ext_splats: true,
          },
          B: { engine: "Three.js 0.186.0", exposure: 1, motion_blur: false },
          color_space: "sRGB",
          camera_clip: [0.05, 1000],
        },
        compiler: {
          version: compiled.compiler,
          metrics: compiled.metrics,
          path_length: compiled.path_length,
          min_duration: compiled.min_duration,
          key_times: compiled.key_times,
        },
      };
      await fs.mkdir(dir, { recursive: true });
      await atomic(path.join(dir, "route.json"), route.tour);
      await atomic(path.join(dir, "frames.json"), frames);
      this.frameCache.set(id, frames);
      await atomic(path.join(dir, "job.json"), job);
      return job;
    });
  }
  async job(id) {
    const j = await read(path.join(this.jobDir(id), "job.json"));
    if (
      ["capturing", "encoding"].includes(j.status) &&
      j.server_pid &&
      j.server_pid !== process.pid
    ) {
      j.interrupted = true;
    }
    return j;
  }
  async frames(id) {
    validId(id);
    if (!this.frameCache.has(id))
      this.frameCache.set(
        id,
        await read(path.join(this.jobDir(id), "frames.json")),
      );
    return this.frameCache.get(id);
  }
  async saveFrame(id, track, index, bytes, meta) {
    return this.enqueue(async () => {
      const j = await this.job(id);
      if (j.status !== "capturing") throw new Error("任务已停止接收画面");
      const asset = j.tracks.find((t) => t.id === track);
      if (!asset) throw new Error("画面版本不属于任务");
      if (
        !Number.isInteger(index) ||
        index !== j.received[track] ||
        index >= j.frame_count
      )
        throw new Error("帧号不连续或重复");
      if (
        bytes.length < 40 ||
        !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
        bytes.toString("ascii", 12, 16) !== "IHDR" ||
        bytes.readUInt32BE(16) !== j.width ||
        bytes.readUInt32BE(20) !== j.height
      )
        throw new Error("画面 PNG 或尺寸不匹配");
      const expected = (await this.frames(id))[index];
      if (
        meta?.asset_sha256 !== asset.sha256 ||
        meta?.timestamp_us !== expected.timestamp_us ||
        JSON.stringify(meta.camera_to_world) !==
          JSON.stringify(expected.camera_to_world) ||
        meta?.fov !== expected.fov
      )
        throw new Error("帧相机、时间或资产哈希不匹配");
      if (
        track === "G" &&
        (!meta.ready ||
          meta.pending_pages !== 0 ||
          meta.sorting !== false ||
          meta.lod_pending !== false)
      )
        throw new Error("高斯画面尚未就绪");
      const dir = path.join(this.jobDir(id), "frames", track);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${String(index).padStart(6, "0")}.png`);
      await fs.writeFile(file, bytes, { flag: "wx" });
      await fs.appendFile(
        path.join(this.jobDir(id), "capture.jsonl"),
        JSON.stringify({ track, index, sha256: digest(bytes), ...meta }) + "\n",
      );
      j.received[track]++;
      j.updated_at = now();
      j.server_pid = process.pid;
      await atomic(path.join(this.jobDir(id), "job.json"), j);
      return { track, index, received: j.received[track] };
    });
  }
  async finish(id) {
    return this.enqueue(async () => {
      const j = await this.job(id);
      if (j.status !== "capturing")
        throw new Error("只有采集完成的任务可以编码");
      if (j.tracks.some((t) => j.received[t.id] !== j.frame_count))
        throw new Error("画面尚未采集完整");
      j.status = "encoding";
      j.message = "开始编码";
      j.server_pid = process.pid;
      j.updated_at = now();
      await atomic(path.join(this.jobDir(id), "job.json"), j);
      const abort = new AbortController();
      this.running.set(id, abort);
      const task = (async () => {
        try {
          const outputs = await encodeTour(this.jobDir(id), j, {
            ...this.encoderOptions,
            signal: abort.signal,
            onProgress: (message) => {
              this.enqueue(async () => {
                const current = await this.job(id);
                if (current.status === "encoding")
                  await atomic(path.join(this.jobDir(id), "job.json"), {
                    ...current,
                    message,
                    updated_at: now(),
                  });
              });
            },
          });
          await this.enqueue(async () => {
            const current = await this.job(id);
            if (current.status === "cancelled") return;
            await atomic(path.join(this.jobDir(id), "job.json"), {
              ...current,
              status: "complete",
              message: "视频已生成，25fps / 帧数 / 时长已核验",
              outputs,
              completed_at: now(),
              updated_at: now(),
            });
          });
        } catch (error) {
          await this.enqueue(async () => {
            const current = await this.job(id);
            if (current.status === "cancelled") return;
            await atomic(path.join(this.jobDir(id), "job.json"), {
              ...current,
              status: abort.signal.aborted ? "cancelled" : "failed",
              error: error.message,
              updated_at: now(),
            });
          });
        } finally {
          this.running.delete(id);
        }
      })();
      this.running.get(id).task = task;
      return j;
    });
  }
  async resume(id) {
    return this.enqueue(async () => {
      const j = await this.job(id), dir = this.jobDir(id);
      if (!["cancelled", "failed"].includes(j.status) || this.running.has(id))
        throw new Error("只有已停止的任务可以继续采集");
      if (j.alignment_id !== this.alignmentId) throw new Error("任务坐标版本已改变，不能续帧");
      if (!(await this.capabilities()).ready) throw new Error("编码器未就绪");
      const route = await read(path.join(dir, "route.json"));
      const frames = await read(path.join(dir, "frames.json"));
      if (digest(route) !== j.route_sha256 || digest(frames) !== j.frames_sha256 || frames.length !== j.frame_count)
        throw new Error("冻结路线或相机表已改变，不能续帧");
      const catalog = await this.resolveTracks();
      for (const track of j.tracks) {
        const current = catalog.find(t => t.id === track.id);
        if (!current || ["sha256", "source_sha256", "asset_to_project", "display_sh_degree"].some(k => JSON.stringify(current[k]) !== JSON.stringify(track[k])))
          throw new Error("显示资产或坐标已改变，不能续帧");
      }
      const records = (await fs.readFile(path.join(dir, "capture.jsonl"), "utf8").catch(e => {
        if (e.code === "ENOENT") return "";
        throw e;
      })).split("\n").filter(Boolean).map(JSON.parse);
      const counts = Object.fromEntries(j.tracks.map(t => [t.id, 0]));
      for (const r of records) {
        const asset = j.tracks.find(t => t.id === r.track), frame = frames[r.index];
        if (!asset || !frame || r.index !== counts[r.track] || r.asset_sha256 !== asset.sha256 || r.timestamp_us !== frame.timestamp_us || r.fov !== frame.fov || JSON.stringify(r.camera_to_world) !== JSON.stringify(frame.camera_to_world))
          throw new Error("已采集帧记录不连续或相机不匹配");
        if (r.track === "G" && (!r.ready || r.pending_pages !== 0 || r.sorting !== false || r.lod_pending !== false))
          throw new Error("已采集高斯帧未就绪");
        const bytes = await fs.readFile(path.join(dir, "frames", r.track, `${String(r.index).padStart(6, "0")}.png`));
        if (digest(bytes) !== r.sha256 || bytes.length < 40 || bytes.readUInt32BE(16) !== j.width || bytes.readUInt32BE(20) !== j.height)
          throw new Error("已采集帧文件已改变");
        counts[r.track]++;
      }
      for (const track of j.tracks) {
        const n = j.received[track.id];
        if (!Number.isInteger(n) || n < 0 || n > j.frame_count || counts[track.id] !== n)
          throw new Error("已采集帧数与记录不符");
        const files = await fs.readdir(path.join(dir, "frames", track.id)).catch(e => {
          if (e.code === "ENOENT") return [];
          throw e;
        });
        if (files.filter(f => /^\d{6}\.png$/.test(f)).length !== n)
          throw new Error("帧目录存在未登记文件，不能续帧");
      }
      const next = { ...j, status: "capturing", server_pid: process.pid,
        resume_count: (j.resume_count || 0) + 1, message: "已有帧校验通过，继续采集", updated_at: now() };
      delete next.error;
      delete next.interrupted;
      await atomic(path.join(dir, "job.json"), next);
      return next;
    });
  }
  async cancel(id) {
    return this.enqueue(async () => {
      const j = await this.job(id);
      if (["complete", "failed", "cancelled"].includes(j.status)) return j;
      this.running.get(id)?.abort();
      const next = {
        ...j,
        status: "cancelled",
        message: "任务已取消；已采集画面保留",
        updated_at: now(),
      };
      await atomic(path.join(this.jobDir(id), "job.json"), next);
      return next;
    });
  }
  async close() {
    for (const controller of this.running.values()) controller.abort();
    await Promise.all([...this.running.values()].map((c) => c.task));
  }
  async publicFile(id, name) {
    const j = await this.job(id);
    if (
      !["route.json", "frames.json", "job.json"].includes(name) &&
      !(j.status === "complete" && j.outputs.some((o) => o.file === name))
    )
      throw new Error("文件未完成或不属于此任务");
    return path.join(this.jobDir(id), name);
  }
}
