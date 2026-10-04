export const VOLUME_PRESETS = [
  ['0.25', '四分之一'], ['0.5', '减半'], ['1', '原音量'], ['1.5', '放大'], ['2', '两倍'], ['4', '四倍'],
];

export function volumeSettings(options = {}) {
  const value = options.gain === undefined ? '1' : options.gain;
  if (!['string', 'number'].includes(typeof value) || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value).trim())) throw new Error('请输入有效的非负音量倍率，例如 0.5、2 或 2.75');
  const gain = Number(value);
  if (!Number.isFinite(gain) || gain < 0) throw new Error('音量倍率必须是可计算的非负数，不能为无穷大');
  if (gain === 0 && /[1-9]/.test(String(value).split(/e/i)[0])) throw new Error('倍率过小，无法准确表示。请填 0 静音，或输入更大的数值');
  if (options.protectPeaks !== undefined && typeof options.protectPeaks !== 'boolean') throw new Error('峰值保护设置无效');
  const protectPeaks = options.protectPeaks !== false;
  const reasons = [];
  if (gain === 0) reasons.push('0 倍会使所选音轨完全静音，但仍保留音轨');
  else if (gain < 0.1) reasons.push('低于 0.1 倍，输出可能很难听清');
  if (gain > 4) reasons.push('高于 4 倍，可能明显放大底噪或压缩声音动态');
  if (gain > 1 && !protectPeaks) reasons.push('已关闭峰值保护，放大后可能产生削波失真');
  return { gain, protectPeaks, limiter: gain > 1 && protectPeaks, db: gain > 0 ? 20 * Math.log10(gain) : null, reasons, requiresConfirmation: reasons.length > 0 };
}

export function volumeAudioFormat(file, requested = 'auto') {
  if (!['auto', 'mp3', 'm4a', 'wav', 'flac'].includes(requested)) throw new Error('请选择有效的音频输出格式');
  if (requested !== 'auto') return requested;
  const ext = (file?.name || '').split('.').pop().toLowerCase();
  return !file?.video && ['mp3', 'm4a', 'wav', 'flac'].includes(ext) ? ext : 'm4a';
}

export function volumeVideoFormat(file, requested = 'auto') {
  if (!['auto', 'mp4', 'mkv'].includes(requested)) throw new Error('请选择 MP4 或 MKV 视频输出');
  if (requested !== 'auto') return requested;
  return /\.(mp4|m4v)$/i.test(file?.name || '') ? 'mp4' : 'mkv';
}
