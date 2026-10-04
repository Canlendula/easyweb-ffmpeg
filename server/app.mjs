import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { FFmpeg, run, terminateHelpers } from './ffmpeg.mjs';
import { COVER_EXTENSIONS, COVER_MAX_BYTES } from './cover.mjs';
import { buildOperation, displayCommand, InputError, safeName } from './operations.mjs';
import { canReplace, replacementPlan, applyReplacement, restoreOriginal } from './replacement.mjs';
import { revealFile } from './reveal.mjs';
import { NativeRevealBridge } from './native-bridge.mjs';
import { buildStoragePlan, publicStoragePlan, cleanStorage, trackResultMove, markOverwrittenResults } from './storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.FRAME_DATA_DIR || path.join(ROOT, '.data'));
const PUBLIC = path.join(ROOT, 'public');
const OUTPUT_ROOT = path.resolve(process.env.FRAME_OUTPUT_DIR || path.join(ROOT, 'outputs'));
const PORT = Number(process.env.PORT || 3210);
const TOKEN = randomBytes(24).toString('hex');
const BASE = `http://127.0.0.1:${PORT}`;
const nativeBridge = await NativeRevealBridge.load(DATA, PORT);
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.ts', '.mts', '.m2ts', '.flv', '.wmv', '.mpg', '.mpeg', '.ogg', '.ogv', '.mp3', '.m4a', '.wav', '.flac', '.aac', '.opus', '.mka', '.aiff', '.wma']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };
await fs.mkdir(path.join(DATA, 'imports'), { recursive: true });
await fs.mkdir(path.join(DATA, 'work'), { recursive: true });
let settings = { outputDir: path.resolve(process.env.FRAME_OUTPUT_DIR || path.join(ROOT, 'outputs')), ffmpegPath: '', ffprobePath: '' };
try { settings = { ...settings, ...JSON.parse(await fs.readFile(path.join(DATA, 'settings.json'), 'utf8')) }; } catch { /* First launch. */ }
await fs.mkdir(settings.outputDir, { recursive: true }).catch(() => {});
const ffmpeg = new FFmpeg();
const library = new Map();
const covers = new Map();
const thumbnailCache = new Map();
const previewCache = new Map();
const replacementTokens = new Map();
const replacementLocks = new Set();
const storagePlans = new Map();
const importsInFlight = new Set();
let storageBusy = false;
let mediaLoads = 0;
let jobs = [];
try {
  jobs = JSON.parse(await fs.readFile(path.join(DATA, 'jobs.json'), 'utf8'));
  for (const job of jobs) if (['running', 'queued'].includes(job.status)) { job.status = 'interrupted'; job.error = '服务重启，任务已中断；请重新添加素材后运行。'; }
} catch { /* No previous tasks. */ }
let active = null;
let persistence = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(jobs.slice(-100), null, 2);
  persistence = persistence.catch(() => {}).then(async () => {
    await fs.writeFile(path.join(DATA, 'jobs.tmp'), snapshot);
    await fs.rename(path.join(DATA, 'jobs.tmp'), path.join(DATA, 'jobs.json'));
  });
  return persistence;
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new InputError('请求内容过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new InputError('请求 JSON 无效'); }
}
function localPath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) throw new InputError('请输入有效的本地绝对路径');
  const p = value.trim().replace(/^"(.*)"$/, '$1');
  if (!path.isAbsolute(p) || /^\\\\/.test(p) || /^\/\//.test(p)) throw new InputError('请使用本机磁盘的绝对路径，不支持网络地址');
  return path.normalize(p);
}
async function addMedia(value) {
  const filePath = await fs.realpath(localPath(value));
  if (!MEDIA_EXT.has(path.extname(filePath).toLowerCase())) throw new InputError('暂不支持此文件类型，请选择视频或音频文件');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new InputError('所选路径不是文件');
  const existing = [...library.values()].find(f => f.path === filePath && f.modified === stat.mtimeMs && f.size === stat.size);
  if (existing) return existing;
  const metadata = await ffmpeg.probe(filePath);
  const file = { id: randomUUID(), path: filePath, name: path.basename(filePath), modified: stat.mtimeMs, ...metadata };
  library.set(file.id, file);
  return file;
}
function getMedia(id) { const file = library.get(id); if (!file) throw new InputError('素材已失效，请重新添加'); return file; }
async function addCover(value) {
  const filePath = await fs.realpath(localPath(value));
  let metadata;
  try { metadata = await ffmpeg.probeCover(filePath); }
  catch (err) { throw new InputError(err.message); }
  const existing = [...covers.values()].find(f => f.path === filePath && f.modified === metadata.modified && f.size === metadata.size);
  if (existing) return existing;
  const file = { id: randomUUID(), path: filePath, name: path.basename(filePath), ...metadata };
  covers.set(file.id, file);
  return file;
}
async function prepare(spec, id = randomUUID()) {
  if (storageBusy) throw new InputError('正在清理空间，请完成后再操作');
  if (!ffmpeg.status.ready) throw new InputError(ffmpeg.status.error || 'FFmpeg 尚未就绪');
  if (!Array.isArray(spec.fileIds) || spec.fileIds.length > 20) throw new InputError('素材列表无效');
  const files = spec.fileIds.map(getMedia);
  const usesEncoder = ['transcode', 'resize'].includes(spec.operation)
    || (spec.operation === 'concat' && spec.options?.mode !== 'copy')
    || (spec.operation === 'trim' && (spec.options?.trimPreset ? spec.options.trimPreset !== 'original' : spec.options?.mode === 'accurate'));
  if (usesEncoder && ffmpeg.status.checking && (!spec.options?.encoder || spec.options.encoder === 'auto')) throw new InputError('正在检测可用显卡，完成后会自动选择处理设备。');
  if (files.some(f => replacementLocks.has(f.path.toLowerCase()))) throw new InputError('素材正在替换或恢复，请完成后重新添加素材');
  if (spec.operation !== 'concat' && !(spec.operation === 'audio' && spec.options?.action === 'replace') && files.length !== 1) throw new InputError('此操作请选择一个素材');
  const cover = spec.operation === 'cover' ? covers.get(spec.options?.coverId) : null;
  const operation = buildOperation(spec, files, ffmpeg.status.encoders, { concatPath: path.join(DATA, 'work', `${id}.ffconcat`), cover, attachmentPath: index => path.join(DATA, 'work', `${id}-attachment-${index}.bin`) });
  if (id !== 'preview' && operation.volume?.requiresConfirmation && spec.options?.riskAcknowledged !== true) throw new InputError('请确认已了解当前音量设置的影响后再处理');
  const outputDir = localPath(spec.outputDir || settings.outputDir);
  const defaultName = `${path.parse(files[0].name).name}_${spec.operation}`;
  let name = safeName(spec.outputName || defaultName);
  if (path.extname(name).toLowerCase() === `.${operation.extension}`) name = name.slice(0, -operation.extension.length - 1);
  name = safeName(name);
  let outputPath = path.join(outputDir, `${name}.${operation.extension}`);
  if (existsSync(outputPath) || jobs.some(j => ['queued', 'running'].includes(j.status) && j.outputPath === outputPath)) outputPath = path.join(outputDir, `${name}_${id.slice(0, 8)}.${operation.extension}`);
  const stagingPath = path.join(outputDir, `.frame-${id}.${operation.extension}`);
  const args = ['-hide_banner', '-nostdin', '-n', '-progress', 'pipe:1', '-nostats', ...operation.args];
  return { id, ...operation, operation: spec.operation, files, assets: cover ? [cover] : [], outputPath, stagingPath, args, command: displayCommand(ffmpeg.path, [...args, outputPath]) };
}

function publicJob(job) {
  const { stagingPath, args, extraFiles, preprocess, files, assets, ...view } = job;
  return { ...view, replaceable: Boolean(canReplace(job)) && !job.resultCleanedAt,
    restorable: Boolean(job.replacement?.backupPath && job.replacement.mode !== 'overwrite' && !job.replacement.restoredAt && !job.replacement.backupCleanedAt), originalPath: files?.[0]?.path,
    nativeReveal: nativeBridge.offer(job) };
}
function protectedStoragePaths() {
  return [...library.values(), ...covers.values()].map(f => f.path).concat([...previewCache.values()].map(p => p.path), [...importsInFlight],
    jobs.filter(j => ['queued', 'running'].includes(j.status)).flatMap(j => [j.outputPath, j.stagingPath, ...[...j.files, ...(j.assets || [])].map(f => f.path)]));
}
async function runNext() {
  if (active || stopping) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  active = { job, child: null };
  job.status = 'running'; job.startedAt = Date.now(); job.progress = 0;
  await persist();
  try {
    for (const f of [...job.files, ...(job.assets || [])]) {
      const stat = await fs.stat(f.path);
      if (stat.size !== f.size || stat.mtimeMs !== f.modified) throw new Error(`素材已被修改，请重新添加：${f.name}`);
    }
    await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
    for (const extra of job.extraFiles) await fs.writeFile(extra.path, extra.content);
    for (const step of job.preprocess || []) {
      if (job.status === 'cancelled') throw new Error('已取消');
      await run(ffmpeg.path, ['-v', 'error', '-nostdin', '-n', ...step.args]);
    }
    if (job.status === 'cancelled') throw new Error('已取消');
    const child = spawn(ffmpeg.path, [...job.args, job.stagingPath], { shell: false, windowsHide: true });
    active.child = child;
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_us' && job.duration > 0) { job.processedSeconds = Math.max(0, Number(value) / 1e6); job.progress = Math.min(99, Math.max(0, job.processedSeconds / job.duration * 100)); }
        if (key === 'speed') job.speed = value?.trim();
      }
    });
    child.stderr.on('data', chunk => { job.log = ((job.log || '') + chunk.toString()).slice(-24000); });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (job.status === 'cancelled') throw new Error('已取消');
    if (code !== 0) throw new Error((job.log || `FFmpeg 退出：${code}`).split('\n').filter(Boolean).slice(-10).join('\n'));
    const stat = await fs.stat(job.stagingPath);
    if (!stat.size) throw new Error('FFmpeg 没有生成有效的输出文件');
    // Hard link refuses to replace an existing file, including a file created while the job ran.
    await fs.link(job.stagingPath, job.outputPath);
    await fs.unlink(job.stagingPath);
    job.size = stat.size; job.outputModified = stat.mtimeMs; job.status = 'completed'; job.progress = 100;
  } catch (err) {
    if (job.status !== 'cancelled') { job.status = 'failed'; job.error = err.message; }
    await fs.unlink(job.stagingPath).catch(() => {});
  } finally {
    for (const extra of job.extraFiles) await fs.unlink(extra.path).catch(() => {});
    for (const step of job.preprocess || []) await fs.unlink(step.path).catch(() => {});
    job.finishedAt = Date.now();
    active = null;
    await persist().catch(console.error);
    void runNext();
  }
}

async function sendFile(req, res, filePath, { download = false, immutable = false } = {}) {
  const stat = await fs.stat(filePath);
  const headers = { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'private, max-age=3600' : 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
  const stream = createReadStream(filePath, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function browse(directory, kind) {
  const target = directory ? localPath(directory) : ROOT;
  const extensions = kind === 'cover' ? COVER_EXTENSIONS : MEDIA_EXT;
  const entries = await fs.readdir(target, { withFileTypes: true });
  const list = entries.filter(e => !e.name.startsWith('.') && (e.isDirectory() || extensions.has(path.extname(e.name).toLowerCase()))).map(e => ({ name: e.name, path: path.join(target, e.name), directory: e.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const shortcuts = [{ name: '项目', path: ROOT }, { name: '视频', path: path.join(os.homedir(), 'Videos') }, { name: '下载', path: path.join(os.homedir(), 'Downloads') }, { name: '桌面', path: path.join(os.homedir(), 'Desktop') }, { name: '输出', path: settings.outputDir }];
  if (process.platform === 'win32') for (const drive of ['C', 'D', 'E', 'F', 'G']) if (existsSync(`${drive}:\\`)) shortcuts.push({ name: `${drive}:`, path: `${drive}:\\` });
  return { path: target, parent: path.dirname(target), entries: list, shortcuts };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!allowedHosts.includes(req.headers.host) || (req.headers.origin && !allowedHosts.some(h => req.headers.origin === `http://${h}`)) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: '仅允许从本机工作台访问' }, 403); return; }
    const url = new URL(req.url, BASE), route = url.pathname;
    const nativeRequest = /^\/api\/native-reveal\/([a-f0-9]{64})\/(claim|result|status|cancel)$/.exec(route);
    if (nativeRequest && ['claim', 'result'].includes(nativeRequest[2])) {
      if (req.method !== 'POST' || !nativeBridge.authorized(req.headers['x-frame-bridge'])) { json(res, { error: '本机助手认证失败' }, 403); return; }
      const value = await body(req);
      if (nativeRequest[2] === 'claim') json(res, await nativeBridge.claim(nativeRequest[1], id => jobs.find(j => j.id === id)));
      else { nativeBridge.complete(nativeRequest[1], value); json(res, { ok: true }); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-frame-token'] !== TOKEN) { json(res, { error: '会话已失效，请刷新页面' }, 403); return; }
    if (nativeRequest) {
      if (req.headers['x-frame-token'] !== TOKEN) { json(res, { error: '会话已失效，请刷新页面' }, 403); return; }
      if (nativeRequest[2] === 'status' && req.method === 'GET') { json(res, nativeBridge.status(nativeRequest[1])); return; }
      if (nativeRequest[2] === 'cancel' && req.method === 'POST') { nativeBridge.cancel(nativeRequest[1]); json(res, { ok: true }); return; }
    }
    if (storageBusy && req.method === 'POST' && (['/api/jobs', '/api/files', '/api/covers', '/api/import', '/api/preview-media', '/api/settings', '/api/redetect'].includes(route) || /\/(?:replace|restore)(?:-prepare)?$/.test(route))) throw new InputError('正在清理空间，请完成后再操作');
    if (route === '/api/bootstrap' && req.method === 'GET') { json(res, { token: TOKEN, settings, system: ffmpeg.status, root: ROOT, platform: process.platform, nativeReveal: { enabled: nativeBridge.enabled } }); return; }
    if (route === '/api/status' && req.method === 'GET') { json(res, ffmpeg.status); return; }
    if (route === '/api/browse' && req.method === 'GET') { json(res, await browse(url.searchParams.get('path'), url.searchParams.get('kind'))); return; }
    if (route === '/api/storage/plan' && req.method === 'POST') {
      if (storageBusy) throw new InputError('正在清理空间，请稍后查看');
      const plan = await buildStoragePlan({ dataDir: DATA, outputRoot: OUTPUT_ROOT, jobs, protectedPaths: protectedStoragePaths() });
      for (const [token, old] of storagePlans) if (old.expires < Date.now()) storagePlans.delete(token);
      if (storagePlans.size >= 10) storagePlans.delete(storagePlans.keys().next().value);
      storagePlans.set(plan.token, plan); json(res, publicStoragePlan(plan)); return;
    }
    if (route === '/api/storage/clean' && req.method === 'POST') {
      if (storageBusy || active || mediaLoads || replacementLocks.size || jobs.some(j => j.status === 'queued')) throw new InputError('请等待素材加载、处理和替换任务完成后再清理空间');
      const value = await body(req);
      if (storageBusy || active || mediaLoads || replacementLocks.size || jobs.some(j => j.status === 'queued')) throw new InputError('请等待当前任务完成后再清理空间');
      if (value.confirmed !== true) throw new InputError('请先核对清理清单');
      const plan = storagePlans.get(value.token);
      storagePlans.delete(value.token);
      storageBusy = true;
      try {
        const result = await cleanStorage(plan, value.entryIds, jobs, { protectedPaths: protectedStoragePaths() });
        await persist(); json(res, result);
      } finally { storageBusy = false; }
      return;
    }
    if (route === '/api/files' && req.method === 'POST') {
      const { paths } = await body(req);
      if (!Array.isArray(paths) || !paths.length || paths.length > 20) throw new InputError('请选择 1～20 个素材');
      const files = [], errors = [];
      if (storageBusy) throw new InputError('正在清理空间，请完成后再添加素材');
      mediaLoads++;
      try { for (const p of paths) try { files.push(await addMedia(p)); } catch (err) { errors.push({ path: p, error: err.message }); } }
      finally { mediaLoads--; }
      json(res, { files, errors }); return;
    }
    if (route === '/api/covers' && req.method === 'POST') {
      const value = await body(req);
      if (storageBusy) throw new InputError('正在清理空间，请完成后再添加封面');
      mediaLoads++;
      try { json(res, { file: await addCover(value.path) }); }
      finally { mediaLoads--; }
      return;
    }
    const coverMatch = /^\/api\/covers\/([a-f0-9-]+)$/.exec(route);
    if (coverMatch && ['GET', 'HEAD'].includes(req.method)) {
      const cover = covers.get(coverMatch[1]);
      if (!cover) throw new InputError('封面已失效，请重新选择');
      const { stdout } = await run(ffmpeg.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', cover.path, '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : stdout); return;
    }
    if (route === '/api/import' && req.method === 'POST') {
      const name = safeName(url.searchParams.get('name'));
      const isCover = url.searchParams.get('kind') === 'cover';
      if (!(isCover ? COVER_EXTENSIONS : MEDIA_EXT).has(path.extname(name).toLowerCase())) throw new InputError(isCover ? '请选择 JPG 或 PNG 封面图片' : '请选择视频或音频文件');
      if (isCover && Number(req.headers['content-length']) > COVER_MAX_BYTES) throw new InputError('封面图片不能超过 32 MB');
      const destination = path.join(DATA, 'imports', `${randomUUID()}_${name}`);
      importsInFlight.add(destination);
      try {
        if (isCover) await pipeline(req, async function* (source) { let bytes = 0; for await (const chunk of source) { bytes += chunk.length; if (bytes > COVER_MAX_BYTES) throw new InputError('封面图片不能超过 32 MB'); yield chunk; } }, createWriteStream(destination, { flags: 'wx' }));
        else await pipeline(req, createWriteStream(destination, { flags: 'wx' }));
        const file = await (isCover ? addCover(destination) : addMedia(destination)); file.name = name; file.imported = true;
        json(res, { file });
      } catch (err) { await fs.unlink(destination).catch(() => {}); throw err; }
      finally { importsInFlight.delete(destination); }
      return;
    }
    const mediaMatch = /^\/api\/media\/([a-f0-9-]+)(?:\/(thumb|preview|cover))?$/.exec(route);
    if (mediaMatch && ['GET', 'HEAD'].includes(req.method)) {
      const file = getMedia(mediaMatch[1]);
      if (mediaMatch[2] === 'cover') {
        if (!file.cover) { res.writeHead(204); res.end(); return; }
        const { stdout } = await run(ffmpeg.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file.path, '-map', `0:${file.cover.index}`, '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : stdout); return;
      }
      if (mediaMatch[2] === 'thumb') {
        if (!file.video) { res.writeHead(204); res.end(); return; }
        const requested = Number(url.searchParams.get('time') || 0);
        if (!Number.isFinite(requested)) throw new InputError('缩略图时间无效');
        const time = Math.max(0, Math.min(requested, file.duration - 0.1));
        const key = `${file.id}-${time.toFixed(2)}`;
        if (!thumbnailCache.has(key)) {
          if (thumbnailCache.size > 150) thumbnailCache.delete(thumbnailCache.keys().next().value);
          thumbnailCache.set(key, run(ffmpeg.path, ['-v', 'error', '-ss', String(time), '-protocol_whitelist', 'file,pipe', '-i', file.path, '-map', `0:${file.video.index}`, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']).then(r => r.stdout).catch(err => { thumbnailCache.delete(key); throw err; }));
        }
        const buffer = await thumbnailCache.get(key);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); res.end(buffer); return;
      }
      if (mediaMatch[2] === 'preview') {
        const preview = previewCache.get(file.id);
        if (!preview?.ready) throw new InputError('兼容预览尚未生成');
        await sendFile(req, res, preview.path); return;
      }
      await sendFile(req, res, file.path); return;
    }
    if (route === '/api/preview-media' && req.method === 'POST') {
      const file = getMedia((await body(req)).id);
      if (!file.video) throw new InputError('请选择视频素材');
      if (!previewCache.has(file.id)) {
        const destination = path.join(DATA, 'work', `${file.id}-preview.mp4`);
        const state = { path: destination, ready: false, error: '', pending: true };
        previewCache.set(file.id, state);
        void run(ffmpeg.path, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', file.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', destination], { timeout: 30 * 60 * 1000 }).then(() => { state.ready = true; state.pending = false; }).catch(err => { state.error = err.message; state.pending = false; });
      }
      json(res, previewCache.get(file.id)); return;
    }
    if (route === '/api/preview-command' && req.method === 'POST') {
      const plan = await prepare(await body(req), 'preview');
      json(res, { command: plan.command, warnings: plan.warnings, outputPath: plan.outputPath, extension: plan.extension, encoder: plan.encoder, duration: plan.duration, extraFiles: plan.extraFiles, preCommands: (plan.preprocess || []).map(step => displayCommand(ffmpeg.path, ['-v', 'error', '-nostdin', '-n', ...step.args])), estimatedSize: plan.estimatedSize, volume: plan.volume }); return;
    }
    if (route === '/api/jobs' && req.method === 'GET') { json(res, jobs.slice(-100).reverse().map(publicJob)); return; }
    if (route === '/api/jobs' && req.method === 'POST') {
      if (jobs.filter(j => ['running', 'queued'].includes(j.status)).length >= 30) throw new InputError('队列最多容纳 30 个任务');
      const plan = await prepare(await body(req));
      const job = { ...plan, status: 'queued', progress: 0, createdAt: Date.now(), log: '', sourceNames: plan.files.map(f => f.name) };
      jobs.push(job); await persist(); void runNext(); json(res, publicJob(job), 201); return;
    }
    const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)\/(cancel|download|reveal|media|replace-plan|replace-prepare|replace|restore-prepare|restore)$/.exec(route);
    if (jobMatch) {
      const job = jobs.find(j => j.id === jobMatch[1]);
      if (!job) throw new InputError('任务不存在');
      const action = jobMatch[2];
      if (['replace-plan', 'replace-prepare', 'replace', 'restore-prepare', 'restore'].includes(action)) {
        if (jobs.some(j => ['running', 'queued'].includes(j.status) && j.files?.some(f => f.path === job.files?.[0]?.path))) throw new InputError('原素材还有任务在队列中，请全部完成后再替换或恢复');
        if (action === 'replace-plan' && ['GET', 'POST'].includes(req.method)) { json(res, await replacementPlan(job, req.method === 'POST' ? await body(req) : {})); return; }
        if (req.method !== 'POST') throw new InputError('请求方式无效');
        const value = await body(req);
        if (storageBusy) throw new InputError('正在清理空间，请完成后再操作');
        if (action.endsWith('-prepare')) {
          if (value.acknowledged !== true) throw new InputError('请先完成第一次确认');
          const plan = action === 'replace-prepare' ? await replacementPlan(job, { targetName: value.targetName, mode: value.mode }) : job.replacement;
          if (!plan || plan.restoredAt || plan.backupCleanedAt || (action === 'restore-prepare' && (plan.mode === 'overwrite' || !plan.backupPath))) throw new InputError('没有可恢复的原文件，可能使用了直接覆盖或已清理备份');
          const token = randomBytes(24).toString('hex');
          const options = action === 'replace-prepare' ? { targetName: plan.targetName, mode: plan.mode } : undefined;
          replacementTokens.set(token, { jobId: job.id, action: action.split('-')[0], expires: Date.now() + 120000, options, confirmName: plan.confirmName, targetPath: plan.targetPath });
          json(res, { token, plan }); return;
        }
        const ticket = replacementTokens.get(value.token);
        if (!ticket || ticket.jobId !== job.id || ticket.action !== action || ticket.expires < Date.now()) throw new InputError('确认已过期，请重新进行两次确认');
        replacementTokens.delete(value.token);
        if (action === 'replace' && ((value.mode !== undefined && value.mode !== ticket.options.mode) || (value.targetName !== undefined && value.targetName !== ticket.options.targetName))) throw new InputError('替换设置与确认内容不一致，请返回重新确认');
        if (action === 'replace' && ticket.options.mode === 'overwrite' && (value.confirmed !== true || value.overwriteAcknowledged !== true)) throw new InputError('请确认不保留原片备份，直接覆盖后无法通过本工具还原');
        const confirmedName = action === 'replace' && value.confirmed === true ? ticket.confirmName : value.confirmName;
        const lockKeys = [...new Set([job.files[0].path, ticket.targetPath].filter(Boolean).map(p => p.toLowerCase()))];
        if (lockKeys.some(key => replacementLocks.has(key))) throw new InputError('原文件或目标文件正在替换，请稍后再试');
        for (const key of lockKeys) replacementLocks.add(key);
        try {
          job.replacement = action === 'replace' ? await applyReplacement(job, confirmedName, ticket.options) : await restoreOriginal(job, confirmedName);
          const r = job.replacement;
          if (action === 'replace' && r.mode === 'overwrite') markOverwrittenResults(jobs, { sourcePath: r.sourcePath, size: job.files[0].size, modified: job.files[0].modified, exceptId: job.id });
          else if (action === 'replace') trackResultMove(jobs, { from: r.sourcePath, to: r.backupPath, size: job.files[0].size, modified: job.files[0].modified, exceptId: job.id });
          else {
            trackResultMove(jobs, { from: r.targetPath, to: r.replacedBackup, size: r.size, modified: r.modified, exceptId: job.id });
            trackResultMove(jobs, { from: r.backupPath, to: r.sourcePath, size: job.files[0].size, modified: job.files[0].modified, exceptId: job.id });
          }
          job.outputPath = action === 'replace' ? job.replacement.targetPath : job.replacement.replacedBackup;
          job.outputModified = r.modified;
          job.storageUpdatedAt = Date.now();
          await persist(); json(res, publicJob(job));
        }
        finally { for (const key of lockKeys) replacementLocks.delete(key); }
        return;
      }
      if (action === 'cancel' && req.method === 'POST') {
        if (['running', 'queued'].includes(job.status)) { job.status = 'cancelled'; job.finishedAt = Date.now(); if (active?.job.id === job.id) active.child?.kill(); await persist(); }
        json(res, publicJob(job)); return;
      }
      if (['download', 'media'].includes(action) && ['GET', 'HEAD'].includes(req.method)) {
        if (job.status !== 'completed') throw new InputError('任务尚未完成');
        if (job.resultCleanedAt) throw new InputError(job.resultRemovalReason || '此处理版本已清理，任务记录仍保留');
        await sendFile(req, res, job.outputPath, { download: action === 'download' }); return;
      }
      if (action === 'reveal' && req.method === 'POST') {
        if (job.status !== 'completed') throw new InputError('任务尚未完成');
        if (job.resultCleanedAt) throw new InputError(job.resultRemovalReason || '此处理版本已清理，任务记录仍保留');
        json(res, await revealFile(job.outputPath)); return;
      }
    }
    if (route === '/api/settings' && req.method === 'POST') {
      if (active || jobs.some(j => j.status === 'queued')) throw new InputError('请等待当前队列完成后修改设置');
      const value = await body(req);
      const next = { outputDir: localPath(value.outputDir || settings.outputDir), ffmpegPath: value.ffmpegPath ? localPath(value.ffmpegPath) : '', ffprobePath: value.ffprobePath ? localPath(value.ffprobePath) : '' };
      settings = next;
      await fs.writeFile(path.join(DATA, 'settings.json'), JSON.stringify(settings, null, 2));
      void ffmpeg.initialize(settings);
      json(res, { settings, system: ffmpeg.status }); return;
    }
    if (route === '/api/redetect' && req.method === 'POST') {
      if (!ffmpeg.status.checking && !active) void ffmpeg.initialize(settings);
      json(res, ffmpeg.status); return;
    }
    if (route.startsWith('/api/')) { json(res, { error: '接口不存在' }, 404); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { json(res, { error: '不支持此请求' }, 405); return; }
    const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/trim-presets.js': 'trim-presets.js', '/volume-options.js': 'volume-options.js', '/styles.css': 'styles.css', '/icons.js': 'icons.js', '/favicon.svg': 'favicon.svg' };
    if (!staticFiles[route]) { res.writeHead(404); res.end('Not found'); return; }
    await sendFile(req, res, path.join(PUBLIC, staticFiles[route]));
  } catch (err) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
    const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500);
    const message = err.code === 'ENOENT' ? '文件或目录不存在' : err.code === 'EACCES' || err.code === 'EPERM' ? '没有权限访问此文件或目录' : err.message;
    json(res, { error: message }, status);
  }
});
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  FRAME · 本地视频工作台\n  ${BASE}\n  工作目录：${ROOT}\n  按 Ctrl+C 停止服务\n`);
  void ffmpeg.initialize(settings).then(status => console.log(status.ready ? `  ${status.version}\n  可用硬件编码器：${status.encoders.filter(e => e.available && e.hardware).map(e => e.id).join(', ') || '无'}` : `  ${status.error}`));
  if (process.argv.includes('--open')) {
    const child = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', BASE], { windowsHide: true, stdio: 'ignore' }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [BASE], { stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
});
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用。可直接访问 ${BASE}，或设置 PORT 后重新启动。` : err); process.exit(1); });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  terminateHelpers();
  if (active) { active.job.status = 'interrupted'; active.job.error = '服务已停止，任务中断'; active.child?.kill(); }
  await persist().catch(() => {});
  server.close(); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
