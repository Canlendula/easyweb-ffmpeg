import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { FFmpeg, run } from '../server/ffmpeg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test', 'results', `volume-${Date.now()}`);
await fs.mkdir(results, { recursive: true });
const engine = new FFmpeg(); await engine.initialize(); assert(engine.status.ready, engine.status.error);
const ff = args => run(engine.path, ['-v', 'error', '-nostdin', '-n', ...args]);
const original = path.join(results, '音量测试 tone.wav'), video = path.join(results, '双音轨 video.mp4'), silent = path.join(results, 'silent.mp4');
await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-af', 'volume=0.25', '-c:a', 'pcm_f32le', original]);
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-i', original, '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=zho', video]);
await ff(['-i', video, '-map', '0:v', '-c', 'copy', '-an', silent]);
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const originalHash = await digest(original), videoHash = await digest(video);
async function samples(file, track = 0) {
  const { stdout } = await ff(['-i', file, '-map', `0:a:${track}`, '-c:a', 'pcm_f64le', '-f', 'f64le', 'pipe:1']);
  let power = 0, peak = 0;
  for (let i = 0; i < stdout.length; i += 8) { const v = stdout.readDoubleLE(i); assert(Number.isFinite(v)); power += v * v; peak = Math.max(peak, Math.abs(v)); }
  return { count: stdout.length / 8, rms: Math.sqrt(power / (stdout.length / 8)), peak };
}
async function packets(file, stream) {
  const { stdout } = await run(engine.probePath, ['-v', 'error', '-select_streams', stream, '-show_packets', '-show_entries', 'packet=data_hash,pts_time,duration_time', '-show_data_hash', 'sha256', '-of', 'json', file]);
  return JSON.parse(stdout.toString()).packets;
}
const baseSamples = await samples(original);
const port = Number(process.env.VOLUME_TEST_PORT || 3223), base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/app.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), FRAME_DATA_DIR: path.join(results, 'state'), FRAME_OUTPUT_DIR: path.join(results, 'outputs'), FFMPEG_PATH: engine.path, FFPROBE_PATH: engine.probePath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let token = '', serviceLog = '', passed = 0;
service.stdout.on('data', d => { serviceLog += d; }); service.stderr.on('data', d => { serviceLog += d; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = label => { passed++; console.log(`PASS ${passed} ${label}`); };
async function api(route, data, expected = 200) {
  const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-Token': token }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
}
const spec = (file, options) => ({ operation: 'volume', fileIds: [file.id], options });
async function job(file, options) {
  const created = await api('/api/jobs', spec(file, options), 201);
  for (let i = 0; i < 180; i++) {
    const result = (await api('/api/jobs')).find(j => j.id === created.id);
    if (result.status === 'failed') throw new Error(result.error);
    if (result.status === 'completed') return result;
    await wait(100);
  }
  throw new Error('Volume job timed out');
}
try {
  for (let i = 0; i < 120; i++) { try { const boot = await api('/api/bootstrap'); token = boot.token; if (boot.system.ready && !boot.system.checking) break; } catch { if (service.exitCode !== null) throw new Error(serviceLog); } await wait(250); }
  assert((await api('/api/status')).ready);
  const loaded = await api('/api/files', { paths: [original, video, silent] }); assert.equal(loaded.errors.length, 0);
  const [audioFile, videoFile, silentFile] = loaded.files;
  for (const gain of [0.5, 1, 2, 2.75]) {
    const result = await job(audioFile, { gain }); const out = await samples(result.outputPath);
    assert.equal(result.extension, 'wav'); assert.equal(out.count, baseSamples.count, 'Filtering must retain sample count, including limiter delay compensation');
    assert(Math.abs(out.rms / baseSamples.rms - gain) < .00002, `Actual RMS gain ${out.rms / baseSamples.rms}, expected ${gain}`);
  }
  report('0.5x, 1x, 2x and 2.75x have the expected measured RMS gain and unchanged sample count');
  for (const gain of [0, .01, 7.25, 100]) {
    const preview = await api('/api/preview-command', spec(audioFile, { gain })); assert(preview.volume.requiresConfirmation);
    await api('/api/jobs', spec(audioFile, { gain }), 400);
  }
  await api('/api/jobs', spec(audioFile, { gain: 2, protectPeaks: false, riskAcknowledged: 'true' }), 400);
  report('preview explains risky gains; job submission requires a real explicit acknowledgment');
  const precise = await job(audioFile, { gain: 7.25, riskAcknowledged: true });
  assert(Math.abs((await samples(precise.outputPath)).rms / baseSamples.rms - 7.25) < .00002);
  const quiet = await job(audioFile, { gain: .01, riskAcknowledged: true });
  assert(Math.abs((await samples(quiet.outputPath)).rms / baseSamples.rms - .01) < .00001);
  const mute = await job(audioFile, { gain: 0, riskAcknowledged: true });
  const muted = await samples(mute.outputPath); assert.equal(muted.peak, 0); assert.equal(muted.count, baseSamples.count);
  const tiny = await job(audioFile, { gain: '1e-7', riskAcknowledged: true }); assert.equal(tiny.status, 'completed');
  report('confirmed values beyond the slider range, very small decimal gains and explicit silence are supported');
  const limited = await job(audioFile, { gain: 100, riskAcknowledged: true });
  const limitedSamples = await samples(limited.outputPath); assert(limitedSamples.peak <= .95001); assert.equal(limitedSamples.count, baseSamples.count);
  const unlimited = await job(audioFile, { gain: 100, protectPeaks: false, riskAcknowledged: true });
  const clipped = await samples(unlimited.outputPath); assert(clipped.peak > .999); assert(clipped.rms > limitedSamples.rms);
  report('peak protection caps amplified PCM samples; users can deliberately disable it without hidden gain clamping');
  for (const format of ['mp3', 'm4a', 'flac']) {
    const result = await job(audioFile, { gain: .5, format }); const metadata = await engine.probe(result.outputPath);
    assert.equal(result.extension, format); assert.equal(metadata.audio.length, 1); assert.equal(metadata.video, null);
    assert(Math.abs((await samples(result.outputPath)).rms / baseSamples.rms - .5) < .04);
    const range = await fetch(`${base}/api/jobs/${result.id}/media`, { headers: { Range: 'bytes=0-99' } }); assert.equal(range.status, 206); await range.arrayBuffer();
  }
  report('MP3, M4A and FLAC outputs decode correctly and can be previewed through the result endpoint');
  const adjusted = await job(videoFile, { gain: .5, track: 1 }); assert(adjusted.replaceable); assert.equal(adjusted.extension, 'mp4');
  assert.deepEqual(await packets(adjusted.outputPath, 'v:0'), await packets(video, 'v:0'));
  assert.deepEqual(await packets(adjusted.outputPath, 'a:0'), await packets(video, 'a:0'));
  const after = await engine.probe(adjusted.outputPath); assert.equal(after.audio.length, 2); assert.equal(after.audio[1].language, 'zho');
  assert(Math.abs((await samples(adjusted.outputPath, 1)).rms / (await samples(video, 1)).rms - .5) < .02);
  assert(Math.abs(after.duration - videoFile.duration) < .05);
  report('selected video audio track is adjusted while video packets and the other audio track remain identical');
  const extracted = await job(videoFile, { gain: 2, track: 1, output: 'audio', format: 'wav' });
  assert(!extracted.replaceable); assert.equal((await engine.probe(extracted.outputPath)).video, null);
  assert(Math.abs((await samples(extracted.outputPath)).rms / (await samples(video, 1)).rms - 2) < .001);
  report('video audio can also be exported on its own with the selected gain');
  for (const options of [{ gain: -1 }, { gain: '' }, { gain: '2;cmd' }, { gain: 'Infinity' }, { gain: '1e309' }, { gain: 2, track: 99 }]) await api('/api/jobs', spec(audioFile, options), 400);
  await api('/api/jobs', spec(silentFile, { gain: 2 }), 400);
  assert.equal(await digest(original), originalHash); assert.equal(await digest(video), videoHash);
  report('invalid parameters and silent videos are rejected; all original files remain byte-identical');
  await fs.writeFile(path.join(results, 'verification.json'), JSON.stringify({ passed, results, ffmpeg: engine.status.version, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`${passed} checks passed. Evidence: ${results}`);
} catch (err) { console.error(err); console.error(serviceLog); process.exitCode = 1; }
finally { service.kill(); }
