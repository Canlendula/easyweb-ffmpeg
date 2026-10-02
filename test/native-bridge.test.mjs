import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeRevealBridge } from '../server/native-bridge.mjs';

async function fixture(fn) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-native-test-'));
  try {
    const outputPath = path.join(folder, '中文 clip.mp4'); await fs.writeFile(outputPath, 'VIDEO');
    const stat = await fs.stat(outputPath);
    const job = { id: 'test-job', status: 'completed', outputPath, size: stat.size, outputModified: stat.mtimeMs };
    let now = 1000;
    const bridge = new NativeRevealBridge({ enabled: true, secret: 'a'.repeat(64), clock: () => now });
    await fn({ job, bridge, advance: ms => { now += ms; } });
  } finally {
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith('frame-native-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
const visible = { folderMatched: true, visible: true, minimized: false, foreground: true, selected: true, windowHandle: 1234 };

test('native protocol carries only an opaque ticket, with separate native authentication', async () => fixture(async ({job, bridge}) => {
  const offer = bridge.offer(job);
  assert.match(offer.url, /^frame-local-reveal:\/\/reveal\/[a-f0-9]{64}$/);
  assert(!offer.url.includes(job.outputPath)); assert(!offer.url.includes(bridge.secret));
  assert(bridge.authorized('a'.repeat(64))); assert(!bridge.authorized('b'.repeat(64)));
  assert(!bridge.authorized('汉'.repeat(64))); assert(!bridge.authorized(''));
  assert.equal(new NativeRevealBridge().offer(job), null);
}));
test('a ticket is claimed once and cannot report success before a claim', async () => fixture(async ({job, bridge}) => {
  const offer = bridge.offer(job); assert.equal(bridge.offer(job).id, offer.id);
  assert.throws(() => bridge.complete(offer.id, visible));
  assert.equal((await bridge.claim(offer.id, () => job)).path, job.outputPath);
  await assert.rejects(() => bridge.claim(offer.id, () => job), /已使用/);
  bridge.complete(offer.id, visible);
  assert.equal(bridge.status(offer.id).result.foreground, true);
  assert.throws(() => bridge.complete(offer.id, visible));
  assert.notEqual(bridge.offer(job).id, offer.id);
}));
test('expired, cancelled and changed outputs cannot be opened by old tickets', async () => fixture(async ({job, bridge, advance}) => {
  const expired = bridge.offer(job); advance(180001);
  await assert.rejects(() => bridge.claim(expired.id, () => job), /过期/);
  const cancelled = bridge.offer(job); bridge.cancel(cancelled.id);
  await assert.rejects(() => bridge.claim(cancelled.id, () => job), /取消/);
  const moved = bridge.offer(job);
  await assert.rejects(() => bridge.claim(moved.id, () => ({ ...job, outputPath: job.outputPath + '.changed' })), /位置已变化/);
  const changed = bridge.offer(job); await fs.appendFile(job.outputPath, 'CHANGED');
  await assert.rejects(() => bridge.claim(changed.id, () => job), /文件已变化/);
}));
test('native evidence distinguishes visible foreground, visible background and hidden failure', async () => fixture(async ({job, bridge}) => {
  const background = bridge.offer(job); await bridge.claim(background.id, () => job);
  bridge.complete(background.id, { ...visible, foreground: false });
  assert.equal(bridge.status(background.id).result.foreground, false);
  const hidden = bridge.offer(job); await bridge.claim(hidden.id, () => job);
  bridge.complete(hidden.id, { ...visible, visible: false });
  assert.equal(bridge.status(hidden.id).state, 'failed');
  const error = bridge.offer(job); await bridge.claim(error.id, () => job);
  bridge.complete(error.id, { error: 'Native failure' });
  assert.equal(bridge.status(error.id).error, 'Native failure');
}));
test('stalled helpers time out and cleaned results do not get a protocol link', async () => fixture(async ({job, bridge, advance}) => {
  const offer = bridge.offer(job); await bridge.claim(offer.id, () => job); advance(31000);
  assert.equal(bridge.status(offer.id).state, 'failed');
  assert.equal(bridge.offer({ ...job, resultCleanedAt: 1 }), null);
  assert.equal(bridge.offer({ ...job, status: 'queued' }), null);
}));
