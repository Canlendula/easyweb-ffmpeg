import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperation } from '../server/operations.mjs';
import { volumeSettings } from '../public/volume-options.js';

const audio = { name: 'music.wav', path: 'D:/music.wav', duration: 3, video: null, audio: [{ codec: 'pcm_s16le', channels: 2 }] };
const video = { ...audio, name: 'movie.mp4', path: 'D:/movie.mp4', video: { codec: 'av1', colorTransfer: 'smpte2084' }, audio: [{ codec: 'aac', channels: 2 }, { codec: 'aac', channels: 6 }] };
const build = (options, file = audio) => buildOperation({ operation: 'volume', options }, [file], []);

test('multipliers accept decimals and scientific notation without silent clamping or rounding to zero', () => {
  for (const gain of [0, .5, 2, 7.25, 100, '1e-7', '1.25e3']) {
    assert.equal(volumeSettings({ gain }).gain, Number(gain));
    assert(build({ gain }).args.includes(`volume=${Number(gain)}:precision=double${Number(gain) > 1 ? ',alimiter=limit=0.95:level=false:latency=true' : ''}`));
  }
  for (const gain of ['', ' ', -1, Infinity, NaN, null, true, [], '2;calc', '2,volume=0', '1e309', '1e-999']) assert.throws(() => build({ gain }));
});

test('extreme attenuation, amplification, silence and disabled protection require acknowledgment', () => {
  for (const gain of [0, .01, .0999, 4.01, 200]) assert(volumeSettings({ gain }).requiresConfirmation);
  for (const gain of [.1, .5, 1, 2, 4]) assert(!volumeSettings({ gain }).requiresConfirmation);
  assert(volumeSettings({ gain: 2, protectPeaks: false }).requiresConfirmation);
  assert(!volumeSettings({ gain: .5, protectPeaks: false }).requiresConfirmation);
  assert.throws(() => volumeSettings({ protectPeaks: 'false' }));
});

test('limiting is optional, gain increases are not renormalized, and latency is compensated', () => {
  assert(build({ gain: 2 }).args.some(arg => arg.includes('level=false:latency=true')));
  for (const gain of [0, .5, 1]) assert(build({ gain }).args.every(arg => !arg.includes('alimiter')));
  assert(build({ gain: 10, protectPeaks: false }).args.includes('volume=10:precision=double'));
  assert.equal(volumeSettings({ gain: 0 }).db, null);
  assert(Math.abs(volumeSettings({ gain: 2 }).db - 6.020599913) < 1e-8);
});

test('audio-only default preserves familiar file formats and rejects unsupported output formats', () => {
  for (const format of ['mp3', 'm4a', 'wav', 'flac']) assert.equal(build({ gain: .5 }, { ...audio, name: `music.${format}` }).extension, format);
  assert.equal(build({}, { ...audio, name: 'music.ogg' }).extension, 'm4a');
  assert.equal(build({ format: 'flac' }).extension, 'flac');
  assert.throws(() => build({ format: 'copy' }));
  assert.throws(() => build({ gain: 1 }, { ...audio, audio: [] }), /没有音频/);
});

test('video gain filters only the selected audio track and copies video and other audio tracks', () => {
  const result = build({ gain: 2, track: 1 }, video);
  assert(result.args.includes('0:V')); assert(result.args.includes('0:a'));
  assert(result.args.includes('-filter:a:1')); assert(result.args.includes('-c:a:1')); assert(result.args.includes('copy'));
  assert(!result.args.includes('-c:v')); assert(!result.args.includes('-pix_fmt'));
  assert(!result.warnings.some(w => w.includes('8-bit'))); assert.equal(result.extension, 'mp4');
  assert.equal(build({}, { ...video, name: 'movie.webm' }).extension, 'mkv');
  assert.throws(() => build({ track: 2 }, video)); assert.throws(() => build({ track: '' }, video));
  assert.throws(() => build({ container: 'webm' }, video));
});

test('audio export from video maps the chosen track only, and MP3 explicitly handles multichannel inputs', () => {
  const result = build({ output: 'audio', format: 'mp3', track: 1, gain: .5 }, video);
  assert(result.args.includes('0:a:1')); assert(result.args.includes('-vn')); assert(!result.args.includes('0:V'));
  assert.equal(result.args[result.args.indexOf('-ac') + 1], '2');
  assert.equal(result.volume.includeVideo, false);
});
