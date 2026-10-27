import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { WebDavClient } from '../src/server/WebDavClient.js';

/**
 * WebDavClient COPY 降级回归
 * ------------------------------------------------------------------
 * 背景（2026-10-27 实机验收发现）：copy() 的 catch 会把「降级自身」的失败
 * 再次当成 COPY 异常处理，再调一次 copyViaDownloadUpload —— 服务端 COPY
 * 返回 405 且源文件 GET 失败时，会下载两次并误报「COPY 异常」。
 * 本文件用本地 HTTP 服务器复现该场景（不连真实网络）。
 */

function startServer(handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    (handlers[req.method] || handlers.default || (() => {
      res.writeHead(405);
      res.end();
    }))(req, res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

test('WebDavClient.copy: 降级下载失败时只尝试一次且错误指向下载失败', async () => {
  let getCount = 0;
  let putCount = 0;
  const { server, calls, base } = await startServer({
    COPY: (req, res) => { res.writeHead(405); res.end(); },
    GET: (req, res) => { getCount += 1; res.writeHead(500); res.end('boom'); },
    PUT: (req, res) => { putCount += 1; res.writeHead(201); res.end(); },
  });

  try {
    const client = new WebDavClient({ url: base, username: 'u', password: 'p', timeoutMs: 2000 });
    await assert.rejects(
      client.copy('src.zip', 'dst.zip'),
      (err) => {
        assert.match(err.message, /WebDAV 下载失败/, '错误应指向降级路径的下载失败');
        return true;
      },
    );
    assert.equal(getCount, 1, '降级失败后不得重复下载（修复前为 2 次）');
    assert.equal(putCount, 0, '下载失败时不应尝试上传');
    assert.equal(calls.filter(c => c.startsWith('COPY')).length, 1, 'COPY 请求只发一次');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('WebDavClient.copy: COPY 不受支持时降级为下载+上传并返回 via=fallback', async () => {
  const payload = Buffer.from('webdav-copy-fallback-payload');
  let putBody = null;
  const { server, calls, base } = await startServer({
    COPY: (req, res) => { res.writeHead(405); res.end(); },
    GET: (req, res) => { res.writeHead(200, { 'content-length': String(payload.length) }); res.end(payload); },
    PUT: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { putBody = Buffer.concat(chunks); res.writeHead(201); res.end(); });
    },
  });

  try {
    const client = new WebDavClient({ url: base, username: 'u', password: 'p', timeoutMs: 2000 });
    const result = await client.copy('src.zip', 'dst.zip');
    assert.deepEqual(result, { success: true, via: 'fallback' });
    assert.equal(putBody?.toString(), payload.toString(), '降级上传内容应与源文件一致');
    assert.ok(calls.includes('COPY /src.zip'), '应先尝试 COPY');
    assert.ok(calls.includes('GET /src.zip'), '降级应下载源文件');
    assert.ok(calls.includes('PUT /dst.zip'), '降级应上传到目标路径');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
