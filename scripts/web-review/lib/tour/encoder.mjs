import { spawn } from "node:child_process";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export async function runProcess(command, args, { signal, onStderr } = {}) {
  if (signal?.aborted) throw new Error("已取消");
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let out = "",
      err = "";
    proc.stdout.on("data", (b) => {
      out += b;
    });
    proc.stderr.on("data", (b) => {
      err = (err + b).slice(-12000);
      onStderr?.(b.toString());
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              signal?.aborted
                ? "已取消"
                : `${path.basename(command)} 失败 (${code}): ${err.slice(-1800)}`,
            ),
          ),
    );
  });
}
export async function encoderCapabilities({
  ffmpeg = process.env.TOUR_FFMPEG || "ffmpeg",
  ffprobe = process.env.TOUR_FFPROBE || "ffprobe",
} = {}) {
  try {
    const [enc, version] = await Promise.all([
      runProcess(ffmpeg, ["-hide_banner", "-encoders"]),
      runProcess(ffprobe, ["-version"]),
    ]);
    if (!enc.includes("libx264")) throw new Error("FFmpeg 缺少 libx264 编码器");
    return {
      ready: true,
      ffmpeg,
      ffprobe,
      codec: "H.264 / MP4",
      fps: 25,
      probe_version: version.split("\n")[0],
    };
  } catch (error) {
    return { ready: false, error: error.message };
  }
}
export async function encodeTour(
  directory,
  job,
  {
    signal,
    ffmpeg = process.env.TOUR_FFMPEG || "ffmpeg",
    ffprobe = process.env.TOUR_FFPROBE || "ffprobe",
    onProgress = () => {},
  } = {},
) {
  const outputs = [],
    log = path.join(directory, "encoding.log");
  const run = async (args) => {
    await fs.appendFile(
      log,
      JSON.stringify({ at: new Date().toISOString(), command: ffmpeg, args }) +
        "\n",
    );
    const chunks = [];
    try {
      return await runProcess(ffmpeg, args, {
        signal,
        onStderr: (s) => chunks.push(s),
      });
    } finally {
      await fs.appendFile(log, chunks.join(""));
    }
  };
  const verify = async (file, width, height) => {
    const raw = await runProcess(
      ffprobe,
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { signal },
    );
    const probe = JSON.parse(raw),
      v = probe.streams?.find((s) => s.codec_type === "video");
    if (
      !v ||
      v.width !== width ||
      v.height !== height ||
      v.r_frame_rate !== "25/1" ||
      Number(v.nb_read_frames) !== job.frame_count ||
      Math.abs(Number(v.duration) - job.frame_count / 25) > 0.001
    )
      throw new Error(`输出校验失败：${path.basename(file)}`);
    await fs.writeFile(
      `${file}.probe.json`,
      JSON.stringify(probe, null, 2) + "\n",
    );
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return {
      file: path.basename(file),
      width,
      height,
      frames: job.frame_count,
      fps: 25,
      duration: job.frame_count / 25,
      codec: v.codec_name,
      sha256: hash.digest("hex"),
    };
  };
  const common = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-y"];
  const outputArgs = [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "25",
    "-frames:v",
    String(job.frame_count),
    "-movflags",
    "+faststart",
  ];
  for (const track of job.tracks) {
    onProgress(`编码 ${track.label}`);
    const name = `${track.id}.mp4`,
      partial = path.join(directory, `${track.id}.partial.mp4`);
    await run([
      ...common,
      "-framerate",
      "25",
      "-start_number",
      "0",
      "-i",
      path.join(directory, "frames", track.id, "%06d.png"),
      ...outputArgs,
      partial,
    ]);
    const result = await verify(partial, job.width, job.height);
    await fs.rename(partial, path.join(directory, name));
    await fs.rename(
      `${partial}.probe.json`,
      path.join(directory, `${name}.probe.json`),
    );
    outputs.push({ ...result, file: name, label: track.label });
  }
  const g = job.tracks.find((t) => t.id === "G");
  if (g)
    for (const track of job.tracks.filter((t) => t.id !== "G")) {
      onProgress(`合成 3DGS / ${track.label}`);
      const name = `compare_G_${track.id}.mp4`,
        partial = path.join(directory, `compare_G_${track.id}.partial.mp4`);
      await run([
        ...common,
        "-framerate",
        "25",
        "-start_number",
        "0",
        "-i",
        path.join(directory, "frames", "G", "%06d.png"),
        "-framerate",
        "25",
        "-start_number",
        "0",
        "-i",
        path.join(directory, "frames", track.id, "%06d.png"),
        "-filter_complex",
        "[0:v][1:v]hstack=inputs=2[v]",
        "-map",
        "[v]",
        ...outputArgs,
        partial,
      ]);
      const result = await verify(partial, job.width * 2, job.height);
      await fs.rename(partial, path.join(directory, name));
      await fs.rename(
        `${partial}.probe.json`,
        path.join(directory, `${name}.probe.json`),
      );
      outputs.push({ ...result, file: name, label: `3DGS ｜ ${track.label}` });
    }
  return outputs;
}
