import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FFmpeg, run } from '../server/ffmpeg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const results = path.join(root, 'test', 'results', `run-${Date.now()}`);
await fs.mkdir(fixtures, { recursive: true }); await fs.mkdir(results, { recursive: true });
const ffmpeg = new FFmpeg(); await ffmpeg.initialize();
assert(ffmpeg.status.ready, ffmpeg.status.error);
const a = path.join(fixtures, "素材 one 'quoted'.mp4"), b = path.join(fixtures, 'silent-wide.mp4'), av1 = path.join(fixtures, 'av1-source.mkv');
await run(ffmpeg.path, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', a]);
await run(ffmpeg.path, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', b]);
const av1Encoder = ffmpeg.status.encoders.find(e => e.codec === 'av1' && e.hardware && e.available)?.id || 'libaom-av1';
await run(ffmpeg.path, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-t', '1', '-c:v', av1Encoder, ...(av1Encoder === 'libaom-av1' ? ['-cpu-used', '8', '-crf', '38'] : []), av1]);
const port = Number(process.env.TEST_PORT || 3219), base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/app.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), FRAME_DATA_DIR: path.join(results, 'state'), FRAME_OUTPUT_DIR: path.join(results, 'exports'), FFMPEG_PATH: ffmpeg.path, FFPROBE_PATH: ffmpeg.probePath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serviceLog = ''; service.stdout.on('data', d => { serviceLog += d; }); service.stderr.on('data', d => { serviceLog += d; });
const wait = ms => new Promise(r => setTimeout(r, ms));
let token = '', passed = 0;
const report = label => { passed++; console.log(`PASS ${String(passed).padStart(2, '0')} ${label}`); };
async function api(route, data, expected = 200) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-Token': token }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
}
async function job(operation, files, options = {}, extra = {}) {
  const created = await api('/api/jobs', { operation, fileIds: files.map(f => f.id), options, ...extra }, 201);
  for (let i = 0; i < 600; i++) {
    const tasks = await api('/api/jobs'), task = tasks.find(t => t.id === created.id);
    if (['failed', 'cancelled', 'completed'].includes(task.status)) { assert.equal(task.status, 'completed', task.error || task.log); return { ...task, media: await ffmpeg.probe(task.outputPath) }; }
    await wait(150);
  }
  throw new Error(`${operation} timeout`);
}
const closeDuration = (value, target, tolerance = .15) => assert(Math.abs(value - target) <= tolerance, `duration ${value}, expected ${target}`);
const digest = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');

try {
  for (let i = 0; i < 100; i++) {
    try { const boot = await api('/api/bootstrap'); token = boot.token; if (boot.system.ready && !boot.system.checking) break; }
    catch { if (service.exitCode !== null) throw new Error(serviceLog); }
    await wait(250);
  }
  const status = await api('/api/status'); assert(status.ready); assert(!status.checking);
  const noToken = await fetch(base + '/api/jobs', { method: 'POST', body: '{}' }); assert.equal(noToken.status, 403);
  const badOrigin = await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://foreign.example' } }); assert.equal(badOrigin.status, 403);
  report('loopback API rejects missing token and foreign Origin');
  const listing = await api(`/api/browse?path=${encodeURIComponent(fixtures)}`); assert(listing.entries.some(e => e.path === a));
  const loaded = await api('/api/files', { paths: [a, b, av1] }); assert.equal(loaded.errors.length, 0); assert.equal(loaded.files.length, 3);
  const [first, second, av1File] = loaded.files;
  assert.equal(av1File.video.codec, 'av1'); report('local browser and metadata support Chinese, spaces, apostrophes and AV1');
  const range = await fetch(`${base}/api/media/${first.id}`, { headers: { Range: 'bytes=0-99' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
  const invalidRange = await fetch(`${base}/api/media/${first.id}`, { headers: { Range: 'bytes=999999999999-' } }); assert.equal(invalidRange.status, 416);
  const thumb = await fetch(`${base}/api/media/${first.id}/thumb?time=1.5`); assert.equal(thumb.status, 200); assert((await thumb.arrayBuffer()).byteLength > 2000); report('media byte ranges and FFmpeg thumbnails');
  let proxy;
  for (let i = 0; i < 100; i++) {
    proxy = await api('/api/preview-media', { id: av1File.id });
    if (proxy.ready || proxy.error) break;
    await wait(100);
  }
  assert(proxy.ready, proxy.error || 'preview timeout');
  assert.equal((await ffmpeg.probe(proxy.path)).video.codec, 'h264');
  const proxyRange = await fetch(`${base}/api/media/${av1File.id}/preview`, { headers: { Range: 'bytes=0-99' } }); assert.equal(proxyRange.status, 206); await proxyRange.arrayBuffer();
  report('compatible H.264 preview generated from original AV1');
  assert(first.video.bitRate > 0);
  const trim = await job('trim', [first], { trimPreset: 'high', start: .7, end: 2.7 }); closeDuration(trim.media.duration, 2); assert.equal(trim.media.video.codec, 'h264'); report('quality preset accurate trim and default automatic encoder');
  const preserved = await job('trim', [av1File], { start: 0, end: .8 });
  assert.equal(preserved.media.video.codec, 'av1'); assert.equal(preserved.extension, 'mkv'); assert.match(preserved.command, /-c copy/); report('default trim preserves AV1 and original MKV container');
  const compact = await job('trim', [first], { trimPreset: 'small', start: .5, end: 2.5 });
  closeDuration(compact.media.duration, 2); assert(compact.estimatedSize > 0); assert.equal(compact.media.video.width, 640); assert(compact.command.includes('-b:a 128k')); report('size preset with source-derived bitrate and size estimate');
  for (const codec of ['h264', 'hevc', 'av1']) {
    for (const device of ['cpu', 'auto']) {
      if (device === 'auto' && !status.encoders.some(e => e.codec === codec && e.hardware && e.available)) continue;
      if (!status.encoders.some(e => e.codec === codec && !e.hardware && e.available)) continue;
      const custom = await job('trim', [first], { trimPreset: 'high', codec, encoder: device, rateControl: 'bitrate', videoBitrateMbps: .6, audioBitrateKbps: 96, start: .5, end: 1.5 });
      assert.equal(custom.media.video.codec, codec); closeDuration(custom.media.duration, 1); assert.match(custom.command, /-b:v 0.6M/); assert(!custom.command.includes('-cq')); assert.equal(custom.estimatedSize, 87000);
      report(`custom bitrate trim: ${codec}, ${device}`);
    }
  }
  const copied = await job('trim', [first], { start: 1, end: 3, mode: 'copy' }); assert(copied.warnings.length); assert(copied.media.duration > 0); report('keyframe copy trim with explicit boundary warning');
  const converted = await job('transcode', [av1File], { codec: 'h264', height: '480', fps: '24' }); assert.equal(converted.media.video.codec, 'h264'); assert.equal(converted.media.video.height, 480); assert.equal(converted.media.video.fps, 24); report('real AV1 input to H.264 with scale and frame-rate conversion');
  for (const codec of ['h264', 'hevc', 'av1']) {
    const encoder = status.encoders.find(e => e.codec === codec && e.hardware && e.available);
    if (!encoder) continue;
    const accelerated = await job('transcode', [av1File], { codec, encoder: encoder.id });
    assert.equal(accelerated.media.video.codec, codec); report(`${encoder.id} hardware export`);
  }
  const merged = await job('concat', [first, second], { mode: 'normalize', height: '480', fps: '30' }); closeDuration(merged.media.duration, 6); assert.equal(merged.media.audio.length, 1); assert.equal(merged.media.video.height, 480); report('concat mismatched sizes/fps and silent source');
  const fastMerge = await job('concat', [first, first], { mode: 'copy' }); closeDuration(fastMerge.media.duration, 8, .25); report('stream-copy concat with apostrophe paths');
  const extracted = await job('audio', [first], { action: 'extract', format: 'mp3' }); assert.equal(extracted.media.video, null); assert.equal(extracted.media.audio[0].codec, 'mp3'); report('MP3 audio extraction');
  const muted = await job('audio', [first], { action: 'mute' }); assert.equal(muted.media.audio.length, 0); assert.equal(muted.media.video.codec, 'h264'); report('remove audio without re-encoding video');
  const volume = await job('audio', [first], { action: 'volume', volume: 50 }); assert.equal(volume.media.audio[0].codec, 'aac'); report('volume filter and copied video');
  const replacedAudio = await job('audio', [second, first], { action: 'replace' }); closeDuration(replacedAudio.media.duration, 2); assert.equal(replacedAudio.media.audio.length, 1); report('replace audio, bounded by video duration');
  const resize = await job('resize', [first], { rotate: '90', flip: true, codec: 'h264' }); assert.equal(resize.media.video.width, 360); assert.equal(resize.media.video.height, 640); report('rotate and mirror dimensions');
  const gif = await job('gif', [first], { start: .5, end: 1.5, width: 320, fps: 8 }); assert.equal(gif.media.video.codec, 'gif'); assert.equal(gif.media.video.width, 320); report('palette-optimized GIF export');
  const snapshot = await job('snapshot', [first], { time: 1.2, format: 'png' }); assert.equal(snapshot.media.video.codec, 'png'); assert.equal(snapshot.media.video.width, 640); report('full-size PNG frame export');
  const remux = await job('remux', [first], { container: 'mkv' }, { outputName: 'unique-name' }); assert.equal(remux.media.video.codec, 'h264'); report('lossless remux');
  const sameName = await job('remux', [first], { container: 'mkv' }, { outputName: 'unique-name' }); assert.notEqual(sameName.outputPath, remux.outputPath); report('existing output never overwritten');
  await api('/api/jobs', { operation: 'trim', fileIds: [first.id], options: { start: -1, end: 2 } }, 400);
  await api('/api/jobs', { operation: 'concat', fileIds: [first.id, second.id], options: { mode: 'copy' } }, 400);
  report('invalid ranges and incompatible copy-concat rejected');
  const copiedSource = path.join(results, 'replace-me.mp4'); await fs.copyFile(a, copiedSource);
  const originalHash = await digest(copiedSource);
  const added = await api('/api/files', { paths: [copiedSource] });
  const replacementJob = await job('remux', added.files, { container: 'mkv' }); assert(replacementJob.replaceable);
  await api(`/api/jobs/${replacementJob.id}/replace`, { confirmName: 'replace-me.mp4' }, 400);
  await api(`/api/jobs/${replacementJob.id}/replace-prepare`, { acknowledged: false }, 400);
  const plan = await api(`/api/jobs/${replacementJob.id}/replace-plan`); assert(plan.formatChanged);
  const firstConfirm = await api(`/api/jobs/${replacementJob.id}/replace-prepare`, { acknowledged: true });
  await api(`/api/jobs/${replacementJob.id}/replace`, { token: firstConfirm.token, confirmName: 'wrong.mp4' }, 400);
  assert.equal(await digest(copiedSource), originalHash);
  const secondConfirm = await api(`/api/jobs/${replacementJob.id}/replace-prepare`, { acknowledged: true });
  const replaced = await api(`/api/jobs/${replacementJob.id}/replace`, { token: secondConfirm.token, confirmName: 'replace-me.mp4' });
  assert.equal(await digest(replaced.replacement.backupPath), originalHash);
  assert.equal((await ffmpeg.probe(replaced.replacement.targetPath)).video.codec, 'h264');
  assert.equal(replaced.outputPath, replaced.replacement.targetPath);
  await assert.rejects(fs.access(replacementJob.outputPath));
  assert.equal((await fs.readdir(replaced.replacement.backupDirectory)).length, 1);
  const movedResult = await fetch(`${base}/api/jobs/${replacementJob.id}/media`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(movedResult.status, 206); await movedResult.arrayBuffer();
  await api(`/api/jobs/${replacementJob.id}/replace`, { token: secondConfirm.token, confirmName: 'replace-me.mp4' }, 400);
  report('two-stage replacement checks, single-use token, backup and new extension');
  const restoreConfirm = await api(`/api/jobs/${replacementJob.id}/restore-prepare`, { acknowledged: true });
  const restored = await api(`/api/jobs/${replacementJob.id}/restore`, { token: restoreConfirm.token, confirmName: 'replace-me.mp4' });
  assert(restored.replacement.restoredAt); assert.equal(await digest(copiedSource), originalHash); report('two-stage restoration recovers byte-identical original');
  assert.equal(restored.outputPath, restored.replacement.replacedBackup);
  await assert.rejects(fs.access(restored.replacement.backupPath));
  assert.equal((await fs.readdir(restored.replacement.backupDirectory)).length, 1);
  assert.equal((await ffmpeg.probe(restored.outputPath)).video.codec, 'h264');
  report('replacement and restore keep two files and result endpoints follow the moved output');
  let cleanupPlan = await api('/api/storage/plan', {});
  const backupEntry = cleanupPlan.entries.find(e => e.path === restored.outputPath);
  assert(backupEntry); assert.equal(backupEntry.defaultSelected, false);
  await api('/api/storage/clean', { token: cleanupPlan.token, entryIds: [backupEntry.id], confirmed: false }, 400);
  await fs.access(restored.outputPath);
  await api('/api/storage/clean', { token: cleanupPlan.token, entryIds: ['unknown'], confirmed: true }, 400);
  cleanupPlan = await api('/api/storage/plan', {});
  const cleanupResult = await api('/api/storage/clean', { token: cleanupPlan.token, entryIds: [cleanupPlan.entries.find(e => e.path === restored.outputPath).id], confirmed: true });
  assert.equal(cleanupResult.removed.length, 1); assert.equal(cleanupResult.skipped.length, 0);
  assert.equal(await digest(copiedSource), originalHash);
  assert((await api('/api/jobs')).find(j => j.id === restored.id).resultCleanedAt);
  await api(`/api/jobs/${restored.id}/media`, undefined, 400);
  report('reviewed cleanup removes only the chosen test backup and preserves the restored original');
  const renameSource = path.join(results, 'rename-original.mp4'); await fs.copyFile(a, renameSource);
  const renameInput = await api('/api/files', { paths: [renameSource] });
  const renameJob = await job('remux', renameInput.files, { container: 'mkv' });
  const renamePlan = await api(`/api/jobs/${renameJob.id}/replace-plan`, { targetName: '改名后的片段', mode: 'backup' });
  assert.equal(renamePlan.targetFileName, '改名后的片段.mkv');
  let approval = await api(`/api/jobs/${renameJob.id}/replace-prepare`, { acknowledged: true, targetName: renamePlan.targetName, mode: 'backup' });
  await api(`/api/jobs/${renameJob.id}/replace`, { token: approval.token, confirmed: true, mode: 'overwrite', overwriteAcknowledged: true }, 400);
  assert.equal(await digest(renameSource), originalHash);
  approval = await api(`/api/jobs/${renameJob.id}/replace-prepare`, { acknowledged: true, targetName: renamePlan.targetName, mode: 'backup' });
  await api(`/api/jobs/${renameJob.id}/replace`, { token: approval.token, confirmed: true, targetName: 'changed.mkv' }, 400);
  approval = await api(`/api/jobs/${renameJob.id}/replace-prepare`, { acknowledged: true, targetName: renamePlan.targetName, mode: 'backup' });
  const renamed = await api(`/api/jobs/${renameJob.id}/replace`, { token: approval.token, confirmed: true });
  assert(renamed.restorable); assert.equal(path.basename(renamed.outputPath), '改名后的片段.mkv');
  assert.equal(await digest(renamed.replacement.backupPath), originalHash); await assert.rejects(fs.access(renameSource));
  assert.equal((await ffmpeg.probe(renamed.outputPath)).video.codec, 'h264');
  const renameRestoreToken = await api(`/api/jobs/${renameJob.id}/restore-prepare`, { acknowledged: true });
  await api(`/api/jobs/${renameJob.id}/restore`, { token: renameRestoreToken.token, confirmName: 'rename-original.mp4' });
  assert.equal(await digest(renameSource), originalHash);
  report('custom replacement name, sealed confirmation settings and restoration to original name');
  const priorResult = await job('remux', [first], { container: 'mov' }, { outputName: 'overwrite-input' });
  const overwriteInput = await api('/api/files', { paths: [priorResult.outputPath] });
  const overwriteJob = await job('trim', overwriteInput.files, { trimPreset: 'high', start: .4, end: 1.9 });
  const protectedHash = await digest(priorResult.outputPath);
  let overwriteApproval = await api(`/api/jobs/${overwriteJob.id}/replace-prepare`, { acknowledged: true, targetName: '直接覆盖后', mode: 'overwrite' });
  await api(`/api/jobs/${overwriteJob.id}/replace`, { token: overwriteApproval.token, confirmed: true }, 400);
  assert.equal(await digest(priorResult.outputPath), protectedHash);
  overwriteApproval = await api(`/api/jobs/${overwriteJob.id}/replace-prepare`, { acknowledged: true, targetName: '直接覆盖后', mode: 'overwrite' });
  const overwritten = await api(`/api/jobs/${overwriteJob.id}/replace`, { token: overwriteApproval.token, confirmed: true, overwriteAcknowledged: true });
  assert.equal(path.basename(overwritten.outputPath), '直接覆盖后.mp4'); assert.equal(overwritten.replacement.backupPath, null); assert.equal(overwritten.restorable, false);
  closeDuration((await ffmpeg.probe(overwritten.outputPath)).duration, 1.5);
  await assert.rejects(fs.access(priorResult.outputPath)); await assert.rejects(fs.access(overwriteJob.outputPath));
  await api(`/api/jobs/${overwriteJob.id}/restore-prepare`, { acknowledged: true }, 400);
  assert((await api('/api/jobs')).find(j => j.id === priorResult.id).resultCleanedAt);
  await api(`/api/jobs/${priorResult.id}/media`, undefined, 400);
  assert(!(await api('/api/storage/plan', {})).entries.some(e => e.path === overwritten.outputPath));
  report('explicit irreversible overwrite renames a real video, removes only its original, and disables restoration');
  const pending = await api('/api/jobs', { operation: 'transcode', fileIds: [first.id], options: { codec: 'av1', encoder: 'cpu', height: '2160' } }, 201);
  await api(`/api/jobs/${pending.id}/cancel`, {});
  await wait(300);
  const cancelled = (await api('/api/jobs')).find(j => j.id === pending.id); assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(fs.access(cancelled.outputPath)); report('cancel terminates export without publishing partial output');
  console.log(`\n${passed} integration checks passed. Evidence: ${results}`);
  await fs.writeFile(path.join(results, 'verification.json'), JSON.stringify({ passed, ffmpeg: status.version, hardware: status.encoders.filter(e => e.available && e.hardware).map(e => e.id), results, finishedAt: new Date().toISOString() }, null, 2));
} catch (err) {
  console.error(err); console.error(serviceLog); process.exitCode = 1;
} finally { service.kill(); }
