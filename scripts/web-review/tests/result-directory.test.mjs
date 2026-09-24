import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureResultDirectory } from '../tools/result-directory.mjs';
const spec = { reviewId: 'R33', baseRevision: 'R33', revision: 'R34' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-result-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'R34'); await fs.mkdir(path.join(dir, 'views'), { recursive: true });
  await fs.writeFile(path.join(dir, 'responses.json'), JSON.stringify({ review_id:'R33',base_revision:'R33',target_revision:'R34',status:'awaiting_human_feedback',result_model:null,responses:[] }));
  await fs.writeFile(path.join(dir, 'review.html'), 'waiting'); return dir;
}
test('reuse known empty legacy scaffold without touching files', async t => {
 const dir=await fixture(t); const before=await fs.readFile(path.join(dir,'responses.json'),'utf8');
 assert.equal((await ensureResultDirectory(dir,spec)).reusedPlaceholder,true);
 assert.equal(await fs.readFile(path.join(dir,'responses.json'),'utf8'),before);
});
for (const file of ['B_R34.glb','views/V0001/B_after.png']) test(`protect real artifact ${file}`,async t=>{
 const dir=await fixture(t);await fs.mkdir(path.dirname(path.join(dir,file)),{recursive:true});await fs.writeFile(path.join(dir,file),'real');
 await assert.rejects(ensureResultDirectory(dir,spec));assert.equal(await fs.readFile(path.join(dir,file),'utf8'),'real');
});
test('reject different revision or non-placeholder response',async t=>{
 const dir=await fixture(t);await assert.rejects(ensureResultDirectory(dir,{...spec,revision:'R35'}));
 await fs.writeFile(path.join(dir,'responses.json'),JSON.stringify({result_revision:'R34',issues:{R33_I1:{response:'done'}}}));await assert.rejects(ensureResultDirectory(dir,spec));
});
test('reject symlink destinations',async t=>{const dir=await fixture(t);const link=dir+'-link';await fs.symlink(dir,link);await assert.rejects(ensureResultDirectory(link,spec));});
