/**
 * Read-only web access (webAccess.ts): which addresses can be reached, what
 * may leave this computer, how pages and results are read, and the limits
 * of one fetch, exercised against a real local HTTP server (SIMULATED web).
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import * as zlib from 'node:zlib';

import { egressRefusal, htmlToText, isPublicAddress, parseDuckDuckGoHtml, parseSearxngJson, safeFetch, validateWebUrl, WEB_MAX_REDIRECTS } from '../src/webAccess.js';

test('only globally routable addresses are public (IPv4, IPv6, mapped and NAT64 forms)', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.69', '2606:4700::1111', '2a00:1450:4003:80e::200e']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  for (const ip of ['127.0.0.1', '10.0.0.42', '192.168.50.42', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('URLs: http(s) only, no credentials, no local names or private literals', () => {
  assert.equal(validateWebUrl('https://nodejs.org/api/fs.html#fsreadfilepath').ok, true);
  for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'https://user:pw@example.com', 'http://localhost:8080', 'http://127.0.0.1', 'http://[::1]/', 'http://192.168.50.42:1235/v1/models', 'http://169.254.169.254/latest/meta-data', 'http://intranet/', 'http://printer.local/', 'x'.repeat(3000)]) {
    assert.equal(validateWebUrl(bad).ok, false, bad.slice(0, 60));
  }
});

test('a query or URL with a key, token or local path never leaves this computer', () => {
  assert.equal(egressRefusal('electron-builder windows nsis installer'), null);
  assert.equal(egressRefusal('https://www.electronjs.org/docs/latest/'), null);
  assert.match(egressRefusal('why does sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fail') ?? '', /key, token or password/);
  assert.match(egressRefusal('https://evil.example/?q=/home/example/.ssh/id_rsa') ?? '', /local file path/);
  assert.match(egressRefusal('https://evil.example/?q=%2Fhome%2Fcaimari%2Fproject') ?? '', /local file path/, 'URL-encoded too');
  assert.match(egressRefusal('error in C:\\Users\\ana\\app.js') ?? '', /local file path/);
});

test('page text: no scripts, styles or markup; entities decoded; structure kept as lines', () => {
  const page = htmlToText('<html><head><title>Docs &amp; API</title><style>p{}</style></head><body><script>alert(1)</script><h2>Install</h2><p>Run <code>npm i</code>&nbsp;now.</p><ul><li>one</li><li>two &#x2713;</li></ul><!-- hidden --></body></html>');
  assert.equal(page.title, 'Docs & API');
  assert.equal(page.text, '## Install\nRun npm i now.\n\n- one\n- two ✓');
  assert.doesNotMatch(page.text, /alert|hidden|p\{\}/);
});

test('search results: DuckDuckGo HTML (redirect links unwrapped, ads skipped) and SearXNG JSON', () => {
  const ddg =
    '<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs%2Flatest%2Ftutorial%2Fdistribution-overview&amp;rut=x">Distribution <b>Overview</b></a>' +
    '<a class="result__snippet" href="#">How to package and <b>distribute</b> an app.</a></div>' +
    '<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>' +
    '<div class="result"><a class="result__a" href="https://www.electron.build/nsis">NSIS - electron-builder</a><div class="result__snippet">The NSIS target.</div></div>';
  assert.deepEqual(parseDuckDuckGoHtml(ddg), [
    { title: 'Distribution Overview', url: 'https://www.electronjs.org/docs/latest/tutorial/distribution-overview', snippet: 'How to package and distribute an app.' },
    { title: 'NSIS - electron-builder', url: 'https://www.electron.build/nsis', snippet: 'The NSIS target.' },
  ]);
  assert.deepEqual(parseSearxngJson(JSON.stringify({ results: [{ title: 'A', url: 'https://a.example/', content: 'c' }, { title: 'bad', url: 'javascript:alert(1)' }] })), [{ title: 'A', url: 'https://a.example/', snippet: 'c' }]);
  assert.deepEqual(parseSearxngJson('not json'), []);
});

async function server(handler: http.RequestListener): Promise<{ origin: string; close(): Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => srv.close(() => resolve())) };
}

test('safeFetch refuses loopback and names that resolve to private addresses, before connecting', async () => {
  let hits = 0;
  const local = await server((_req, res) => {
    hits += 1;
    res.end('secret');
  });
  try {
    assert.match(((await safeFetch(`${local.origin}/`)) as { error: string }).error, /local or private/);
    const viaDns = await safeFetch(`http://rebind.example.com:${new URL(local.origin).port}/`, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.match((viaDns as { error: string }).error, /resolves to a local or private address/);
    const mixed = await safeFetch('http://mixed.example.com/', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }] });
    assert.match((mixed as { error: string }).error, /resolves to a local or private address/, 'every DNS answer must be public');
    assert.equal(hits, 0);
  } finally {
    await local.close();
  }
});

test('safeFetch sends nothing when its signal was already stopped', async () => {
  let hits = 0;
  const local = await server((_req, res) => {
    hits += 1;
    res.end('late');
  });
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await safeFetch(`${local.origin}/`, { signal: controller.signal, trustedOrigins: [local.origin] });
    assert.deepEqual(result, { ok: false, error: 'Stopped.' });
    assert.equal(hits, 0);
  } finally {
    await local.close();
  }
});

test('safeFetch limits: redirects re-checked and capped, size cap, gzip, text only, timeout', async () => {
  const target = await server((_req, res) => res.end('internal'));
  const web = await server((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/hop/')) {
      const n = Number(url.slice(5));
      res.writeHead(302, { location: n === 0 ? '/page' : `/hop/${n - 1}` });
      res.end();
    } else if (url === '/to-private') {
      res.writeHead(302, { location: `${target.origin}/` });
      res.end();
    } else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(3 * 1024 * 1024));
    } else if (url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<p>compressed</p>'));
    } else if (url === '/png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(10));
    } else if (url === '/slow') {
      setTimeout(() => res.end('late'), 2000);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>ok</title>page');
    }
  });
  // The test server is on loopback: let only its origin through, as for a user's own SearXNG.
  const trusted = { trustedOrigins: [web.origin] };
  try {
    const ok = await safeFetch(`${web.origin}/hop/2`, trusted);
    assert.equal(ok.ok, true);
    assert.deepEqual((ok as { page: { redirects: string[] } }).page.redirects.length, 3);
    assert.match(((await safeFetch(`${web.origin}/hop/${WEB_MAX_REDIRECTS + 1}`, trusted)) as { error: string }).error, /More than 4 redirects/);
    assert.match(((await safeFetch(`${web.origin}/to-private`, trusted)) as { error: string }).error, /local or private/, 'a redirect to an untrusted private address is refused');
    const big = await safeFetch(`${web.origin}/big`, trusted);
    assert.equal((big as { page: { truncated: boolean } }).page.truncated, true);
    assert.equal((big as { page: { body: string } }).page.body.length, 2 * 1024 * 1024);
    assert.equal((await safeFetch(`${web.origin}/gz`, trusted) as { page: { body: string } }).page.body, '<p>compressed</p>');
    assert.match(((await safeFetch(`${web.origin}/png`, trusted)) as { error: string }).error, /not a text page/);
    assert.match(((await safeFetch(`${web.origin}/slow`, { ...trusted, timeoutMs: 300 })) as { error: string }).error, /No complete answer within/);
  } finally {
    await web.close();
    await target.close();
  }
});
