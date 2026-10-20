'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createHttpsFetch, trustedCertificates} = require('../server/https-fetch.js');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

test('https transport sends method, headers and body, and reads status, headers and JSON', async () => {
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(201, {'Content-Type': 'application/json', 'X-WP-Total': '7'});
      res.end(JSON.stringify({method: req.method, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString()}));
    });
  }, async base => {
    const fetcher = createHttpsFetch();
    const r = await fetcher(base + '/wp-json/wp/v2/posts', {method: 'POST', headers: {Authorization: 'Basic abc', 'Content-Type': 'application/json'}, body: '{"title":"T"}', redirect: 'error'});
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('X-WP-Total'), '7');
    assert.equal(r.headers.get('missing'), null);
    assert.deepEqual(await r.json(), {method: 'POST', auth: 'Basic abc', type: 'application/json', body: '{"title":"T"}'});

    const upload = await fetcher(base + '/media', {method: 'POST', body: Buffer.from([1, 2, 3])});
    assert.equal((await upload.json()).body, '\u0001\u0002\u0003');
  });
});

test('https transport refuses redirects, rejects bad JSON in json(), and reports errors like fetch', async () => {
  await withServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, {Location: '/elsewhere'});
      return res.end();
    }
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 2000);
    res.writeHead(403, {'Content-Type': 'text/html'});
    res.end('<html>blocked</html>');
  }, async base => {
    const fetcher = createHttpsFetch();
    await assert.rejects(fetcher(base + '/redirect', {redirect: 'error'}), e => e.message === 'fetch failed' && /unexpected redirect \(HTTP 301\)/.test(e.cause.message));

    const html = await fetcher(base + '/html');
    assert.equal(html.ok, false);
    assert.equal(html.status, 403);
    await assert.rejects(html.json());

    const controller = new AbortController();
    const pending = fetcher(base + '/slow', {signal: controller.signal});
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, e => e.message === 'fetch failed' && e.cause.name === 'AbortError');
  });
  await assert.rejects(createHttpsFetch()('http://127.0.0.1:1/'), e => e.message === 'fetch failed' && e.cause.code === 'ECONNREFUSED');
});

test('trusted certificates include Node\'s bundled roots', () => {
  const list = trustedCertificates();
  if (list === undefined) return; // Node without tls.getCACertificates: Node's defaults are used.
  const {getCACertificates} = require('node:tls');
  assert(getCACertificates('bundled').every(pem => list.includes(pem)));
});
