import { promises as fs } from "node:fs";
import path from "node:path";
import { TourStore } from "./store.mjs";

export function createTourStore(review) {
  return new TourStore({
    directory: path.join(review.packageDir, "tours"),
    alignmentId: review.manifest.alignment_id,
    resolveTracks: async () => {
      const state = await review.state(),
        tracks = [];
      if (state.display.G) {
        const a = await review.verifyAsset("G");
        tracks.push({
          id: "G",
          label: "3DGS",
          kind: "gaussian",
          url: state.display.G.url,
          sha256: a.sha256 || (await review.sha256(a.file)),
          source_sha256: a.source_sha256,
          asset_to_project:
            a.asset_to_project || state.alignment.G.source_to_project,
          display_sh_degree: a.display_sh_degree ?? 0,
        });
      }
      if (state.display.B) {
        const a = await review.verifyAsset("B");
        tracks.push({
          id: "B_base",
          label: state.manifest.base_revision,
          kind: "model",
          url: "/asset/B",
          sha256: a.sha256 || (await review.sha256(a.file)),
          source_sha256: a.source_sha256,
          asset_to_project:
            a.asset_to_project || state.alignment.B.source_to_project,
        });
      }
      for (const a of state.resultModels) {
        const file = path.join(
          review.packageDir,
          "results",
          a.revision,
          `B_${a.revision}.glb`,
        );
        if (!a.sha256) throw new Error(`版本 ${a.revision} 缺少导出哈希`);
        await review.verifyDigest(file, a.sha256);
        tracks.push({
          id: `B_${a.revision}`,
          label: a.revision,
          kind: "model",
          ...a,
        });
      }
      // Optional catalogue is independent from Review acceptance/revision lifecycle.
      const extras = await fs
        .readFile(path.join(review.packageDir, "tours", "models.json"), "utf8")
        .then(JSON.parse)
        .catch((e) => {
          if (e.code === "ENOENT") return [];
          throw e;
        });
      for (const a of extras) {
        if (
          !/^B_[A-Za-z0-9_-]{1,60}$/.test(a.id) ||
          tracks.some((t) => t.id === a.id) ||
          a.alignment_id !== review.manifest.alignment_id ||
          !a.sha256 ||
          !Array.isArray(a.asset_to_project) ||
          a.asset_to_project.length !== 4 ||
          a.asset_to_project.some(
            (r) =>
              !Array.isArray(r) ||
              r.length !== 4 ||
              r.some((x) => !Number.isFinite(x)),
          )
        )
          throw new Error("额外模型目录的 ID、坐标或哈希无效");
        const file = review.assetPath(a);
        await review.verifyDigest(file, a.sha256);
        const real = await fs.realpath(file),
          root = await fs.realpath(review.projectRoot);
        if (!real.startsWith(root + path.sep))
          throw new Error("额外模型真实路径越界");
        tracks.push({
          id: a.id,
          label: String(a.label || a.id).slice(0, 80),
          kind: "model",
          url: `/tour-asset/${a.id}`,
          sha256: a.sha256,
          source_sha256: a.source_sha256,
          asset_to_project: a.asset_to_project,
        });
      }
      return tracks;
    },
  });
}
