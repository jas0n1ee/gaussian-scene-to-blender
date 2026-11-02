import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createReviewServer} from '../server.mjs';
import {quaternionFromAngles as q} from '../lib/tour/core.mjs';

test('tour HTTP persists routes without Review edits; rejects mismatched alignment, origin and missing frames',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tour-http-')),pkg=path.join(root,'reviews','R0');await fs.mkdir(path.join(pkg,'display'),{recursive:true});
  const identity=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],display={};
  for(const kind of ['G','B']){const bytes=Buffer.alloc(128,kind==='G'?1:2),name=kind==='G'?'G.rad':'B.glb';await fs.writeFile(path.join(pkg,'display',name),bytes);display[kind]={path:`reviews/R0/display/${name}`,sha256:createHash('sha256').update(bytes).digest('hex'),source_sha256:`source_${kind}`,asset_to_project:identity};}
  const manifest={schema_version:1,project_root:'../..',base_revision:'R0',alignment_id:'test',assets:{G:{sha256:'source_G'},B:{sha256:'source_B'}},display_assets:display,results:[],issues:[],views:[]};
  await fs.writeFile(path.join(pkg,'manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(pkg,'alignment.json'),JSON.stringify({alignment_id:'test',G:{source_to_project:identity},B:{source_to_project:identity}}));
  const app=await createReviewServer({manifestPath:path.join(pkg,'manifest.json'),port:0});t.after(async()=>{await app.tours.close();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const req=async(url,method='GET',body,headers={})=>{const r=await fetch(app.url+url,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,value:await r.json()};};
  const tour={schema_version:1,coordinate_frame:'project',world_up:'+Z',alignment_id:'test',points:[{id:'p1',position:[0,0,0],quaternion:q(0,0)},{id:'p2',position:[0,1,0],quaternion:q(0,0)}]};
  assert.equal((await req('/api/tours/route','PUT',tour,{Origin:'https://unrelated.example'})).status,400);
  assert.equal((await req('/api/tours/route','PUT',{...tour,alignment_id:'wrong'})).status,400);
  const saved=await req('/api/tours/route','PUT',tour);assert.equal(saved.status,200);
  const list=await req('/api/tours');assert.equal(list.value.routes.length,1);assert.deepEqual(list.value.tracks.map(t=>t.id),['G','B_base']);
  const j=await req('/api/tour-jobs','POST',{route_id:'route',route_sha256:saved.value.sha256,track_ids:['G','B_base'],resolution:[640,360]});assert.equal(j.status,201);
  const frames=await req(`/api/tour-jobs/${j.value.id}/frames`);assert.equal(frames.value.length,j.value.frame_count);
  assert.equal((await req(`/api/tour-jobs/${j.value.id}/finish`,'POST',{})).status,400);
  assert.equal((await req(`/api/tour-jobs/${j.value.id}/cancel`,'POST',{})).value.status,'cancelled');
  assert.equal((await req(`/api/tour-jobs/${j.value.id}/resume`,'POST',{}, {Origin:'https://unrelated.example'})).status,400);
  const resumed=await req(`/api/tour-jobs/${j.value.id}/resume`,'POST',{});
  assert.equal(resumed.status,200);assert.equal(resumed.value.status,'capturing');assert.deepEqual(resumed.value.received,{G:0,B_base:0});
  assert.deepEqual((await req(`/api/tour-jobs/${j.value.id}/frames`)).value,frames.value);
  await req(`/api/tour-jobs/${j.value.id}/cancel`,'POST',{});
  const unchanged=JSON.parse(await fs.readFile(path.join(pkg,'manifest.json'),'utf8'));assert.deepEqual(unchanged,manifest);
});
