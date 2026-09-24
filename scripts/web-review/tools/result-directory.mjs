import { promises as fs } from 'node:fs';
import path from 'node:path';

// Only reuse the old, empty pre-review scaffold. Any real result remains protected.
export async function ensureResultDirectory(directory, { reviewId, baseRevision, revision }) {
  const stat = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) { await fs.mkdir(directory, { recursive: true }); return { reusedPlaceholder: false }; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory} 不是可复用的结果占位目录`);
  const reject = () => { throw new Error(`${directory} 含真实或未知产物，拒绝覆盖`); };
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) reject();
    if (entry.name === 'views' && entry.isDirectory()) {
      if ((await fs.readdir(path.join(directory, 'views'))).length) reject();
    } else if (!['responses.json', 'review.html'].includes(entry.name) || !entry.isFile()) reject();
  }
  const responseFile = path.join(directory, 'responses.json');
  const data = await fs.readFile(responseFile, 'utf8').then(JSON.parse).catch(() => null);
  if (!data || data.status !== 'awaiting_human_feedback' || data.review_id !== reviewId || data.base_revision !== baseRevision || data.target_revision !== revision || !Array.isArray(data.responses) || data.responses.length || data.result_model != null || data.issues != null) reject();
  // Preserve the exact placeholder record before the pipeline writes its real response.
  return { reusedPlaceholder: true };
}
