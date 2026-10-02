// HTTP contract checks only. This test never invokes a URI handler or opens Explorer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') { console.log('Native HTTP contract skipped outside Windows.'); process.exit(0); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test', 'results'); await fs.mkdir(results, { recursive: true });
const directory = await fs.mkdtemp(path.join(results, 'native-http-'));
const nativeDir = path.join(directory, 'native-bridge'); await fs.mkdir(nativeDir);
const port = Number(process.env.TEST_NATIVE_PORT || 3225), base = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString('hex'), outputPath = path.join(directory, 'contract-only.mp4');
await fs.writeFile(outputPath, 'HTTP CONTRACT FIXTURE');
// An existence marker models an installed bridge; no native executable is launched in this test.
await fs.writeFile(path.join(nativeDir, 'FrameReveal.exe'), '');
await fs.writeFile(path.join(nativeDir, 'config.json'), JSON.stringify({ installed: true, port, secret }));
const stat = await fs.stat(outputPath), jobId = randomUUID();
await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify([{ id: jobId, status: 'completed', files: [], sourceNames: ['contract-only.mp4'], outputPath, size: stat.size, outputModified: stat.mtimeMs }]));
const server = spawn(process.execPath, ['server/app.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), FRAME_DATA_DIR: directory, FRAME_OUTPUT_DIR: path.join(directory, 'outputs') }, windowsHide: true, stdio: 'ignore' });
let token, count = 0;
const check = label => { count++; console.log(`PASS ${count} ${label}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(route, { data, bridge = false, authenticated = false, origin, expected = 200 } = {}) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(bridge ? { 'X-Frame-Bridge': secret } : {}), ...(authenticated ? { 'X-Frame-Token': token } : {}), ...(origin ? { Origin: origin } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const payload = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(payload)}`); return payload;
}
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const bootstrap = await request('/api/bootstrap'); token = bootstrap.token; assert(bootstrap.nativeReveal.enabled); break; }
    catch { if (server.exitCode !== null) throw new Error('Test service failed to start'); await sleep(100); }
  }
  assert(token);
  const offer = (await request('/api/jobs'))[0].nativeReveal;
  assert(offer); assert.match(offer.url, /^frame-local-reveal:/); check('completed jobs expose an opaque protocol link');
  await request(`/api/native-reveal/${offer.id}/claim`, { data: {}, authenticated: true, expected: 403 });
  await request(`/api/native-reveal/${offer.id}/claim`, { data: {}, bridge: true, origin: 'https://foreign.example', expected: 403 });
  check('browser tokens and foreign origins cannot act as the native helper');
  const claimed = await request(`/api/native-reveal/${offer.id}/claim`, { data: {}, bridge: true });
  assert.equal(claimed.path, outputPath);
  await request(`/api/native-reveal/${offer.id}/claim`, { data: {}, bridge: true, expected: 400 });
  check('native authentication can claim exactly once');
  await request(`/api/native-reveal/${offer.id}/status`, { expected: 403 });
  assert.equal((await request(`/api/native-reveal/${offer.id}/status`, { authenticated: true })).state, 'claimed');
  check('status requires the browser session token');
  await request(`/api/native-reveal/${offer.id}/result`, { data: { folderMatched: true, visible: true, minimized: false, foreground: false, selected: true, windowHandle: 1234 }, bridge: true });
  const status = await request(`/api/native-reveal/${offer.id}/status`, { authenticated: true });
  assert.equal(status.state, 'completed'); assert.equal(status.result.foreground, false);
  await request(`/api/native-reveal/${offer.id}/result`, { data: {}, bridge: true, expected: 400 });
  check('reported background state stays explicit and a result cannot be replayed');
  const next = (await request('/api/jobs'))[0].nativeReveal;
  await request(`/api/native-reveal/${next.id}/cancel`, { data: {}, authenticated: true });
  await request(`/api/native-reveal/${next.id}/claim`, { data: {}, bridge: true, expected: 400 });
  check('cancellation invalidates a pending native launch');
  console.log(`${count} native HTTP contract checks passed (no Explorer invocation).`);
  await fs.writeFile(path.join(results, 'native-http-verification.json'), JSON.stringify({ passed: count, nativeProgramInvoked: false, checkedAt: new Date().toISOString() }, null, 2));
} finally {
  server.kill();
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(results).toLowerCase());
  assert(path.basename(resolved).startsWith('native-http-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
