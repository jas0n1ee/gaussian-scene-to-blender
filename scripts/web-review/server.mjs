import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewStore, inside } from './lib/review-store.mjs';
import { createTourStore } from './lib/tour/review-adapter.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.rad': 'application/octet-stream', '.radc': 'application/octet-stream', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function bodyJson(req) {
  return JSON.parse((await bodyBytes(req)).toString('utf8'));
}
async function bodyBytes(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('提交内容过大');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function fileResponse(req, res, file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('文件不存在');
  const common = { 'Content-Type': contentType(file), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (req.headers.range && !range) {
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    if (range[1] === '' && range[2] === '') throw new Error('Range 无效');
    if (range[1] === '') {
      const suffix = Number(range[2]);
      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? end : Number(range[2]);
    }
    if (start > end || start >= stat.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
  }
  const headers = { ...common, 'Content-Length': end - start + 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

export async function createReviewServer({ manifestPath, port = 4173, closeOnFinish = false } = {}) {
  if (!manifestPath) throw new Error('请用 --manifest 指定审阅包 manifest.json');
  const store = await new ReviewStore(manifestPath).initialize();
  const tours = createTourStore(store);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/tour') && !['GET','HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Error('只接受当前本机页面的写入');
      if (pathname === '/api/tours' && req.method === 'GET') return json(res,200,await tours.list());
      const routeMatch=/^\/api\/tours\/([A-Za-z0-9_-]{1,80})$/.exec(pathname);
      if(routeMatch && req.method==='GET') return json(res,200,await tours.route(routeMatch[1]));
      if(routeMatch && req.method==='PUT') return json(res,200,await tours.saveRoute(routeMatch[1],await bodyJson(req)));
      if(pathname==='/api/tour-jobs' && req.method==='POST') return json(res,201,await tours.createJob(await bodyJson(req)));
      const jobMatch=/^\/api\/tour-jobs\/([A-Za-z0-9_-]{1,80})(?:\/(frames|finish|cancel|resume))?$/.exec(pathname);
      if(jobMatch){
        const [,id,action]=jobMatch;
        if(req.method==='GET'&&!action)return json(res,200,await tours.job(id));
        if(req.method==='GET'&&action==='frames')return json(res,200,await tours.frames(id));
        if(req.method==='POST'&&action==='finish')return json(res,202,await tours.finish(id));
        if(req.method==='POST'&&action==='cancel')return json(res,200,await tours.cancel(id));
        if(req.method==='POST'&&action==='resume')return json(res,200,await tours.resume(id));
      }
      const frameMatch=/^\/api\/tour-jobs\/([A-Za-z0-9_-]{1,80})\/frames\/([A-Za-z0-9_-]{1,80})\/(\d+)$/.exec(pathname);
      if(frameMatch&&req.method==='PUT')return json(res,201,await tours.saveFrame(frameMatch[1],frameMatch[2],Number(frameMatch[3]),await bodyBytes(req),JSON.parse(req.headers['x-frame-meta']||'{}')));
      const videoFile=/^\/tour-file\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_.-]+)$/.exec(pathname);
      if(videoFile&&['GET','HEAD'].includes(req.method))return await fileResponse(req,res,await tours.publicFile(videoFile[1],videoFile[2]));
      const extraAsset=/^\/tour-asset\/(B_[A-Za-z0-9_-]{1,60})$/.exec(pathname);
      if(extraAsset&&['GET','HEAD'].includes(req.method)){
        await tours.resolveTracks();
        const catalogue=JSON.parse(await fs.readFile(path.join(store.packageDir,'tours','models.json'),'utf8'));
        const asset=catalogue.find(a=>a.id===extraAsset[1]);if(!asset)throw new Error('模型未登记');
        return await fileResponse(req,res,await fs.realpath(store.assetPath(asset)));
      }
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, {
        manifest_path: store.manifestPath,
        review_id: store.manifest.review_id,
        base_revision: store.manifest.base_revision,
        pid: process.pid,
      });
      if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.state());
      if (pathname === '/api/review/finish' && req.method === 'POST') {
        if(tours.running.size)throw new Error('请先完成或取消视频任务');
        const result = await store.finishReview();
        json(res, 200, result);
        if (closeOnFinish) setTimeout(() => server.close(), 250);
        return;
      }
      if (pathname === '/api/views' && req.method === 'POST') return json(res, 201, await store.saveView(await bodyJson(req)));
      if (pathname === '/api/issues' && req.method === 'POST') return json(res, 201, await store.saveIssue(await bodyJson(req)));
      const issueMatch = /^\/api\/issues\/([A-Za-z0-9_-]+_I\d+)$/.exec(pathname);
      if (issueMatch && req.method === 'DELETE') return json(res, 200, await store.deleteIssue(issueMatch[1]));
      const reviewMatch = /^\/api\/issues\/([A-Za-z0-9_-]+_I\d+)\/review$/.exec(pathname);
      if (reviewMatch && req.method === 'POST') {
        const body = await bodyJson(req);
        return json(res, 200, await store.reviewIssue(reviewMatch[1], body.status, body.result_revision));
      }
      if (pathname === '/asset/B' && ['GET', 'HEAD'].includes(req.method)) {
        const asset = await store.verifyAsset('B');
        return await fileResponse(req, res, asset.file);
      }
      if (pathname.startsWith('/display/') && ['GET', 'HEAD'].includes(req.method)) {
        const asset = await store.verifyAsset('G');
        const name = pathname.slice('/display/'.length);
        const stem = path.basename(asset.file, '.rad');
        if (name.includes('/') || !(name === path.basename(asset.file) || (name.startsWith(`${stem}-`) && name.endsWith('.radc')))) throw new Error('显示文件不属于扫描资产');
        const file = name === path.basename(asset.file) ? asset.file : await store.verifyDisplayChunk(name);
        return await fileResponse(req, res, file);
      }
      if (pathname.startsWith('/file/') && ['GET', 'HEAD'].includes(req.method)) {
        const rel = pathname.slice('/file/'.length);
        if (!/^(views|results)\//.test(rel)) throw new Error('文件路径不允许');
        const file = path.resolve(store.packageDir, rel);
        if (!inside(store.packageDir, file)) throw new Error('文件路径越界');
        const real = await fs.realpath(file);
        if (!inside(await fs.realpath(store.packageDir), real)) throw new Error('文件真实路径越界');
        return await fileResponse(req, res, real);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const candidate = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
        const file = inside(dist, candidate) ? candidate : null;
        if (file && await fs.stat(file).then((s) => s.isFile()).catch(() => false)) return await fileResponse(req, res, file);
        return await fileResponse(req, res, path.join(dist, 'index.html'));
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : 400;
      if (!res.headersSent) json(res, status, { error: error.message });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  server.on('close',()=>{void tours.close();});
  return { server, store, tours, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const idx = process.argv.indexOf('--manifest');
  const manifestPath = idx >= 0 ? process.argv[idx + 1] : process.env.REVIEW_MANIFEST;
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 4173;
  createReviewServer({ manifestPath, port, closeOnFinish: true }).then(({ url }) => {
    process.stdout.write(`网页审阅器：${url}\n审阅包：${path.resolve(manifestPath)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
