import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { InputError } from './operations.mjs';

export const NATIVE_SCHEME = 'frame-local-reveal';
const signature = job => JSON.stringify([job.id, job.outputPath, job.size, job.outputModified, job.resultCleanedAt]);
const fail = message => { throw new InputError(message); };

export class NativeRevealBridge {
  constructor({ enabled = false, secret = '', clock = Date.now } = {}) {
    this.enabled = enabled; this.secret = secret; this.clock = clock;
    this.tickets = new Map(); this.byJob = new Map();
  }
  static async load(dataDir, port) {
    if (process.platform !== 'win32') return new NativeRevealBridge();
    try {
      const folder = path.join(dataDir, 'native-bridge');
      const config = JSON.parse(await fs.readFile(path.join(folder, 'config.json'), 'utf8'));
      await fs.access(path.join(folder, 'FrameReveal.exe'));
      if (config.installed !== true || config.port !== port || !/^[a-f0-9]{64}$/.test(config.secret)) return new NativeRevealBridge();
      return new NativeRevealBridge({ enabled: true, secret: config.secret });
    } catch { return new NativeRevealBridge(); }
  }
  authorized(value) {
    return this.enabled && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === this.secret.length && timingSafeEqual(Buffer.from(value), Buffer.from(this.secret));
  }
  offer(job) {
    if (!this.enabled || job.status !== 'completed' || job.resultCleanedAt) return null;
    const now = this.clock(), key = signature(job), previous = this.tickets.get(this.byJob.get(job.id));
    if (previous && previous.signature === key && ['offered', 'claiming', 'claimed'].includes(previous.state) && previous.expires > now + 30000) return this.link(previous);
    for (const [id, ticket] of this.tickets) if (ticket.expires + 300000 < now) this.tickets.delete(id);
    if (this.tickets.size > 1000) return null;
    const id = randomBytes(32).toString('hex');
    const ticket = { id, jobId: job.id, signature: key, path: job.outputPath, state: 'offered', expires: now + 180000 };
    this.tickets.set(id, ticket); this.byJob.set(job.id, id);
    return this.link(ticket);
  }
  link(ticket) { return { id: ticket.id, url: `${NATIVE_SCHEME}://reveal/${ticket.id}`, expires: ticket.expires }; }
  async claim(id, getJob) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.expires <= this.clock()) fail('打开请求已过期，请重新点击打开位置');
    if (ticket.state !== 'offered') fail('打开请求已使用或已取消');
    ticket.state = 'claiming';
    try {
      const job = getJob(ticket.jobId);
      if (!job || signature(job) !== ticket.signature || job.status !== 'completed') fail('结果位置已变化，请重新点击打开位置');
      const stat = await fs.stat(ticket.path);
      if (!stat.isFile() || stat.size !== job.size || (job.outputModified && stat.mtimeMs !== job.outputModified)) fail('结果文件已变化，请核对文件后再打开');
      if (ticket.state !== 'claiming') fail('打开请求已取消');
      ticket.state = 'claimed'; ticket.claimedAt = this.clock();
      return { path: ticket.path };
    } catch (error) { ticket.state = 'failed'; ticket.error = error.message; throw error; }
  }
  complete(id, evidence) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.state !== 'claimed' || this.clock() - ticket.claimedAt > 30000) fail('打开请求已结束');
    if (typeof evidence?.error === 'string') {
      ticket.state = 'failed'; ticket.error = evidence.error.slice(0, 600); return;
    }
    if (evidence?.folderMatched !== true || evidence.visible !== true || evidence.minimized !== false || !Number.isSafeInteger(evidence.windowHandle) || evidence.windowHandle <= 0) {
      ticket.state = 'failed'; ticket.error = '本机助手未能确认文件夹窗口可见'; return;
    }
    ticket.state = 'completed';
    ticket.result = { ok: true, verified: true, native: true, path: ticket.path, windowHandle: evidence.windowHandle,
      foreground: evidence.foreground === true, selected: evidence.selected === true };
  }
  status(id) {
    const ticket = this.tickets.get(id);
    if (!ticket) fail('打开请求不存在，请重新点击');
    if (['offered', 'claiming'].includes(ticket.state) && ticket.expires <= this.clock()) { ticket.state = 'failed'; ticket.error = '打开请求已过期，请重新点击'; }
    if (ticket.state === 'claimed' && this.clock() - ticket.claimedAt > 30000) { ticket.state = 'failed'; ticket.error = '本机助手响应超时，可使用兼容方式打开'; }
    return { state: ticket.state, result: ticket.result, error: ticket.error };
  }
  cancel(id) {
    const ticket = this.tickets.get(id);
    if (ticket && ['offered', 'claiming'].includes(ticket.state)) ticket.state = 'cancelled';
  }
}
