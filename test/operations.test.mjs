import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildOperation, safeName, encoding, displayCommand } from '../server/operations.mjs';
import { applyReplacement, replacementPlan, restoreOriginal } from '../server/replacement.mjs';
import { sourceVideoRate, trimPresetDefaults } from '../public/trim-presets.js';

const encoders = [{ id: 'libx264', codec: 'h264', hardware: false, available: true, label: 'CPU' }, { id: 'h264_nvenc', codec: 'h264', hardware: true, available: true, label: 'NVIDIA' }];
const file = { path: "D:\\素材\\it's a clip.mp4", name: "it's a clip.mp4", duration: 10, size: 100, video: { codec: 'h264', width: 640, height: 360, fps: 30, pixelFormat: 'yuv420p', timeBase: '1/15360' }, audio: [{ codec: 'aac', channels: 2, sampleRate: 48000 }], streams: [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'aac' }] };
const build = (operation, options = {}, files = [file]) => buildOperation({ operation, options }, files, encoders);

test('accurate trim seeks input and limits output duration', () => {
  const result = build('trim', { start: 2.5, end: 6.75, mode: 'accurate', encoder: 'cpu' });
  assert.equal(result.duration, 4.25); assert.equal(result.extension, 'mp4');
  assert.equal(result.args[result.args.indexOf('-ss') + 1], '2.5');
  assert.equal(result.args[result.args.indexOf('-t') + 1], '4.25');
  assert(result.args.includes('libx264')); assert(!result.args.includes('copy'));
});
test('copy trim explicitly warns about keyframe boundaries', () => {
  const result = build('trim', { start: 2, end: 5, mode: 'copy' });
  assert(result.args.includes('copy')); assert.match(result.warnings[0], /关键帧/); assert.equal(result.extension, 'mkv');
});
test('invalid and injected numeric options are rejected before spawning', () => {
  for (const options of [{ start: -1 }, { start: 8, end: 1 }, { end: Infinity }, { start: '1; rm' }, { end: 10.1 }]) assert.throws(() => build('trim', options));
  assert.throws(() => build('resize', { height: '720,evil' }));
  assert.throws(() => build('resize', { height: 721 }));
  assert.throws(() => build('transcode', { encoder: 'cmd.exe' }));
  assert.throws(() => build('audio', { action: 'extract', track: 99 }));
});
test('GPU selection uses only successfully probed encoders', () => {
  assert.equal(encoding({}, encoders).selected.id, 'h264_nvenc');
  assert.equal(encoding({}, [{ ...encoders[1], available: false }, encoders[0]]).selected.id, 'libx264');
  assert.equal(encoding({ encoder: 'auto' }, encoders).selected.id, 'h264_nvenc');
  assert.equal(encoding({ encoder: 'auto' }, [{ ...encoders[1], available: false }, encoders[0]]).selected.id, 'libx264');
  assert.throws(() => encoding({ encoder: 'h264_nvenc' }, [{ ...encoders[1], available: false }]));
});
test('default trim copies the source codec and container without needing an encoder', () => {
  const result = buildOperation({ operation: 'trim', options: { start: 1, end: 3 } }, [file], []);
  assert(result.args.includes('copy')); assert.equal(result.extension, 'mp4'); assert(!result.args.includes('-c:v'));
  const hdr = { ...file, name: 'hdr.webm', video: { ...file.video, codec: 'av1', colorTransfer: 'smpte2084' } };
  const copied = build('trim', { trimPreset: 'original' }, [hdr]);
  assert.equal(copied.extension, 'webm'); assert(!copied.warnings.some(w => w.includes('8-bit')));
});
test('size preset derives a bitrate budget from the source and includes an estimate', () => {
  const source = { ...file, video: { ...file.video, bitRate: 4000000 } };
  const result = build('trim', { trimPreset: 'small', start: 1, end: 3 }, [source]);
  assert.equal(result.args[result.args.indexOf('-b:v') + 1], '2.6M');
  assert.equal(result.args[result.args.indexOf('-b:a') + 1], '128k');
  assert(!result.args.includes('-cq')); assert(!result.args.includes('-crf'));
  assert.equal(result.estimatedSize, (2600000 + 128000) * 2 / 8);
});
test('quality preset performs accurate encoding with automatic GPU and editable quality', () => {
  const result = build('trim', { trimPreset: 'high', mode: 'copy', qualityValue: 17, start: 1.25, end: 3.25 });
  assert(result.args.includes('h264_nvenc')); assert.equal(result.duration, 2);
  assert.equal(result.args[result.args.indexOf('-cq') + 1], '17'); assert.equal(result.estimatedSize, null);
});
test('custom bitrate works on CPU and GPU without conflicting constant-quality flags', () => {
  for (const encoder of ['cpu', 'auto']) {
    const result = build('trim', { trimPreset: 'high', encoder, rateControl: 'bitrate', videoBitrateMbps: 1.25, audioBitrateKbps: 96 });
    assert.equal(result.args[result.args.indexOf('-b:v') + 1], '1.25M');
    assert.equal(result.args[result.args.indexOf('-maxrate') + 1], '1.875M');
    assert.equal(result.args[result.args.indexOf('-b:a') + 1], '96k');
    assert(!result.args.includes('-crf')); assert(!result.args.includes('-cq')); assert(!result.args.includes('-global_quality'));
  }
  for (const bitrate of ['', 0, -1, 301, Infinity, '1; calc']) assert.throws(() => build('trim', { trimPreset: 'small', videoBitrateMbps: bitrate }));
  assert.throws(() => build('trim', { trimPreset: 'high', audioBitrateKbps: '128k;cmd' }));
  assert.throws(() => build('trim', { trimPreset: 'unknown' }));
});
test('default bitrate uses metadata, marks estimates, and handles missing metadata', () => {
  assert.deepEqual(sourceVideoRate({ video: { bitRate: 2000000 } }), { bits: 2000000, estimated: false });
  assert.deepEqual(sourceVideoRate({ size: 1000000, duration: 4, audio: [{ bitRate: 128000 }] }), { bits: 1872000, estimated: true });
  assert.equal(sourceVideoRate({}), null);
  assert(trimPresetDefaults('small').videoBitrateMbps > 0);
});
test('normalizing concat resets timestamps and fills missing audio', () => {
  const silent = { ...file, path: 'D:\\b.mp4', audio: [], duration: 3 };
  const result = build('concat', { mode: 'normalize' }, [file, silent]);
  const filters = result.args[result.args.indexOf('-filter_complex') + 1];
  assert.match(filters, /anullsrc/); assert.match(filters, /concat=n=2:v=1:a=1/); assert.match(filters, /setpts=PTS-STARTPTS/); assert.equal(result.duration, 13);
});
test('copy concat rejects incompatible sources and safely escapes apostrophes', () => {
  assert.throws(() => build('concat', { mode: 'copy' }, [file, { ...file, video: { ...file.video, fps: 60 } }]), /快速拼接/);
  const result = build('concat', { mode: 'copy' }, [file, file]);
  assert(result.extraFiles[0].content.includes("it'\\''s"));
  assert.throws(() => build('concat', { mode: 'copy' }, [file, { ...file, path: 'a\nb.mp4' }]), /换行/);
});
test('audio extraction maps selected audio only, and mute copies video only', () => {
  const extract = build('audio', { format: 'copy' });
  assert.equal(extract.extension, 'mka'); assert(extract.args.includes('-vn')); assert(extract.args.includes('0:a:0'));
  const muted = build('audio', { action: 'mute' });
  assert(muted.args.includes('-an')); assert(muted.args.includes('copy')); assert(!muted.args.includes('0:a:0'));
  assert.throws(() => build('audio', {}, [{ ...file, audio: [] }]), /没有音频/);
});
test('GIF has an explicit duration bound and optimized palette', () => {
  assert.match(build('gif').args.join(' '), /palettegen/);
  assert.throws(() => build('gif', {}, [{ ...file, duration: 100 }]), /60 秒/);
});
test('filenames cannot escape directories or use Windows device names', () => {
  for (const name of ['../a', 'a/b', 'a\\b', 'CON', 'COM1.mp4', 'a\n', 'a:', 'a.', '', 'a*']) assert.throws(() => safeName(name));
  assert.equal(safeName('中文 clip (1)'), '中文 clip (1)');
});
test('command display quotes shell-sensitive arguments', () => {
  const command = displayCommand('ffmpeg', ['-i', "a$(echo test)`'; x.mp4", '-c', 'copy']);
  assert(command.includes('-c copy')); assert(command.includes("'a$"));
});
test('replacement and restoration keep only two versions with correct extensions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-replace-test-'));
  try {
    const sourcePath = path.join(dir, 'original.mov'), outputPath = path.join(dir, 'export.mp4');
    await fs.writeFile(sourcePath, 'ORIGINAL DATA'); await fs.writeFile(outputPath, 'NEW VIDEO');
    const stat = await fs.stat(sourcePath), out = await fs.stat(outputPath);
    const job = { status: 'completed', operation: 'transcode', extension: 'mp4', files: [{ path: sourcePath, size: stat.size, modified: stat.mtimeMs, video: {} }], outputPath, size: out.size, outputModified: out.mtimeMs };
    const plan = await replacementPlan(job); assert.equal(plan.targetPath, path.join(dir, 'original.mp4'));
    await assert.rejects(() => applyReplacement(job, 'wrong.mov'), /确认不匹配/);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL DATA');
    job.replacement = await applyReplacement(job, 'original.mov');
    assert.equal(await fs.readFile(job.replacement.backupPath, 'utf8'), 'ORIGINAL DATA');
    assert.equal(await fs.readFile(plan.targetPath, 'utf8'), 'NEW VIDEO');
    await assert.rejects(fs.access(outputPath));
    assert.equal((await fs.readdir(job.replacement.backupDirectory)).length, 1);
    job.replacement = await restoreOriginal(job, 'original.mov');
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL DATA');
    assert.equal(await fs.readFile(job.replacement.replacedBackup, 'utf8'), 'NEW VIDEO');
    await assert.rejects(fs.access(job.replacement.backupPath));
    assert.equal((await fs.readdir(job.replacement.backupDirectory)).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('replacement refuses changed originals and destination collisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-collision-test-'));
  try {
    const sourcePath = path.join(dir, 'a.mkv'), outputPath = path.join(dir, 'export.mp4');
    await fs.writeFile(sourcePath, 'ORIGINAL'); await fs.writeFile(outputPath, 'OUTPUT');
    const stat = await fs.stat(sourcePath);
    const job = { status: 'completed', extension: 'mp4', operation: 'transcode', size: 6, outputPath, files: [{ path: sourcePath, modified: stat.mtimeMs, size: stat.size, video: {} }] };
    await fs.writeFile(path.join(dir, 'a.mp4'), 'EXISTING');
    await assert.rejects(() => replacementPlan(job), /同名文件已存在/);
    await fs.appendFile(sourcePath, 'changed');
    await assert.rejects(() => replacementPlan(job), /原文件已发生变化/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
