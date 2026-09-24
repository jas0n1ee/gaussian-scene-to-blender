import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewStore, inside } from './lib/review-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary', '.rad': 'application/octet-stream', '.radc': 'application/octet-stream', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function bodyJson(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('提交内容过大');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
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
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, {
        manifest_path: store.manifestPath,
        review_id: store.manifest.review_id,
        base_revision: store.manifest.base_revision,
        pid: process.pid,
      });
      if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.state());
      if (pathname === '/api/review/finish' && req.method === 'POST') {
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
  return { server, store, url: `http://127.0.0.1:${server.address().port}` };
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
