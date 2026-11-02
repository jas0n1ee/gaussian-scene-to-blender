import { promises as fs } from "node:fs";
import path from "node:path";
import { ReviewStore } from "../lib/review-store.mjs";
const arg = (name, otherwise = null) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? otherwise : process.argv[i + 1];
};
const destination = arg("--manifest"),
  source = arg("--from-manifest"),
  revision = arg("--revision", "base"),
  slug = arg("--id");
if (
  !destination ||
  !source ||
  !slug ||
  !/^[A-Za-z0-9_-]{1,50}$/.test(slug) ||
  !/^[A-Za-z0-9_-]{1,50}$/.test(revision)
)
  throw new Error(
    "Usage: node tools/register-tour-model.mjs --manifest DEST --from-manifest SOURCE --revision base|R2 --id SLUG [--label LABEL]",
  );
const dest = await new ReviewStore(destination).initialize(),
  src = await new ReviewStore(source).initialize();
if (
  dest.projectRoot !== src.projectRoot ||
  !src.manifest.assets.G.sha256 ||
  src.manifest.assets.G.sha256 !== dest.manifest.assets.G.sha256 ||
  JSON.stringify(src.alignment.G.source_to_project) !==
    JSON.stringify(dest.alignment.G.source_to_project)
)
  throw new Error("源扫描或坐标变换不一致，不能自动复用机位");
let file, report;
if (revision === "base") {
  const asset = await src.verifyAsset("B");
  file = asset.file;
  report = {
    glb_sha256: asset.sha256,
    source_sha256: asset.source_sha256,
    asset_to_project:
      asset.asset_to_project || src.alignment.B.source_to_project,
  };
} else {
  if (!src.manifest.results.some((r) => r.revision === revision))
    throw new Error("源版本未登记");
  file = path.join(src.packageDir, "results", revision, `B_${revision}.glb`);
  report = JSON.parse(
    await fs.readFile(
      path.join(
        src.packageDir,
        "results",
        revision,
        `B_${revision}.export.json`,
      ),
      "utf8",
    ),
  );
}
if (!report.glb_sha256 || !report.asset_to_project)
  throw new Error("导出报告缺少哈希或坐标");
await src.verifyDigest(file, report.glb_sha256);
const catalogue = path.join(dest.packageDir, "tours", "models.json");
const records = await fs
  .readFile(catalogue, "utf8")
  .then(JSON.parse)
  .catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
const id = `B_${slug}`;
if (records.some((r) => r.id === id) || id === "B_base")
  throw new Error("目录 ID 已存在，使用新的 ID");
records.push({
  id,
  label: arg("--label", revision),
  path: path.relative(dest.projectRoot, file),
  sha256: report.glb_sha256,
  source_sha256: report.source_sha256,
  asset_to_project: report.asset_to_project,
  alignment_id: dest.manifest.alignment_id,
  source_alignment_id: src.manifest.alignment_id,
});
await fs.mkdir(path.dirname(catalogue), { recursive: true });
await fs.writeFile(catalogue, JSON.stringify(records, null, 2) + "\n");
process.stdout.write(JSON.stringify(records.at(-1), null, 2) + "\n");
