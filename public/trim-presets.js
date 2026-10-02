// Shared by the browser and the command builder so preset defaults stay consistent.
export function originalContainer(file) {
  const extension = (file?.name || file?.path || '').split('.').pop().toLowerCase();
  return ['mp4', 'mov', 'mkv', 'webm'].includes(extension) ? extension : extension === 'm4v' ? 'mp4' : 'mkv';
}

export function sourceVideoRate(file) {
  if (Number(file?.video?.bitRate) > 0) return { bits: Number(file.video.bitRate), estimated: false };
  const total = Number(file?.bitRate) || (file?.duration > 0 ? file.size * 8 / file.duration : 0);
  const audio = (file?.audio || []).reduce((sum, stream) => sum + (Number(stream.bitRate) || 128000), 0);
  return total > audio ? { bits: total - audio, estimated: true } : null;
}

export function trimPresetDefaults(preset = 'original', file) {
  const rate = sourceVideoRate(file)?.bits;
  const defaultRate = file?.video ? file.video.width * file.video.height * (file.video.fps || 30) * 0.08 : 6000000;
  const videoBitrateMbps = Math.round(Math.max(0.05, Math.min(300, (rate || defaultRate) * (preset === 'small' ? 0.65 : 1.2) / 1e6)) * 1000) / 1000;
  return {
    trimPreset: preset,
    mode: preset === 'original' ? 'copy' : 'accurate',
    codec: 'h264', container: preset === 'original' ? 'source' : 'mp4',
    encoder: 'auto', quality: preset === 'small' ? 'small' : 'high',
    rateControl: preset === 'small' ? 'bitrate' : 'quality',
    videoBitrateMbps, audioBitrateKbps: preset === 'small' ? 128 : 192,
    qualityValue: preset === 'small' ? 28 : 19,
  };
}
