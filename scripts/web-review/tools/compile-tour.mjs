import { promises as fs } from "node:fs";
import { compileTour } from "../lib/tour/core.mjs";
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? null : process.argv[i + 1];
};
const input = arg("--route"),
  output = arg("--out");
if (!input || !output)
  throw new Error(
    "Usage: node tools/compile-tour.mjs --route route.json --out frames.json",
  );
const c = compileTour(JSON.parse(await fs.readFile(input, "utf8")));
await fs.writeFile(output, JSON.stringify(c.frames(), null, 2) + "\n", {
  flag: "wx",
});
process.stdout.write(
  JSON.stringify(
    {
      fps: c.fps,
      frames: c.frame_count,
      duration: c.duration,
      metrics: c.metrics,
      output,
    },
    null,
    2,
  ) + "\n",
);
