import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyReplacement, replacementPlan, restoreOriginal } from '../server/replacement.mjs';
import { buildStoragePlan, markOverwrittenResults } from '../server/storage.mjs';

async function fixture(fn, extension = 'mp4') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-replacement-options-'));
  try {
    const sourcePath = path.join(root, `original.${extension}`), outputPath = path.join(root, 'render.mp4');
    await fs.writeFile(sourcePath, 'ORIGINAL'); await fs.writeFile(outputPath, 'PROCESSED VIDEO');
    const source = await fs.stat(sourcePath), output = await fs.stat(outputPath);
    const job = { id: randomUUID(), status: 'completed', operation: 'trim', extension: 'mp4', size: output.size, outputModified: output.mtimeMs, outputPath,
      files: [{ path: sourcePath, size: source.size, modified: source.mtimeMs, video: {} }] };
    await fn({ root, job, sourcePath, outputPath });
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith('frame-replacement-options-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

test('custom filename preserves the original backup and restores the original name', () => fixture(async ({ root, job, sourcePath }) => {
  const options = { targetName: '剪辑完成 01', mode: 'backup' }, plan = await replacementPlan(job, options);
  assert.equal(plan.targetFileName, '剪辑完成 01.mp4'); assert.equal(plan.mode, 'backup'); assert.equal(plan.formatChanged, true);
  const sealed = { targetName: plan.targetName, mode: plan.mode };
  job.replacement = await applyReplacement(job, 'original.mov', sealed);
  assert.equal(await fs.readFile(path.join(root, '剪辑完成 01.mp4'), 'utf8'), 'PROCESSED VIDEO');
  assert.equal(await fs.readFile(job.replacement.backupPath, 'utf8'), 'ORIGINAL');
  await assert.rejects(fs.access(sourcePath));
  job.replacement = await restoreOriginal(job, 'original.mov');
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(job.replacement.replacedBackup, 'utf8'), 'PROCESSED VIDEO');
  assert(job.replacement.replacedBackup.endsWith('剪辑完成 01.mp4'));
}, 'mov'));

test('filename normalization is stable across preview, confirmation and execution', () => fixture(async ({ job }) => {
  for (const targetName of ['edited', 'edited.mp4', 'archive.mp4.mp4', '中文.v2']) {
    const first = await replacementPlan(job, { targetName });
    const second = await replacementPlan(job, { targetName: first.targetName });
    assert.equal(first.targetPath, second.targetPath);
  }
  assert.equal((await replacementPlan(job, { targetName: 'archive.mp4.mp4' })).targetFileName, 'archive.mp4.mp4');
}));

test('direct overwrite of the same name leaves only the processed file and has no restore path', () => fixture(async ({ root, job, sourcePath, outputPath }) => {
  job.replacement = await applyReplacement(job, 'original.mp4', { mode: 'overwrite' }); job.outputPath = job.replacement.targetPath;
  assert.equal(job.replacement.backupPath, null); assert(job.replacement.originalDiscardedAt); assert.equal(job.replacement.mode, 'overwrite');
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'PROCESSED VIDEO'); await assert.rejects(fs.access(outputPath));
  assert.deepEqual(await fs.readdir(root), ['original.mp4']);
  await assert.rejects(() => restoreOriginal(job, 'original.mp4'), /直接覆盖/);
  assert.equal((await buildStoragePlan({ dataDir: path.join(root, 'data'), jobs: [job] })).entries.length, 0);
}));

test('direct overwrite can rename the result without keeping a backup or duplicate export', () => fixture(async ({ root, job, sourcePath, outputPath }) => {
  const r = await applyReplacement(job, 'original.mp4', { mode: 'overwrite', targetName: '新名称.mp4' });
  assert.equal(await fs.readFile(r.targetPath, 'utf8'), 'PROCESSED VIDEO');
  await assert.rejects(fs.access(sourcePath)); await assert.rejects(fs.access(outputPath));
  assert.deepEqual(await fs.readdir(root), ['新名称.mp4']);
}));

test('choosing the existing exported filename never deletes the only processed result', async () => {
  for (const mode of ['backup', 'overwrite']) await fixture(async ({ root, job, sourcePath, outputPath }) => {
    const plan = await replacementPlan(job, { mode, targetName: 'render.mp4' }); assert(plan.reuseOutput);
    job.replacement = await applyReplacement(job, 'original.mp4', { mode, targetName: plan.targetName });
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'PROCESSED VIDEO'); await assert.rejects(fs.access(sourcePath));
    if (mode === 'backup') assert.equal(await fs.readFile(job.replacement.backupPath, 'utf8'), 'ORIGINAL');
    else assert.deepEqual(await fs.readdir(root), ['render.mp4']);
  });
});

test('direct overwrite rejects unrelated collisions and unsafe filenames before touching source', () => fixture(async ({ root, job, sourcePath, outputPath }) => {
  const other = path.join(root, 'occupied.mp4'); await fs.writeFile(other, 'UNRELATED');
  for (const mode of ['backup', 'overwrite']) await assert.rejects(() => applyReplacement(job, 'original.mp4', { mode, targetName: 'occupied.mp4' }), /同名/);
  for (const targetName of ['../outside.mp4', 'nested/file', 'CON', '', 'bad\nname', '.mp4']) await assert.rejects(() => replacementPlan(job, { mode: 'overwrite', targetName }));
  await assert.rejects(() => replacementPlan(job, { mode: 'invalid' }));
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL'); assert.equal(await fs.readFile(outputPath, 'utf8'), 'PROCESSED VIDEO');
  assert.equal(await fs.readFile(other, 'utf8'), 'UNRELATED');
}));

test('failed original removal rolls back direct overwrite before committing', () => fixture(async ({ root, job, sourcePath, outputPath }) => {
  let failed = false;
  const fileOps = { ...fs, unlink: async file => {
    if (!failed && path.basename(file).startsWith('.frame-original-')) { failed = true; throw Object.assign(new Error('Original locked'), { code: 'EPERM' }); }
    return fs.unlink(file);
  } };
  await assert.rejects(() => applyReplacement(job, 'original.mp4', { mode: 'overwrite', targetName: 'renamed.mp4' }, fileOps), /Original locked/);
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL'); assert.equal(await fs.readFile(outputPath, 'utf8'), 'PROCESSED VIDEO');
  assert.deepEqual((await fs.readdir(root)).sort(), ['original.mp4', 'render.mp4']);
}));

test('a destination created during replacement is kept and the original is restored', () => fixture(async ({ root, job, sourcePath, outputPath }) => {
  const target = path.join(root, 'raced.mp4');
  const fileOps = { ...fs, link: async (from, to) => {
    if (to === target) { await fs.writeFile(target, 'OTHER APP'); throw Object.assign(new Error('Destination appeared'), { code: 'EEXIST' }); }
    return fs.link(from, to);
  } };
  await assert.rejects(() => applyReplacement(job, 'original.mp4', { mode: 'overwrite', targetName: 'raced.mp4' }, fileOps), /Destination appeared/);
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'ORIGINAL'); assert.equal(await fs.readFile(outputPath, 'utf8'), 'PROCESSED VIDEO');
  assert.equal(await fs.readFile(target, 'utf8'), 'OTHER APP');
}));

test('direct overwrite marks older task references to the removed version without losing the new task', () => fixture(async ({ job, sourcePath }) => {
  const source = job.files[0], older = { id: 'old', outputPath: sourcePath, size: source.size, outputModified: source.modified };
  const unrelated = { ...older, id: 'unrelated', outputPath: sourcePath + '.other' };
  markOverwrittenResults([older, unrelated, job], { sourcePath, size: source.size, modified: source.modified, exceptId: job.id });
  assert(older.resultCleanedAt); assert.match(older.resultRemovalReason, /直接覆盖/); assert(!unrelated.resultCleanedAt); assert(!job.resultCleanedAt);
}));
