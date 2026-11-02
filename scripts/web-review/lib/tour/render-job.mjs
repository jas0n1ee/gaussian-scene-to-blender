// Adapter contract: begin(job), render(track, frame, {signal}) -> {blob,meta}, end().
// No browser, Three.js, ReviewStore, encoder or DOM dependency.
export async function renderTourJob({
  job,
  frames,
  adapter,
  upload,
  finish,
  onProgress = () => {},
  signal,
}) {
  if (frames.length !== job.frame_count) throw new Error("逐帧相机表不完整");
  for (const track of job.tracks) {
    const start = job.received?.[track.id] ?? 0;
    if (!Number.isInteger(start) || start < 0 || start > frames.length)
      throw new Error("已采集帧数无效");
  }
  try {
    await adapter.begin(job);
    for (const track of job.tracks) {
      for (let i = job.received?.[track.id] ?? 0; i < frames.length; i++) {
        if (signal?.aborted) throw new Error("已取消");
        const frame = frames[i];
        onProgress({
          track,
          index: i,
          total: frames.length,
          phase: "rendering",
        });
        const capture = await adapter.render(track, frame, { signal });
        if (signal?.aborted) throw new Error("已取消");
        await upload(track, i, capture.blob, {
          ...capture.meta,
          asset_sha256: track.sha256,
          timestamp_us: frame.timestamp_us,
          camera_to_world: frame.camera_to_world,
          fov: frame.fov,
        });
      }
    }
    await finish();
  } finally {
    await adapter.end();
  }
}
