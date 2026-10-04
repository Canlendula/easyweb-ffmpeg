import { volumeSettings, volumeAudioFormat, volumeVideoFormat } from '../public/volume-options.js';

export function volumeOperation(file, options, fail) {
  if (!file.audio?.length) fail('该素材没有音频轨道，请选择音频文件或带声音的视频');
  let settings, extension;
  try { settings = volumeSettings(options); } catch (err) { fail(err.message); }
  const track = Number(options.track ?? 0);
  if (!['string', 'number'].includes(typeof (options.track ?? 0)) || String(options.track ?? 0).trim() === '' || !Number.isInteger(track) || track < 0 || track >= file.audio.length) fail('请选择有效的音轨');
  const output = options.output || 'video';
  if (!['video', 'audio'].includes(output)) fail('输出内容无效');
  const includeVideo = Boolean(file.video && output === 'video');
  try { extension = includeVideo ? volumeVideoFormat(file, options.container) : volumeAudioFormat(file, options.format); }
  catch (err) { fail(err.message); }
  const { gain, limiter, reasons } = settings;
  const filter = `volume=${gain}:precision=double${limiter ? ',alimiter=limit=0.95:level=false:latency=true' : ''}`;
  const args = ['-protocol_whitelist', 'file,pipe', '-i', file.path];
  const warnings = [...reasons];
  let encoder;
  if (includeVideo) {
    // Map only real video streams (uppercase V excludes cover images). All audio
    // streams keep their order, so the selected audio ordinal is stable.
    args.push('-map', '0:V', '-map', '0:a', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy',
      `-filter:a:${track}`, filter, `-c:a:${track}`, 'aac', `-b:a:${track}`, '192k');
    encoder = '视频流复制 · 所选音轨 AAC';
    warnings.push('保留视频和全部音轨，仅调整所选音轨。字幕、封面、附件和原数据轨道不导出。');
  } else {
    const codecs = { mp3: ['libmp3lame', '-b:a', '192k'], m4a: ['aac', '-b:a', '192k'], wav: ['pcm_s24le'], flac: ['flac', '-sample_fmt', 's32'] };
    args.push('-map', `0:a:${track}`, '-map_metadata', '0', '-vn', '-af', filter, '-c:a', ...codecs[extension]);
    if (extension === 'mp3' && file.audio[track].channels > 2) { args.push('-ac', '2'); warnings.push('MP3 最多支持双声道，所选多声道音频会混音为双声道。'); }
    encoder = { mp3: 'MP3 · 192 kbps', m4a: 'AAC · 192 kbps', wav: 'WAV · 24-bit PCM', flac: 'FLAC · 24-bit' }[extension];
    if (file.audio.length > 1) warnings.push('仅导出所选音轨。');
  }
  if (['mp4', 'm4a'].includes(extension)) args.push('-movflags', '+faststart');
  return { args, extension, duration: file.duration, encoder, title: '音量调整', warnings, extraFiles: [], estimatedSize: null,
    volume: { ...settings, track, includeVideo } };
}
