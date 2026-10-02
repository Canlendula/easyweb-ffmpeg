import { originalContainer, trimPresetDefaults } from '../public/trim-presets.js';
import { coverOperation } from './cover.mjs';

export class InputError extends Error { constructor(message) { super(message); this.status = 400; } }
const fail = message => { throw new InputError(message); };
function choose(value, options, label) { if (!options.includes(value)) fail(`${label}无效`); return value; }
function number(value, min, max, label) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) fail(`${label}应在 ${min}～${max} 之间`); return n; }
const nstr = n => Number(n.toFixed(6)).toString();
export function safeName(name) {
  if (typeof name !== 'string' || !name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.length > 160) fail('文件名不能包含路径、特殊字符或 Windows 保留名称');
  return name.trim();
}

export function encoding(options, encoders) {
  const codec = choose(options.codec || 'h264', ['h264', 'hevc', 'av1'], '编码格式');
  const requested = options.encoder || 'auto';
  const available = encoders.filter(e => e.available && e.codec === codec);
  const selected = requested === 'auto' ? available.find(e => e.hardware) || available.find(e => !e.hardware)
    : requested === 'cpu' ? available.find(e => !e.hardware) : available.find(e => e.id === requested);
  if (!selected) fail('所选编码器不可用，请在设置中查看检测结果，或切换 CPU');
  const quality = choose(options.quality || 'balanced', ['high', 'balanced', 'small'], '质量');
  const q = options.qualityValue === undefined ? { high: 19, balanced: 23, small: 28 }[quality] : number(options.qualityValue, 1, 51, '质量等级');
  const rateControl = choose(options.rateControl || 'quality', ['quality', 'bitrate'], '码率控制方式');
  const args = ['-c:v', selected.id];
  if (rateControl === 'bitrate') {
    const bitrate = number(options.videoBitrateMbps, 0.01, 300, '视频目标码率（Mbps）');
    if (selected.id.includes('nvenc')) args.push('-preset', 'p4', '-rc', 'vbr');
    else if (selected.id.includes('qsv')) args.push('-preset', 'medium');
    else if (selected.id.includes('amf')) args.push('-rc', 'vbr_peak');
    else if (selected.id === 'libaom-av1') args.push('-cpu-used', '6');
    else if (selected.id === 'libsvtav1') args.push('-preset', '8');
    else if (['libx264', 'libx265'].includes(selected.id)) args.push('-preset', 'medium');
    args.push('-b:v', `${nstr(bitrate)}M`, '-maxrate', `${nstr(bitrate * 1.5)}M`, '-bufsize', `${nstr(bitrate * 3)}M`);
  }
  else if (selected.id.includes('nvenc')) args.push('-preset', 'p4', '-rc', 'vbr', '-cq', String(q), '-b:v', '0');
  else if (selected.id.includes('qsv')) args.push('-global_quality', String(q), '-preset', 'medium');
  else if (selected.id.includes('amf')) args.push('-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q));
  else if (selected.id.includes('videotoolbox')) args.push('-b:v', `${nstr(Math.max(1, 10 * 2 ** ((19 - q) / 6)))}M`);
  else if (selected.id === 'libaom-av1') args.push('-crf', String(q + 8), '-b:v', '0', '-cpu-used', '6');
  else if (selected.id === 'libsvtav1') args.push('-crf', String(q + 8), '-preset', '8');
  else args.push('-crf', String(q), '-preset', 'medium');
  args.push('-pix_fmt', 'yuv420p');
  return { args, selected };
}

const input = file => ['-protocol_whitelist', 'file,pipe', '-i', file.path];
const videoMap = ['-map', '0:v:0', '-map', '0:a:0?'];
const aac = ['-c:a', 'aac', '-b:a', '192k'];

export function buildOperation(spec, files, encoders, { concatPath = 'concat.ffconcat', cover, attachmentPath = index => `attachment-${index}.bin` } = {}) {
  if (!files.length) fail('请先选择素材');
  if (spec.operation === 'cover') return coverOperation(files[0], cover, fail, attachmentPath);
  const operation = choose(spec.operation, ['trim', 'transcode', 'concat', 'audio', 'resize', 'gif', 'snapshot', 'remux'], '操作');
  const file = files[0];
  let o = spec.options || {};
  if (operation === 'trim' && (o.trimPreset !== undefined || o.mode === undefined)) {
    const preset = choose(o.trimPreset || 'original', ['original', 'small', 'high'], '导出目标');
    o = { ...trimPresetDefaults(preset, file), ...o, mode: preset === 'original' ? 'copy' : 'accurate' };
  }
  const warnings = [], extraFiles = [];
  let args = [], extension = 'mp4', duration = file.duration, encoder = '流复制', title = '', estimatedSize = null;
  const requireVideo = () => { if (!file.video) fail('此操作需要视频轨道'); };
  const requireAudio = () => { if (!file.audio.length) fail('该素材没有音频轨道'); };
  const encode = (overrides = {}) => {
    const result = encoding({ ...o, ...overrides }, encoders); encoder = result.selected.label; return result.args;
  };
  const range = () => {
    if (!(file.duration > 0)) fail('无法确定素材时长');
    const start = number(o.start ?? 0, 0, file.duration, '开始时间');
    const end = number(o.end ?? file.duration, 0, file.duration + 0.001, '结束时间');
    if (end - start < 0.04) fail('结束时间必须大于开始时间，片段至少 0.04 秒');
    duration = end - start;
    return [start, duration];
  };
  if (operation === 'trim') {
    requireVideo(); title = '视频裁剪';
    const [start, length] = range();
    const mode = choose(o.mode || 'accurate', ['accurate', 'copy'], '裁剪模式');
    if (mode === 'copy') {
      extension = choose(o.container === 'source' ? originalContainer(file) : o.container || 'mkv', ['mp4', 'mkv', 'mov', 'webm'], '封装格式');
      args = ['-ss', nstr(start), ...input(file), '-t', nstr(length), ...videoMap, '-c', 'copy', '-avoid_negative_ts', 'make_zero'];
      encoder = '保持原编码 · 无需重新编码';
      warnings.push('保持原编码按附近关键帧裁剪，起止时间可能略有偏差。需要精确时间，请选择“体积优先”或“画质优先”。');
    } else {
      extension = choose(o.container || 'mp4', ['mp4', 'mkv'], '封装格式');
      const audioBitrate = number(o.audioBitrateKbps ?? 192, 32, 512, '音频码率（kbps）');
      args = ['-ss', nstr(start), ...input(file), '-t', nstr(length), ...videoMap, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...encode(), '-c:a', 'aac', '-b:a', `${audioBitrate}k`];
      if (o.rateControl === 'bitrate') estimatedSize = Math.round((Number(o.videoBitrateMbps) * 1e6 + (file.audio.length ? audioBitrate * 1000 : 0)) * length / 8);
    }
  } else if (operation === 'transcode' || operation === 'resize') {
    requireVideo(); title = operation === 'resize' ? '调整画面' : '转码与压缩';
    extension = choose(o.container || 'mp4', ['mp4', 'mkv'], '封装格式');
    args = [...input(file), ...videoMap];
    const filters = [];
    if (operation === 'resize') {
      const rotate = choose(String(o.rotate || '0'), ['0', '90', '180', '270'], '旋转角度');
      if (rotate === '90') filters.push('transpose=clock');
      if (rotate === '270') filters.push('transpose=cclock');
      if (rotate === '180') filters.push('hflip', 'vflip');
      if (o.flip === true) filters.push('hflip');
    }
    if (o.height && o.height !== 'original') {
      const height = number(o.height, 144, 4320, '输出高度');
      if (!Number.isInteger(height) || height % 2) fail('输出高度必须为偶数');
      filters.push(`scale=-2:${height}`);
    } else filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (o.fps && o.fps !== 'original') filters.push(`fps=${number(o.fps, 1, 120, '帧率')}`);
    args.push('-vf', filters.join(','), ...encode(), ...aac);
  } else if (operation === 'concat') {
    title = '视频拼接';
    if (files.length < 2 || files.length > 20) fail('请选择 2～20 个视频进行拼接');
    if (files.some(f => !f.video || !(f.duration > 0))) fail('拼接素材需要视频轨道及有效时长');
    duration = files.reduce((sum, f) => sum + f.duration, 0);
    const mode = choose(o.mode || 'normalize', ['normalize', 'copy'], '拼接模式');
    if (mode === 'copy') {
      extension = 'mkv';
      const signature = f => JSON.stringify([f.video.codec, f.video.width, f.video.height, f.video.fps, f.video.pixelFormat, f.video.timeBase, f.video.profile, f.audio.map(a => [a.codec, a.sampleRate, a.channels, a.layout]), f.streams]);
      if (files.some(f => signature(f) !== signature(file))) fail('快速拼接要求编码、分辨率、帧率及音轨结构一致。请切换“兼容拼接”。');
      const quote = p => p.replaceAll('\\', '/').replaceAll("'", "'\\''");
      if (files.some(f => /[\r\n]/.test(f.path))) fail('快速拼接不支持文件名中的换行符');
      extraFiles.push({ path: concatPath, content: `ffconcat version 1.0\n${files.map(f => `file '${quote(f.path)}'`).join('\n')}\n` });
      args = ['-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe', '-i', concatPath, ...videoMap, '-c', 'copy'];
      warnings.push('快速拼接保留首条视频和音频轨道。编码参数相同的素材最可靠；若播放异常，请使用兼容拼接。');
    } else {
      const height = Number(o.height || 720);
      choose(String(height), ['480', '720', '1080', '2160'], '拼接高度');
      const rotated = Math.abs(file.video.rotation) % 180 === 90;
      const aspect = rotated ? file.video.height / file.video.width : file.video.width / file.video.height;
      const width = Math.max(2, Math.round(height * aspect / 2) * 2);
      const fps = number(o.fps || 30, 1, 60, '帧率');
      args = files.flatMap(input);
      const hasAudio = files.some(f => f.audio.length);
      const filters = files.flatMap((f, i) => {
        const v = `[${i}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
        const a = f.audio.length ? `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${nstr(f.duration)}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${nstr(f.duration)},asetpts=PTS-STARTPTS[a${i}]`;
        return hasAudio ? [v, a] : [v];
      });
      filters.push(files.map((_, i) => `[v${i}]${hasAudio ? `[a${i}]` : ''}`).join('') + `concat=n=${files.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);
      args.push('-filter_complex', filters.join(';'), '-map', '[v]');
      if (hasAudio) args.push('-map', '[a]');
      args.push(...encode({ codec: 'h264' }), ...aac);
      warnings.push('兼容拼接统一为 H.264，按第一段的画面比例添加黑边；缺失的音轨自动补静音。');
    }
  } else if (operation === 'audio') {
    const action = choose(o.action || 'extract', ['extract', 'mute', 'volume', 'replace'], '音频操作');
    args = input(file);
    const track = Number(o.track || 0);
    if (!Number.isInteger(track) || track < 0 || (file.audio.length && track >= file.audio.length)) fail('音轨无效');
    if (action === 'extract') {
      title = '提取音频'; requireAudio();
      const format = choose(o.format || 'mp3', ['mp3', 'm4a', 'wav', 'flac', 'copy'], '音频格式');
      const codecs = { mp3: ['libmp3lame', '-b:a', '192k'], m4a: ['aac', '-b:a', '192k'], wav: ['pcm_s16le'], flac: ['flac'], copy: ['copy'] };
      extension = format === 'copy' ? 'mka' : format;
      args.push('-map', `0:a:${track}`, '-vn', '-c:a', ...codecs[format]);
      encoder = format === 'copy' ? '音频流复制' : codecs[format][0];
    } else if (action === 'mute') {
      title = '移除音频'; requireVideo(); extension = 'mkv';
      args.push('-map', '0:v:0', '-an', '-c:v', 'copy');
    } else if (action === 'volume') {
      title = '调整音量'; requireAudio(); extension = file.video ? 'mkv' : 'm4a';
      args.push('-map', '0:v:0?', '-map', `0:a:${track}`, '-c:v', 'copy', '-af', `volume=${number(o.volume ?? 100, 0, 400, '音量') / 100}`, ...aac);
      encoder = '视频流复制 · AAC';
    } else {
      title = '替换音轨'; requireVideo(); extension = 'mkv';
      if (files.length !== 2 || !files[1].audio.length) fail('请再添加一个包含音频的素材作为新音轨');
      args.push(...input(files[1]), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-t', nstr(duration), ...aac);
      warnings.push('新音频从头开始；超出视频长度的部分会裁掉，不足的部分补静音。');
    }
  } else if (operation === 'gif') {
    title = '生成 GIF'; requireVideo(); extension = 'gif';
    const [start, length] = range();
    if (length > 60) fail('GIF 片段请控制在 60 秒以内');
    const width = number(o.width || 480, 120, 1280, 'GIF 宽度');
    const fps = number(o.fps || 12, 1, 30, 'GIF 帧率');
    args = ['-ss', nstr(start), ...input(file), '-t', nstr(length), '-filter_complex', `[0:v:0]fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=sierra2_4a[v]`, '-map', '[v]', '-an', '-loop', '0'];
    encoder = 'GIF · 调色板优化';
  } else if (operation === 'snapshot') {
    title = '导出画面'; requireVideo();
    extension = choose(o.format || 'png', ['png', 'jpg'], '图片格式');
    const time = number(o.time || 0, 0, Math.max(0, duration - 0.04), '截图位置');
    args = ['-ss', nstr(time), ...input(file), '-map', '0:v:0', '-frames:v', '1', '-update', '1'];
    if (extension === 'jpg') args.push('-q:v', '2');
    duration = 0; encoder = extension.toUpperCase();
  } else if (operation === 'remux') {
    title = '转换封装'; extension = choose(o.container || 'mkv', ['mkv', 'mp4', 'mov', 'webm'], '封装格式');
    args = [...input(file), '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy'];
    warnings.push('保留视频和音频轨道；字幕、附件和数据轨道不导出。若目标容器不支持原编码，请使用转码。');
  }
  if (['mp4', 'mov'].includes(extension)) args.push('-movflags', '+faststart');
  if (o.codec === 'hevc' && extension === 'mp4' && (['transcode', 'resize'].includes(operation) || (operation === 'trim' && o.mode !== 'copy'))) args.push('-tag:v', 'hvc1');
  if (file.video && ['smpte2084', 'arib-std-b67'].includes(file.video.colorTransfer) && encoder !== '流复制' && !(operation === 'trim' && o.mode === 'copy')) warnings.push('检测到 HDR 素材。当前输出为 8-bit，未进行 HDR 色调映射，颜色可能改变；保留 HDR 建议使用流复制。');
  if (file.audio.length > 1 && operation !== 'remux' && operation !== 'audio') warnings.push('此操作保留第一条音轨。其他音轨和字幕不导出。');
  return { args, extension, duration, encoder, title, warnings, extraFiles, estimatedSize };
}

export function displayCommand(executable, args) {
  const quote = value => process.platform === 'win32' ? `'${String(value).replaceAll("'", "''")}'` : `'${String(value).replaceAll("'", "'\\''")}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(executable)} ${args.map(a => /^[a-zA-Z0-9_:./=+?,@-]+$/.test(a) ? a : quote(a)).join(' ')}`;
}
