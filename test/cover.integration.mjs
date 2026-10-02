import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FFmpeg, run } from '../server/ffmpeg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test', 'results', `cover-${Date.now()}`);
await fs.mkdir(results, { recursive: true });
const engine = new FFmpeg(); await engine.initialize(); assert(engine.status.ready, engine.status.error);
const ff = args => run(engine.path, ['-v', 'error', '-nostdin', '-n', ...args]);
const hash = data => createHash('sha256').update(data).digest('hex');
const image = path.join(results, "新封面 'green'.png"), nextImage = path.join(results, '新封面 orange.jpg');
await ff(['-f', 'lavfi', '-i', 'color=c=0x42715b:size=800x450', '-frames:v', '1', '-update', '1', image]);
await ff(['-f', 'lavfi', '-i', 'color=c=0xdd7b42:size=600x800', '-frames:v', '1', '-update', '1', nextImage]);
const subtitles = path.join(results, 'captions.srt'), metadata = path.join(results, 'chapters.txt'), attachment = path.join(results, 'notes.txt');
await fs.writeFile(subtitles, '1\n00:00:00,200 --> 00:00:01,800\nPreserved subtitles\n');
await fs.writeFile(metadata, ';FFMETADATA1\ntitle=Cover preservation test\ncomment=Original metadata\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Part one\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Part two\n');
await fs.writeFile(attachment, 'An unrelated attachment that must survive.');
const source = path.join(results, '原视频 multi.mp4');
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-i', subtitles, '-f', 'ffmetadata', '-i', metadata,
  '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a', '-map', '4:s', '-map_metadata', '5', '-map_chapters', '5', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=zho', '-disposition:a:0', '0', '-disposition:a:1', 'default', '-movflags', '+faststart', source]);
const mkv = path.join(results, '原视频 attachments.mkv');
await ff(['-i', source, '-map', '0:V', '-map', '0:a', '-map', '0:s', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', '-c:s', 'srt', '-attach', attachment, '-metadata:s:t:0', 'mimetype=text/plain', '-metadata:s:t:0', 'filename=notes.txt', '-attach', image, '-metadata:s:t:1', 'mimetype=image/png', '-metadata:s:t:1', 'filename=artwork.png', mkv]);
const m4v = path.join(results, '原视频.m4v'); await fs.copyFile(source, m4v);
const sourceHash = hash(await fs.readFile(source));
const wait = ms => new Promise(r => setTimeout(r, ms));
const port = Number(process.env.COVER_TEST_PORT || 3221), base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/app.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), FRAME_DATA_DIR: path.join(results, 'state'), FRAME_OUTPUT_DIR: path.join(results, 'outputs'), FFMPEG_PATH: engine.path, FFPROBE_PATH: engine.probePath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let token = '', serviceLog = '', passed = 0;
service.stdout.on('data', d => { serviceLog += d; }); service.stderr.on('data', d => { serviceLog += d; });
const report = name => { passed++; console.log(`PASS ${passed} ${name}`); };
async function api(route, data, expected = 200) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-Token': token }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
}
async function load(file) { const result = await api('/api/files', { paths: [file] }); assert.equal(result.errors.length, 0, JSON.stringify(result)); return result.files[0]; }
async function job(file, cover, name) {
  const created = await api('/api/jobs', { operation: 'cover', fileIds: [file.id], options: { coverId: cover.id }, outputName: name }, 201);
  for (let i = 0; i < 160; i++) {
    const result = (await api('/api/jobs')).find(j => j.id === created.id);
    if (result.status === 'failed') throw new Error(result.error);
    if (result.status === 'completed') return result;
    await wait(100);
  }
  throw new Error('Cover job timed out');
}
async function probe(file) {
  const result = await run(engine.probePath, ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file]);
  return JSON.parse(result.stdout.toString());
}
async function assertPreserved(beforePath, afterPath) {
  const [before, after] = await Promise.all([probe(beforePath), probe(afterPath)]);
  const tracks = data => data.streams.filter(s => ['video', 'audio', 'subtitle'].includes(s.codec_type) && !s.disposition?.attached_pic);
  assert.equal(tracks(before).length, tracks(after).length);
  tracks(before).forEach((stream, i) => {
    const result = tracks(after)[i];
    assert.equal(result.codec_name, stream.codec_name);
    assert.equal(result.extradata_hash, stream.extradata_hash);
    assert.deepEqual(result.disposition, stream.disposition);
    assert.equal(result.tags?.language, stream.tags?.language);
    const packets = (data, index) => data.packets.filter(p => p.stream_index === index).map(p => ({ hash: p.data_hash, pts: p.pts_time, duration: p.duration_time }));
    assert.deepEqual(packets(after, result.index), packets(before, stream.index), `Packet content and timing changed for stream ${stream.index}`);
  });
  const chapters = data => data.chapters.map(c => ({ start: c.start_time, end: c.end_time, tags: c.tags }));
  assert.deepEqual(chapters(after), chapters(before));
  assert.equal(after.format.tags.title, before.format.tags.title);
  assert.equal(after.format.tags.COMMENT || after.format.tags.comment, before.format.tags.COMMENT || before.format.tags.comment);
  // MKV rewrites its duration header from demuxed packets (AAC end padding can
  // round differently). Every packet's payload, PTS and duration is exact above.
  assert(Math.abs(Number(after.format.duration) - Number(before.format.duration)) < .025);
  for (const existing of before.streams.filter(s => s.tags?.filename && !/^cover\./.test(s.tags.filename))) {
    const kept = after.streams.find(s => s.tags?.filename === existing.tags.filename);
    assert(kept, `Missing attachment ${existing.tags.filename}`); assert.equal(kept.extradata_hash, existing.extradata_hash);
    const oldPackets = before.packets.filter(p => p.stream_index === existing.index).map(p => p.data_hash);
    const newPackets = after.packets.filter(p => p.stream_index === kept.index).map(p => p.data_hash);
    assert.deepEqual(newPackets, oldPackets);
  }
}
async function assertCover(file, coverPath) {
  const media = await engine.probe(file); assert(media.cover);
  const extracted = await ff(['-i', file, '-map', `0:${media.cover.index}`, '-c', 'copy', '-frames:v', '1', '-f', 'image2pipe', 'pipe:1']);
  assert.equal(hash(extracted.stdout), hash(await fs.readFile(coverPath)));
  const count = media.streamDetails.filter(s => s.disposition?.attached_pic && (!s.tags.filename || /^cover\./.test(s.tags.filename))).length;
  assert.equal(count, 1, 'Old covers must not accumulate');
}
try {
  for (let i = 0; i < 120; i++) { try { const boot = await api('/api/bootstrap'); token = boot.token; if (boot.system.ready && !boot.system.checking) break; } catch { if (service.exitCode !== null) throw new Error(serviceLog); } await wait(250); }
  assert((await api('/api/status')).ready);
  const listing = await api(`/api/browse?kind=cover&path=${encodeURIComponent(results)}`);
  assert(listing.entries.some(e => e.path === image)); assert(!listing.entries.some(e => e.path === source));
  const cover = (await api('/api/covers', { path: image })).file;
  const orange = (await api('/api/covers', { path: nextImage })).file;
  const invalid = path.join(results, 'invalid.png'); await fs.writeFile(invalid, 'not an image');
  await api('/api/covers', { path: invalid }, 400);
  const uploaded = await fetch(`${base}/api/import?kind=cover&name=test.png`, { method: 'POST', headers: { 'X-Frame-Token': token }, body: await fs.readFile(image) });
  assert.equal(uploaded.status, 200); assert((await uploaded.json()).file.imported);
  const preview = await fetch(`${base}/api/covers/${cover.id}`); assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png'); assert((await preview.arrayBuffer()).byteLength > 100);
  report('dedicated image browser, path loading, preview, upload and invalid-image rejection');
  let final;
  for (const [name, original] of [['mp4', source], ['m4v', m4v], ['mkv', mkv]]) {
    const file = await load(original);
    const first = await job(file, cover, `${name}-green`);
    await assertPreserved(original, first.outputPath); await assertCover(first.outputPath, image);
    assert.equal(first.extension, name); assert(first.replaceable);
    report(`${name}: add PNG cover while preserving packet hashes, timestamps, all tracks, chapters, tags and unrelated attachments`);
    const secondFile = await load(first.outputPath);
    const embeddedPreview = await fetch(`${base}/api/media/${secondFile.id}/cover`); assert.equal(embeddedPreview.status, 200); assert((await embeddedPreview.arrayBuffer()).byteLength > 100);
    const second = await job(secondFile, orange, `${name}-orange`);
    await assertPreserved(first.outputPath, second.outputPath); await assertCover(second.outputPath, nextImage);
    report(`${name}: replace existing PNG cover with JPG without accumulating covers or changing media`);
    if (name === 'mp4') final = second;
  }
  const unsupportedPath = path.join(results, 'unsupported.mov'); await fs.copyFile(source, unsupportedPath);
  const unsupported = await load(unsupportedPath);
  await api('/api/jobs', { operation: 'cover', fileIds: [unsupported.id], options: { coverId: cover.id } }, 400);
  await api('/api/jobs', { operation: 'cover', fileIds: [(await load(source)).id], options: {} }, 400);
  assert.equal(hash(await fs.readFile(source)), sourceHash); report('unsupported containers and missing cover rejected; original file unchanged');
  const orphan = path.join(results, 'outputs', 'old-untracked.mp4'); await fs.copyFile(source, orphan);
  const plan = await api('/api/storage/plan', {});
  const exportEntries = plan.entries.filter(e => e.category === 'export');
  assert(exportEntries.length > 0); assert(exportEntries.every(e => !e.defaultSelected));
  const selected = exportEntries.filter(e => [orphan, final.outputPath].includes(e.path)); assert.equal(selected.length, 2);
  assert(!plan.entries.some(e => e.path === source));
  await api('/api/storage/clean', { token: plan.token, entryIds: selected.map(e => e.id) }, 400);
  const cleaned = await api('/api/storage/clean', { token: plan.token, entryIds: selected.map(e => e.id), confirmed: true });
  assert.equal(cleaned.removed.length, 2); assert.equal(cleaned.skipped.length, 0);
  assert((await api('/api/jobs')).find(j => j.id === final.id).resultCleanedAt);
  await api(`/api/jobs/${final.id}/media`, undefined, 400);
  assert.equal(hash(await fs.readFile(source)), sourceHash);
  report('optional tracked and older output cleanup requires confirmation and retires result links without deleting sources');
  await fs.writeFile(path.join(results, 'verification.json'), JSON.stringify({ passed, results, ffmpeg: engine.status.version, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`${passed} checks passed. Evidence: ${results}`);
} catch (err) { console.error(err); console.error(serviceLog); process.exitCode = 1; }
finally { service.kill(); }
