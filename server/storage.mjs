import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { InputError } from './operations.mjs';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => Boolean(a && b && key(a) === key(b));
const snapshot = stat => ({ size: stat.size, modified: stat.mtimeMs, inode: stat.ino, device: stat.dev });
const matches = (stat, expected) => stat.size === expected.size && stat.mtimeMs === expected.modified && stat.ino === expected.inode && stat.dev === expected.device;
const exportExtensions = new Set(['.mp4', '.m4v', '.mkv', '.mov', '.webm', '.mp3', '.m4a', '.mka', '.wav', '.flac', '.gif', '.png', '.jpg', '.jpeg']);
function exportProtectedPaths(jobs) {
  return new Set(jobs.flatMap(job => [
    ...(job.files || []).map(f => f.path), ...(job.assets || []).map(f => f.path),
    job.replacement?.sourcePath, job.replacement?.targetPath,
    job.replacement?.backupPath, job.replacement?.replacedBackup,
    ...(['queued', 'running'].includes(job.status) ? [job.outputPath, job.stagingPath] : []),
  ]).filter(Boolean).map(key));
}
export function trackResultMove(jobs, { from, to, size, modified, exceptId }) {
  for (const job of jobs) {
    if (job.id !== exceptId && !job.resultCleanedAt && same(job.outputPath, from) && job.size === size && job.outputModified === modified) {
      job.outputPath = to; job.storageUpdatedAt = Date.now();
    }
  }
}
export function markOverwrittenResults(jobs, { sourcePath, size, modified, exceptId }) {
  for (const job of jobs) {
    if (job.id !== exceptId && !job.resultCleanedAt && same(job.outputPath, sourcePath) && job.size === size && job.outputModified === modified) {
      job.resultCleanedAt = Date.now(); job.storageUpdatedAt = Date.now();
      job.resultRemovalReason = '该处理版本已被直接覆盖，任务记录保留。';
    }
  }
}
async function inspect(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !same(await fs.realpath(file), file)) return null;
    return stat;
  } catch (err) { if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return null; throw err; }
}
function backupPathIsManaged(r, file) {
  return r?.sourcePath && same(path.dirname(file), path.join(path.dirname(r.sourcePath), '.frame-backups'))
    && /^\d{13}_(?:[a-f0-9]{8}_|replaced_)/i.test(path.basename(file));
}

export async function buildStoragePlan({ dataDir, outputRoot, jobs, protectedPaths = [] }) {
  const protectedSet = new Set(protectedPaths.filter(Boolean).map(key));
  const exportProtected = exportProtectedPaths(jobs);
  const entries = [], seen = new Set();
  const add = async ({ file, category, label, jobId, effect, reference, expected }) => {
    if (!file || seen.has(key(file)) || protectedSet.has(key(file))) return;
    if (category === 'export' && exportProtected.has(key(file))) return;
    const stat = await inspect(file);
    if (!stat || (expected && (stat.size !== expected.size || stat.mtimeMs !== expected.modified))) return;
    const referenceStat = reference ? await inspect(reference) : null;
    if (reference && (!referenceStat || same(file, reference) || referenceStat.size !== stat.size)) return;
    seen.add(key(file));
    entries.push({ id: randomUUID(), path: file, category, label, jobId, effect, reference,
      size: stat.size, bytes: stat.nlink > 1 ? 0 : stat.size, sharedData: stat.nlink > 1,
      snapshot: snapshot(stat), referenceSnapshot: referenceStat ? snapshot(referenceStat) : null,
      defaultSelected: ['duplicate', 'cache'].includes(category) });
  };
  for (const job of jobs) {
    if (['queued', 'running'].includes(job.status)) continue;
    const r = job.replacement;
    if (r) {
      const kept = r.restoredAt ? r.replacedBackup : r.targetPath;
      const output = r.redundantOutputPath || (!r.exportMoved && !same(job.outputPath, kept) ? job.outputPath : null);
      if (output && kept) await add({ file: output, category: 'duplicate', label: '重复的导出结果', jobId: job.id, effect: 'output-duplicate', reference: kept });
      if (r.backupPath && backupPathIsManaged(r, r.backupPath) && !r.backupCleanedAt) {
        const expected = job.files?.[0] ? { size: job.files[0].size, modified: job.files[0].modified } : undefined;
        await add({ file: r.backupPath, category: r.restoredAt ? 'duplicate' : 'backup', label: r.restoredAt ? '恢复后多余的原片备份' : '原片备份（清理后不能恢复）',
          jobId: job.id, effect: 'original-backup', reference: r.restoredAt ? r.sourcePath : null, expected });
      }
      if (r.replacedBackup && backupPathIsManaged(r, r.replacedBackup) && !r.processedCleanedAt) {
        await add({ file: r.replacedBackup, category: 'backup', label: '恢复后保留的处理版本', jobId: job.id, effect: 'processed-backup', expected: { size: r.size, modified: r.modified } });
      }
    }
    if (job.stagingPath && same(path.dirname(job.stagingPath), path.dirname(job.outputPath)) && path.basename(job.stagingPath) === `.frame-${job.id}.${job.extension}`) {
      await add({ file: job.stagingPath, category: 'cache', label: '中断任务的临时文件', jobId: job.id, effect: 'cache' });
    }
  }
  // Known exports can live in custom output directories. Inspect only their exact
  // recorded paths; never scan a user's general-purpose custom directory.
  for (const job of jobs) {
    if (job.status !== 'completed' || job.replacement || job.resultCleanedAt) continue;
    await add({ file: job.outputPath, category: 'export', label: '导出结果（删除后无法还原）', jobId: job.id, effect: 'export', expected: { size: job.size, modified: job.outputModified } });
  }
  // The app's dedicated outputs folder may outlive the last 100 task records.
  // List regular media files individually, without following links or subfolders.
  if (outputRoot && same(await fs.realpath(outputRoot).catch(() => ''), outputRoot)) {
    const recordedPaths = new Set(jobs.map(job => job.outputPath).filter(Boolean).map(key));
    for (const entry of await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(outputRoot, entry.name);
      if (!entry.isFile() || entry.name.startsWith('.') || !exportExtensions.has(path.extname(entry.name).toLowerCase()) || recordedPaths.has(key(file))) continue;
      await add({ file, category: 'export', label: 'outputs 目录内的媒体文件（无任务记录）', effect: 'export' });
    }
  }
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  for (const [folder, pattern, label] of [
    ['imports', new RegExp(`^${uuid}_`, 'i'), '未使用的本地导入副本'],
    ['work', new RegExp(`^${uuid}(?:-preview\\.mp4|-attachment-\\d+\\.bin|\\.ffconcat)$`, 'i'), '未使用的预览 / 中间文件'],
  ]) {
    const root = path.resolve(dataDir, folder);
    if (!same(await fs.realpath(root).catch(() => ''), root)) continue;
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && pattern.test(entry.name)) await add({ file: path.join(root, entry.name), category: 'cache', label, effect: 'cache' });
    }
  }
  return { token: randomUUID(), expires: Date.now() + 5 * 60 * 1000, entries };
}

export function publicStoragePlan(plan) {
  return { token: plan.token, expires: plan.expires, entries: plan.entries.map(({ snapshot, referenceSnapshot, reference, effect, ...entry }) => ({ ...entry, retainedPath: reference || null })) };
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function cleanStorage(plan, ids, jobs, { protectedPaths = [] } = {}) {
  if (!plan || plan.expires < Date.now()) throw new InputError('清理清单已过期，请重新查看');
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !plan.entries.some(e => e.id === id))) throw new InputError('请选择清单内有效的文件');
  const protectedSet = new Set(protectedPaths.filter(Boolean).map(key));
  const exportProtected = exportProtectedPaths(jobs);
  const selected = new Set(ids), removed = [], skipped = [];
  // Preserve the reference until duplicate removal finishes, even if the user also selects that backup.
  const entries = plan.entries.filter(e => selected.has(e.id)).sort((a, b) => (a.category === 'backup') - (b.category === 'backup'));
  for (const entry of entries) {
    try {
      if (protectedSet.has(key(entry.path))) throw new Error('文件正在使用');
      if (entry.category === 'export' && exportProtected.has(key(entry.path))) throw new Error('该文件已作为素材或替换结果使用，已保留');
      const stat = await inspect(entry.path);
      if (!stat || !matches(stat, entry.snapshot)) throw new Error('文件已变化或已不存在');
      if (entry.reference) {
        const reference = await inspect(entry.reference);
        if (!reference || !matches(reference, entry.referenceSnapshot)) throw new Error('保留的文件已变化，未清理该副本');
        if (await digest(entry.path) !== await digest(entry.reference)) throw new Error('两份文件内容不同，已保留');
        const [sourceAfter, referenceAfter] = await Promise.all([inspect(entry.path), inspect(entry.reference)]);
        if (!sourceAfter || !referenceAfter || !matches(sourceAfter, entry.snapshot) || !matches(referenceAfter, entry.referenceSnapshot)) throw new Error('核对时文件发生变化，已保留');
      }
      await fs.unlink(entry.path);
      removed.push({ path: entry.path, bytes: entry.bytes });
      const job = jobs.find(j => j.id === entry.jobId);
      if (job) {
        const r = job.replacement;
        if (entry.effect === 'output-duplicate') {
          if (same(job.outputPath, entry.path)) { job.outputPath = entry.reference; job.outputModified = entry.referenceSnapshot.modified; }
          r.redundantOutputPath = null; r.exportMoved = true;
        }
        if (entry.effect === 'original-backup') r.backupCleanedAt = Date.now();
        if (entry.effect === 'processed-backup') r.processedCleanedAt = Date.now();
        if (same(job.outputPath, entry.path)) job.resultCleanedAt = Date.now();
        job.storageUpdatedAt = Date.now();
      }
      for (const related of jobs) {
        if (same(related.outputPath, entry.path)) { related.resultCleanedAt = Date.now(); related.storageUpdatedAt = Date.now(); if (entry.category === 'export') related.resultRemovalReason = '导出文件已清理，任务记录保留。'; }
      }
      if (entry.category === 'backup' || entry.effect === 'original-backup') await fs.rmdir(path.dirname(entry.path)).catch(() => {});
    } catch (err) { skipped.push({ path: entry.path, reason: err.message }); }
  }
  return { removed, skipped, freedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0) };
}
