import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildStoragePlan, cleanStorage, trackResultMove } from '../server/storage.mjs';
import { applyReplacement, restoreOriginal } from '../server/replacement.mjs';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-storage-test-'));
  try { return await fn(root); }
  finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith('frame-storage-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
async function newJob(root) {
  const sourcePath = path.join(root, 'source.mp4'), outputPath = path.join(root, 'output.mp4');
  await fs.writeFile(sourcePath, 'ORIGINAL VIDEO'); await fs.writeFile(outputPath, 'PROCESSED VIDEO');
  const source = await fs.stat(sourcePath), output = await fs.stat(outputPath);
  return { id: randomUUID(), status: 'completed', operation: 'trim', extension: 'mp4', outputPath, size: output.size, outputModified: output.mtimeMs,
    files: [{ path: sourcePath, size: source.size, modified: source.mtimeMs, video: {} }] };
}

test('new replacement retains one optional original backup and never lists the current video', async () => fixture(async root => {
  const job = await newJob(root);
  job.replacement = await applyReplacement(job, 'source.mp4'); job.outputPath = job.replacement.targetPath;
  const plan = await buildStoragePlan({ dataDir: path.join(root, 'data'), jobs: [job] });
  assert.equal(plan.entries.length, 1); assert.equal(plan.entries[0].category, 'backup'); assert.equal(plan.entries[0].defaultSelected, false);
  assert.notEqual(plan.entries[0].path, job.outputPath);
  const result = await cleanStorage(plan, [plan.entries[0].id], [job]);
  assert.equal(result.removed.length, 1); assert(job.replacement.backupCleanedAt);
  assert.equal(await fs.readFile(job.outputPath, 'utf8'), 'PROCESSED VIDEO');
  await assert.rejects(() => restoreOriginal(job, 'source.mp4'), /备份可能已清理/);
}));

test('legacy duplicates are consolidated and result links follow the kept processed version', async () => fixture(async root => {
  const job = await newJob(root), originalPath = job.files[0].path;
  const directory = path.join(root, '.frame-backups'); await fs.mkdir(directory);
  const originalBackup = path.join(directory, `${Date.now()}_1234abcd_source.mp4`);
  const processedBackup = path.join(directory, `${Date.now()}_replaced_source.mp4`);
  await fs.link(originalPath, originalBackup); await fs.copyFile(job.outputPath, processedBackup);
  const processed = await fs.stat(processedBackup);
  job.replacement = { sourcePath: originalPath, targetPath: originalPath, backupDirectory: directory, backupPath: originalBackup, replacedBackup: processedBackup,
    size: processed.size, modified: processed.mtimeMs, restoredAt: Date.now() };
  const plan = await buildStoragePlan({ dataDir: path.join(root, 'data'), jobs: [job] });
  assert.equal(plan.entries.filter(e => e.defaultSelected).length, 2);
  const result = await cleanStorage(plan, plan.entries.filter(e => e.defaultSelected).map(e => e.id), [job]);
  assert.equal(result.removed.length, 2); assert.equal(result.skipped.length, 0); assert.equal(job.outputPath, processedBackup);
  assert.equal(await fs.readFile(originalPath, 'utf8'), 'ORIGINAL VIDEO');
  assert.equal(await fs.readFile(job.outputPath, 'utf8'), 'PROCESSED VIDEO');
  assert.equal((await fs.readdir(directory)).length, 1);
  const next = await buildStoragePlan({ dataDir: path.join(root, 'data'), jobs: [job] });
  assert.equal(next.entries.length, 1); assert.equal(next.entries[0].defaultSelected, false);
  await cleanStorage(next, [next.entries[0].id], [job]);
  assert(job.resultCleanedAt); assert.equal(await fs.readFile(originalPath, 'utf8'), 'ORIGINAL VIDEO');
}));

test('same-size different-content exports are preserved during duplicate verification', async () => fixture(async root => {
  const job = await newJob(root), kept = path.join(root, 'kept.mp4');
  await fs.writeFile(kept, 'X'.repeat(job.size));
  job.replacement = { sourcePath: job.files[0].path, targetPath: kept, size: job.size, modified: (await fs.stat(kept)).mtimeMs };
  const plan = await buildStoragePlan({ dataDir: path.join(root, 'data'), jobs: [job] });
  assert.equal(plan.entries.length, 1);
  const result = await cleanStorage(plan, [plan.entries[0].id], [job]);
  assert.equal(result.removed.length, 0); assert.match(result.skipped[0].reason, /内容不同/);
  assert.equal(await fs.readFile(job.outputPath, 'utf8'), 'PROCESSED VIDEO');
}));

test('cleanup only includes owned cache names and skips active, changed, or unregistered files', async () => fixture(async root => {
  const data = path.join(root, 'data'), work = path.join(data, 'work'), imports = path.join(data, 'imports');
  await fs.mkdir(work, { recursive: true }); await fs.mkdir(imports);
  const unused = path.join(work, `${randomUUID()}-preview.mp4`), active = path.join(imports, `${randomUUID()}_active.mp4`), unrelated = path.join(work, 'personal-video.mp4');
  await fs.writeFile(unused, 'CACHE'); await fs.writeFile(active, 'ACTIVE'); await fs.writeFile(unrelated, 'UNRELATED');
  const plan = await buildStoragePlan({ dataDir: data, jobs: [], protectedPaths: [active] });
  assert.equal(plan.entries.length, 1); assert.equal(plan.entries[0].path, unused);
  await fs.appendFile(unused, 'CHANGED');
  const result = await cleanStorage(plan, [plan.entries[0].id], []);
  assert.equal(result.removed.length, 0); assert.equal(result.skipped.length, 1);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'UNRELATED');
  const fresh = await buildStoragePlan({ dataDir: data, jobs: [], protectedPaths: [active] });
  const protectedResult = await cleanStorage(fresh, [fresh.entries[0].id], [], { protectedPaths: [unused] });
  assert.equal(protectedResult.removed.length, 0);
  assert.equal((await cleanStorage(fresh, [fresh.entries[0].id], [])).removed.length, 1);
}));

test('expired plans, unknown entry ids and backup paths outside the managed directory are rejected', async () => fixture(async root => {
  const job = await newJob(root);
  job.replacement = { sourcePath: job.files[0].path, targetPath: job.outputPath, exportMoved: true, backupPath: job.files[0].path };
  const plan = await buildStoragePlan({ dataDir: root, jobs: [job] });
  assert.equal(plan.entries.length, 0);
  await assert.rejects(() => cleanStorage(plan, [randomUUID()], [job]), /请选择/);
  await assert.rejects(() => cleanStorage({ ...plan, expires: 1 }, [], [job]), /过期/);
  assert.equal(await fs.readFile(job.files[0].path, 'utf8'), 'ORIGINAL VIDEO');
}));

test('older task result locations follow a later replacement and restoration', async () => fixture(async root => {
  const job = await newJob(root), source = job.files[0];
  const older = { id: randomUUID(), status: 'completed', outputPath: source.path, size: source.size, outputModified: source.modified };
  job.replacement = await applyReplacement(job, 'source.mp4');
  trackResultMove([older, job], { from: source.path, to: job.replacement.backupPath, size: source.size, modified: source.modified, exceptId: job.id });
  assert.equal(await fs.readFile(older.outputPath, 'utf8'), 'ORIGINAL VIDEO');
  job.replacement = await restoreOriginal(job, 'source.mp4');
  trackResultMove([older, job], { from: job.replacement.backupPath, to: source.path, size: source.size, modified: source.modified, exceptId: job.id });
  assert.equal(older.outputPath, source.path); assert.equal(await fs.readFile(older.outputPath, 'utf8'), 'ORIGINAL VIDEO');
}));

test('ordinary completed exports are optional and removing them invalidates only the result', async () => fixture(async root => {
  const job = await newJob(root);
  const plan = await buildStoragePlan({ dataDir: root, jobs: [job] });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].path, job.outputPath);
  assert.equal(plan.entries[0].category, 'export');
  assert.equal(plan.entries[0].defaultSelected, false);
  const result = await cleanStorage(plan, [plan.entries[0].id], [job]);
  assert.equal(result.removed.length, 1); assert(job.resultCleanedAt);
  assert.match(job.resultRemovalReason, /导出文件已清理/);
  assert.equal(await fs.readFile(job.files[0].path, 'utf8'), 'ORIGINAL VIDEO');
  assert.equal((await buildStoragePlan({ dataDir: root, jobs: [job] })).entries.length, 0);
}));

test('outputs folder supports exports beyond history but excludes subfolders, originals and changed records', async () => fixture(async root => {
  const outputRoot = path.join(root, 'outputs'); await fs.mkdir(outputRoot);
  const job = await newJob(outputRoot);
  const orphan = path.join(outputRoot, 'older-export.mp4'); await fs.writeFile(orphan, 'OLD EXPORT');
  const unrelated = path.join(outputRoot, 'notes.txt'); await fs.writeFile(unrelated, 'NOT MEDIA');
  await fs.mkdir(path.join(outputRoot, 'child')); await fs.writeFile(path.join(outputRoot, 'child', 'nested.mp4'), 'NESTED');
  // A tracked file altered externally must not be reclassified as an untracked export.
  await fs.appendFile(job.outputPath, 'EXTERNAL CHANGE');
  const plan = await buildStoragePlan({ dataDir: root, outputRoot, jobs: [job] });
  assert.deepEqual(plan.entries.map(e => e.path), [orphan]);
  assert.equal(plan.entries[0].defaultSelected, false);
  await cleanStorage(plan, [plan.entries[0].id], [job]);
  assert.equal(await fs.readFile(job.files[0].path, 'utf8'), 'ORIGINAL VIDEO');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'NOT MEDIA');
  assert.equal(await fs.readFile(path.join(outputRoot, 'child', 'nested.mp4'), 'utf8'), 'NESTED');
}));

test('exports newly used as inputs, changed on disk or protected by an open editor are retained', async () => fixture(async root => {
  const job = await newJob(root), jobs = [job];
  let plan = await buildStoragePlan({ dataDir: root, jobs });
  jobs.push({ id: randomUUID(), files: [{ path: job.outputPath }] });
  let result = await cleanStorage(plan, [plan.entries[0].id], jobs);
  assert.equal(result.removed.length, 0); assert.match(result.skipped[0].reason, /素材/);
  jobs.pop();
  result = await cleanStorage(plan, [plan.entries[0].id], jobs, { protectedPaths: [job.outputPath] });
  assert.equal(result.removed.length, 0);
  await fs.appendFile(job.outputPath, 'CHANGED');
  result = await cleanStorage(plan, [plan.entries[0].id], jobs);
  assert.equal(result.removed.length, 0); assert.match(result.skipped[0].reason, /变化/);
  plan = await buildStoragePlan({ dataDir: root, jobs }); assert.equal(plan.entries.length, 0);
}));
