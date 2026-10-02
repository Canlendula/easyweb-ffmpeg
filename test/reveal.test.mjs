import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { revealCommand, revealFile } from '../server/reveal.mjs';

test('Windows reveal passes literal Unicode and shell-sensitive paths outside the command', () => {
  const file = "D:\\中文 folder\\it's $a & clip.mp4";
  const plan = revealCommand(file, 'win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(plan.options.env.FRAME_REVEAL_PATH, file); assert.equal(plan.options.shell, false);
  assert(!plan.args.join(' ').includes(file));
  const script = Buffer.from(plan.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /SHOpenFolderAndSelectItems/); assert.match(script, /ThrowExceptionForHR/);
  assert(!script.includes(file)); assert(!script.includes('/select,'));
});

const visibleWindow = { folderMatched: true, visible: true, minimized: false, foreground: true, selected: true, reused: false, windowHandle: 12345 };
function fakeProcess(code, stderr, result) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => { if (stderr) child.stderr.write(stderr); if (result !== undefined) child.stdout.write(JSON.stringify(result)); child.emit('close', code); });
    return child;
  };
}
test('reveal waits for a verified visible folder and surfaces asynchronous errors', async () => {
  const file = fileURLToPath(import.meta.url);
  const result = await revealFile(file, { platform: 'win32', spawnProcess: fakeProcess(0, '', visibleWindow) });
  assert.equal(result.verified, true); assert.equal(result.foreground, true); assert.equal(result.selected, true);
  await assert.rejects(() => revealFile(file, { spawnProcess: fakeProcess(1, 'Shell error') }), /Shell error/);
});
test('a successful process exit cannot report a hidden, minimized or wrong folder as opened', async () => {
  const file = fileURLToPath(import.meta.url);
  await assert.rejects(() => revealFile(file, { platform: 'win32', spawnProcess: fakeProcess(0) }), /未返回/);
  for (const changes of [{ visible: false }, { minimized: true }, { folderMatched: false }, { windowHandle: 0 }]) {
    await assert.rejects(() => revealFile(file, { platform: 'win32', spawnProcess: fakeProcess(0, '', { ...visibleWindow, ...changes }) }), /未成功显示/);
  }
});
test('a visible background window is explicitly distinguished from foreground success', async () => {
  const result = await revealFile(fileURLToPath(import.meta.url), { platform: 'win32', spawnProcess: fakeProcess(0, '', { ...visibleWindow, foreground: false, selected: false }) });
  assert.equal(result.verified, true); assert.equal(result.foreground, false); assert.equal(result.selected, false);
});
