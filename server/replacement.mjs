import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, safeName } from './operations.mjs';

const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const exists = async p => { try { await fs.lstat(p); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; } };
export function canReplace(job) {
  return job.status === 'completed' && job.files?.length === 1 && job.files[0].video && !job.files[0].imported && !['gif', 'snapshot'].includes(job.operation) && ['mp4', 'm4v', 'mkv', 'mov', 'webm'].includes(job.extension) && !job.replacement && !job.resultCleanedAt;
}
export async function replacementPlan(job, options = {}) {
  if (!canReplace(job)) throw new InputError('该结果无法替换原素材。请选择直接读取的单个原视频及其视频输出。');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new InputError('替换设置无效');
  const mode = options.mode ?? 'backup';
  if (!['backup', 'overwrite'].includes(mode)) throw new InputError('请选择保留备份或直接覆盖');
  const source = job.files[0];
  if (same(source.path, job.outputPath)) throw new InputError('处理结果与原文件路径相同，无法再次替换');
  const original = await fs.stat(source.path);
  if (!original.isFile() || original.size !== source.size || original.mtimeMs !== source.modified) throw new InputError('原文件已发生变化，为保护后续修改，本次替换已停止');
  const output = await fs.stat(job.outputPath);
  if (!output.isFile() || output.size !== job.size || (job.outputModified && output.mtimeMs !== job.outputModified)) throw new InputError('导出文件已发生变化，请重新导出后替换');
  const suffix = `.${job.extension}`;
  let targetName = safeName(options.targetName === undefined ? `${path.parse(source.path).name}${suffix}` : options.targetName);
  if (!targetName.toLowerCase().endsWith(suffix)) targetName = safeName(`${targetName}${suffix}`);
  if (!targetName.slice(0, -suffix.length).trim()) throw new InputError('请输入文件名称');
  const targetFileName = targetName;
  const targetPath = path.join(path.dirname(source.path), targetFileName);
  const reuseOutput = same(targetPath, job.outputPath);
  if (!same(targetPath, source.path) && !reuseOutput && await exists(targetPath)) throw new InputError('同名文件已存在，请更换名称，避免覆盖其他素材');
  return { sourcePath: source.path, sourceDirectory: path.dirname(source.path), targetPath, targetName, targetFileName, extension: job.extension,
    outputPath: job.outputPath, confirmName: path.basename(source.path), mode, keepBackup: mode === 'backup', reuseOutput,
    formatChanged: path.extname(source.path).toLowerCase() !== `.${job.extension}`, nameChanged: path.basename(source.path) !== targetFileName,
    backupDirectory: path.join(path.dirname(source.path), '.frame-backups') };
}

export async function applyReplacement(job, confirmedName, options = {}, fileOps = fs) {
  const plan = await replacementPlan(job, options);
  if (confirmedName !== plan.confirmName) throw new InputError('文件名确认不匹配，未执行替换');
  const id = randomUUID();
  const backupPath = plan.keepBackup ? path.join(plan.backupDirectory, `${Date.now()}_${id.slice(0, 8)}_${plan.confirmName}`) : null;
  // Direct overwrite holds a temporary rollback file only until the new result is fully installed.
  const rollbackPath = backupPath || path.join(plan.sourceDirectory, `.frame-original-${id}${path.extname(plan.sourcePath)}`);
  const staged = path.join(path.dirname(plan.sourcePath), `.frame-replace-${id}.${job.extension}`);
  if (plan.keepBackup) await fileOps.mkdir(plan.backupDirectory, { recursive: true });
  let moved = false, installed = false, originalDiscarded = false, installedStat;
  try {
    // Same-volume replacement shares data until commit. Cross-volume exports use one temporary copy.
    try { await fileOps.link(job.outputPath, staged); }
    catch (err) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err;
      await fileOps.copyFile(job.outputPath, staged, constants.COPYFILE_EXCL);
    }
    // Recheck after copying, which can take a while for large videos.
    await replacementPlan(job, { targetName: plan.targetName, mode: plan.mode });
    await fileOps.rename(plan.sourcePath, rollbackPath); moved = true;
    if (!plan.reuseOutput) { await fileOps.link(staged, plan.targetPath); installed = true; }
    const stat = await fileOps.stat(plan.targetPath); installedStat = stat;
    const result = { ...plan, backupPath, appliedAt: Date.now(), size: stat.size, modified: stat.mtimeMs, storageVersion: 3 };
    if (!plan.keepBackup) {
      await fileOps.unlink(rollbackPath);
      originalDiscarded = true;
      result.originalDiscardedAt = Date.now();
    }
    if (plan.reuseOutput) { result.exportMoved = true; return result; }
    try {
      const outputNow = await fileOps.stat(job.outputPath);
      if (outputNow.size !== job.size || (job.outputModified && outputNow.mtimeMs !== job.outputModified)) throw new Error('导出文件已发生变化');
      await fileOps.unlink(job.outputPath);
      result.exportMoved = true;
    } catch {
      // The replacement is complete; a locked/changed extra file remains available for reviewed cleanup.
      result.redundantOutputPath = job.outputPath;
    }
    return result;
  } catch (err) {
    if (originalDiscarded) throw err;
    if (installed) {
      // Never remove a different file that another application put at the target path.
      const current = await fileOps.lstat(plan.targetPath).catch(() => null);
      const owned = installedStat || await fileOps.stat(staged).catch(() => null);
      if (current && owned && current.ino === owned.ino && current.dev === owned.dev) await fileOps.unlink(plan.targetPath).catch(() => {});
    }
    if (moved) {
      // A hard link never overwrites a file another program may have created.
      try { await fileOps.link(rollbackPath, plan.sourcePath); await fileOps.unlink(rollbackPath); }
      catch { throw new Error(`替换未完成，原文件保存在 ${rollbackPath}。未覆盖原位置的其他文件。`); }
    }
    throw err;
  } finally { await fileOps.unlink(staged).catch(() => {}); }
}

export async function restoreOriginal(job, confirmedName) {
  const r = job.replacement;
  if (r?.mode === 'overwrite') throw new InputError('本次使用直接覆盖，未保留原片备份，无法通过本工具还原');
  if (!r || !r.backupPath || r.restoredAt || r.backupCleanedAt) throw new InputError('没有可恢复的原文件，备份可能已清理');
  if (confirmedName !== r.confirmName) throw new InputError('文件名确认不匹配，未恢复');
  const current = await fs.stat(r.targetPath);
  if (current.size !== r.size || current.mtimeMs !== r.modified) throw new InputError('替换后的文件又发生了修改，已停止自动恢复。原文件仍在备份目录中。');
  if (!same(r.sourcePath, r.targetPath) && await exists(r.sourcePath)) throw new InputError('原位置已有文件，已停止自动恢复');
  const original = await fs.stat(r.backupPath);
  const source = job.files[0];
  if (original.size !== source.size || original.mtimeMs !== source.modified) throw new InputError('原片备份已发生变化，已停止自动恢复');
  const replacedBackup = path.join(r.backupDirectory, `${Date.now()}_${randomUUID().slice(0, 8)}_processed_${path.basename(r.targetPath)}`);
  await fs.rename(r.targetPath, replacedBackup);
  try { await fs.link(r.backupPath, r.sourcePath); }
  catch (err) {
    try { await fs.link(replacedBackup, r.targetPath); await fs.unlink(replacedBackup); } catch { /* Keep the processed version in the backup folder. */ }
    throw err;
  }
  const result = { ...r, restoredAt: Date.now(), replacedBackup, storageVersion: 2 };
  try { await fs.unlink(r.backupPath); result.originalBackupMoved = true; }
  catch { result.redundantOriginalBackup = r.backupPath; }
  return result;
}
