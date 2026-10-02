import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { COVER_EXTENSIONS, COVER_MAX_BYTES, isCoverStream } from './cover.mjs';

const helperProcesses = new Set();
export function terminateHelpers() { for (const child of helperProcesses) child.kill(); }

export function run(executable, args, { timeout = 30000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    helperProcesses.add(child);
    const stdout = [], stderr = [];
    let total = 0, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => { total += chunk.length; if (total <= maxBuffer) chunks.push(chunk); else child.kill(); });
    }
    child.on('error', err => { helperProcesses.delete(child); clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      helperProcesses.delete(child);
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0 || expired || total > maxBuffer) reject(new Error(expired ? 'FFmpeg 操作超时' : (err.trim() || `进程退出：${code}`)));
      else resolve({ stdout: out, stderr: err });
    });
  });
}

async function locate(name, custom) {
  const exe = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  const candidates = custom ? [custom] : [process.env[`${name.toUpperCase()}_PATH`], ...process.env.PATH.split(path.delimiter).map(p => path.join(p.replaceAll('"', ''), exe))];
  if (!custom && process.platform === 'win32') {
    const packages = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const entry of await fs.readdir(packages).catch(() => [])) {
      if (!/ffmpeg/i.test(entry)) continue;
      for (const child of await fs.readdir(path.join(packages, entry)).catch(() => [])) {
        candidates.push(path.join(packages, entry, child, 'bin', exe));
      }
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const real = await fs.realpath(candidate);
      const { stdout } = await run(real, ['-hide_banner', '-version'], { timeout: 6000 });
      return { path: real, version: stdout.toString().split('\n')[0].trim() };
    } catch { /* Try the next installation. */ }
  }
  throw new Error(`找不到可运行的 ${name}。请在设置中填写 ${exe} 的完整路径，或将其加入 PATH。`);
}

export const ENCODERS = [
  { id: 'libx264', codec: 'h264', label: 'CPU · H.264', hardware: false },
  { id: 'libx265', codec: 'hevc', label: 'CPU · H.265', hardware: false },
  { id: 'libsvtav1', codec: 'av1', label: 'CPU · AV1 (SVT)', hardware: false },
  { id: 'libaom-av1', codec: 'av1', label: 'CPU · AV1', hardware: false },
  ...['nvenc', 'qsv', 'amf'].flatMap(vendor => ['h264', 'hevc', 'av1'].map(codec => ({
    id: `${codec}_${vendor}`, codec, hardware: true,
    label: `${{ nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' }[vendor]} · ${{ h264: 'H.264', hevc: 'H.265', av1: 'AV1' }[codec]}`,
  }))),
  ...['h264', 'hevc'].map(codec => ({ id: `${codec}_videotoolbox`, codec, label: `Apple · ${codec === 'h264' ? 'H.264' : 'H.265'}`, hardware: true })),
];

export class FFmpeg {
  constructor() { this.status = { ready: false, checking: true, encoders: [], error: '' }; }
  async initialize(settings = {}) {
    this.status = { ready: false, checking: true, encoders: [], error: '' };
    try {
      const [ffmpeg, ffprobe] = await Promise.all([locate('ffmpeg', settings.ffmpegPath), locate('ffprobe', settings.ffprobePath)]);
      this.path = ffmpeg.path; this.probePath = ffprobe.path;
      const { stdout } = await run(this.path, ['-hide_banner', '-encoders']);
      const list = stdout.toString();
      this.status = { ready: true, checking: true, path: this.path, probePath: this.probePath, version: ffmpeg.version, cpu: os.cpus()[0]?.model || 'CPU', encoders: [], error: '' };
      for (const encoder of ENCODERS) {
        if (!new RegExp(`\\b${encoder.id}\\b`).test(list)) continue;
        let available = true, reason = '';
        if (encoder.hardware) {
          try {
            await run(this.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=640x360:rate=30', '-frames:v', '2', '-pix_fmt', 'yuv420p', '-c:v', encoder.id, '-f', 'null', '-'], { timeout: 12000 });
          } catch (err) { available = false; reason = err.message.slice(0, 800); }
        }
        this.status.encoders.push({ ...encoder, available, reason });
      }
    } catch (err) { this.status.error = err.message; this.status.ready = false; }
    this.status.checking = false;
    return this.status;
  }
  async probe(file) {
    if (!this.status.ready) throw new Error(this.status.error || 'FFmpeg 正在初始化，请稍后重试');
    const { stdout } = await run(this.probePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file]);
    const data = JSON.parse(stdout.toString());
    const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = data.streams.filter(s => s.codec_type === 'audio');
    const ratio = (value = '0/1') => { const [a, b = 1] = value.split('/').map(Number); return b ? a / b : 0; };
    const duration = Number(data.format.duration || video?.duration || audio[0]?.duration || 0);
    if (!video && !audio.length) throw new Error('该文件没有可处理的视频或音频轨道');
    return {
      duration, size: Number(data.format.size), format: data.format.format_name, bitRate: Number(data.format.bit_rate) || 0,
      video: video ? { codec: video.codec_name, bitRate: Number(video.bit_rate) || 0, width: video.width, height: video.height, fps: ratio(video.avg_frame_rate || video.r_frame_rate), pixelFormat: video.pix_fmt, timeBase: video.time_base, profile: video.profile, rotation: video.side_data_list?.find(s => s.rotation)?.rotation || 0, colorTransfer: video.color_transfer, index: video.index } : null,
      audio: audio.map(s => ({ index: s.index, codec: s.codec_name, bitRate: Number(s.bit_rate) || 0, sampleRate: Number(s.sample_rate), channels: s.channels, layout: s.channel_layout, language: s.tags?.language || '', title: s.tags?.title || '' })),
      streams: data.streams.map(s => ({ type: s.codec_type, codec: s.codec_name })),
      streamDetails: data.streams.map(s => ({ index: s.index, type: s.codec_type, codec: s.codec_name, disposition: s.disposition || {}, tags: s.tags || {} })),
      cover: data.streams.filter(s => isCoverStream(s, path.extname(file).toLowerCase() === '.mkv')).map(s => ({ index: s.index, codec: s.codec_name, width: s.width, height: s.height }))[0] || null,
    };
  }
  async probeCover(file) {
    if (!this.status.ready) throw new Error('FFmpeg 尚未就绪，请稍后重试');
    const stat = await fs.stat(file);
    if (!stat.isFile() || !COVER_EXTENSIONS.has(path.extname(file).toLowerCase()) || stat.size > COVER_MAX_BYTES) throw new Error('请选择不超过 32 MB 的 JPG 或 PNG 图片');
    const { stdout } = await run(this.probePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-count_frames', '-show_streams', '-of', 'json', file]);
    const { streams } = JSON.parse(stdout.toString());
    const stream = streams?.[0];
    if (streams?.length !== 1 || !['png', 'mjpeg'].includes(stream?.codec_name) || Number(stream.nb_read_frames) !== 1 || !(stream.width > 0 && stream.height > 0) || stream.width * stream.height > 64 * 1024 * 1024) throw new Error('封面需要单帧 JPG / PNG 静态图片，最多 6400 万像素');
    return { codec: stream.codec_name, mime: stream.codec_name === 'png' ? 'image/png' : 'image/jpeg', width: stream.width, height: stream.height, size: stat.size, modified: stat.mtimeMs };
  }
}
