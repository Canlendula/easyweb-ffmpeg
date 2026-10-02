import { icon } from './icons.js';
import { originalContainer, sourceVideoRate, trimPresetDefaults } from './trim-presets.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tools = [
  { id: 'trim', name: '视频裁剪', icon: 'cut', title: '留下你想要的片段', desc: '拖动时间轴，轻松截取视频。剩下的，交给 FFmpeg。' },
  { id: 'transcode', name: '转码与压缩', icon: 'convert', title: '让视频，适配下一站', desc: '选择编码和画质，用本机 CPU 或显卡完成转换。' },
  { id: 'concat', name: '视频拼接', icon: 'merge', title: '把片段，连成完整故事', desc: '添加多个视频，调整顺序，一次导出。' },
  { id: 'audio', name: '音频工具', icon: 'audio', title: '声音，也可以单独处理', desc: '提取音频、移除声音、调整音量，或换上一条新音轨。' },
  { id: 'resize', name: '尺寸与旋转', icon: 'resize', title: '找到画面的合适尺寸', desc: '调整分辨率、帧率和方向，让画面恰到好处。' },
  { id: 'gif', name: '生成 GIF', icon: 'gif', title: '让精彩，循环播放', desc: '选取一段短片，生成经过调色板优化的 GIF 动图。' },
  { id: 'snapshot', name: '导出画面', icon: 'image', title: '定格值得留下的一帧', desc: '定位视频中的瞬间，保存为原始尺寸的 PNG 或 JPG。' },
  { id: 'cover', name: '替换封面', icon: 'image', title: '给视频换一张封面', desc: '写入 JPG 或 PNG 封面，保留原音视频内容，无需重新编码。' },
  { id: 'remux', name: '转换封装', icon: 'box', title: '换个格式，保留原画质', desc: '复制视频和音频流，快速转换容器，无需重新编码。' },
];
const state = { token: '', settings: {}, system: { encoders: [], ready: false }, files: [], activeId: '', operation: 'trim', options: {}, start: 0, end: 0, jobs: [], plan: null, commandError: '', previewFailed: false, busy: false, modalType: '' };
const current = () => state.files.find(f => f.id === state.activeId);
const player = () => current()?.video ? $('#video') : $('#audio');
const time = (value, full = true) => {
  const ms = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${full ? `.${String(ms % 1000).padStart(3, '0')}` : ''}`;
};
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
function parseTime(value) { const parts = value.trim().split(':'); if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) throw new Error('时间格式为 秒、分:秒 或 时:分:秒'); return parts.reduce((n, p) => n * 60 + Number(p), 0); }
function injectIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function positionToast() {
  const el = $('#toast');
  if (el.hidden) return;
  const host = $('#modal').open ? $('#modal') : $('#queue-dialog').open ? $('#queue-dialog') : document.body;
  if (typeof el.showPopover === 'function' && el.matches(':popover-open')) el.hidePopover();
  if (el.parentElement !== host) host.append(el);
  if (typeof el.showPopover === 'function') el.showPopover();
}
function hideToast() {
  const el = $('#toast');
  if (typeof el.hidePopover === 'function' && el.matches(':popover-open')) el.hidePopover();
  el.hidden = true;
}
function toast(message, error = false, duration) {
  const el = $('#toast'); el.textContent = message; el.hidden = false; el.classList.toggle('error', error);
  positionToast(); clearTimeout(toast.timer); toast.timer = setTimeout(hideToast, duration ?? (error ? 6500 : 3500));
}
const toastLayerObserver = new MutationObserver(positionToast);
for (const dialog of [$('#modal'), $('#queue-dialog')]) toastLayerObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
async function api(route, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(route, { method, headers: { 'X-Frame-Token': state.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
function safeAction(fn) { return async (...args) => { try { await fn(...args); } catch (err) { toast(err.message, true); } }; }
function defaultOptions(operation) {
  const defaults = { codec: 'h264', encoder: 'auto', quality: 'balanced', container: operation === 'remux' ? 'mkv' : 'mp4', mode: operation === 'concat' ? 'normalize' : 'accurate', height: operation === 'concat' ? '720' : 'original', fps: operation === 'gif' ? '12' : operation === 'concat' ? '30' : 'original', rotate: '0', flip: false, action: 'extract', format: operation === 'snapshot' ? 'png' : 'mp3', track: '0', volume: 100, width: '480', time: 0 };
  return operation === 'trim' ? { ...defaults, ...trimPresetDefaults('original', current()) } : defaults;
}
state.options = defaultOptions('trim');
function setOperation(id) {
  player()?.pause(); state.operation = id; state.options = defaultOptions(id);
  state.trimProfiles = {}; state.trimAdvancedOpen = false;
  if (id === 'gif' && state.end - state.start > 10) state.end = Math.min(state.start + 10, current()?.duration || 0);
  if (id === 'audio' && current()?.video) state.options.action = 'extract';
  const tool = tools.find(t => t.id === id);
  $('#breadcrumb-title').textContent = tool.name;
  $('#page-title').innerHTML = `${esc(tool.title)}<span>。</span>`;
  $('#page-description').textContent = tool.desc;
  $$('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.tool === id); el.setAttribute('aria-current', el.dataset.tool === id ? 'page' : 'false'); });
  $('#output-name').value = '';
  renderOptions(); renderFiles(); renderRange(); schedulePlan();
}
const option = (value, label, selected) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
const selectField = (key, label, options) => `<div class="field"><label for="option-${key}">${label}</label><select id="option-${key}" data-option="${key}">${options.map(([value, text]) => option(value, text, state.options[key])).join('')}</select></div>`;
const segments = (key, label, items) => `<div class="field"><label>${label}</label><div class="segment-control">${items.map(([value, text]) => `<button data-option-button="${key}" data-value="${value}" class="${state.options[key] === value ? 'active' : ''}" aria-pressed="${state.options[key] === value}">${text}</button>`).join('')}</div></div>`;
function deviceField(codec = state.options.codec) {
  const encoders = state.system.encoders.filter(e => e.available && e.codec === codec);
  const automatic = encoders.find(e => e.hardware) || encoders.find(e => !e.hardware);
  const label = state.system.checking ? '自动选择 · 正在检测…' : automatic ? `自动选择 · ${automatic.label}` : '自动选择 · 暂无可用编码器';
  return selectField('encoder', '处理设备', [['auto', label], ...encoders.filter(e => e.hardware).map(e => [e.id, e.label]), ['cpu', 'CPU 编码 · 手动选择']]);
}
function qualityFields(codec = state.options.codec) {
  return `${deviceField(codec)}<div class="field"><label>画质与体积</label><div class="quality-cards">${[['high', '清晰优先', '更高画质'], ['balanced', '均衡', '日常推荐'], ['small', '体积优先', '更小文件']].map(([v, title, sub]) => `<button class="quality-card ${state.options.quality === v ? 'active' : ''}" data-option-button="quality" data-value="${v}" aria-pressed="${state.options.quality === v}"><b>${title}</b><span>${sub}</span></button>`).join('')}</div></div>`;
}
function compatibleDevice(requested, codec) {
  if (['cpu', 'auto'].includes(requested)) return requested;
  const vendor = requested?.slice(requested.indexOf('_'));
  return state.system.encoders.find(e => e.available && e.codec === codec && e.id.endsWith(vendor))?.id || 'auto';
}
function setTrimPreset(preset) {
  state.trimProfiles ||= {};
  state.trimProfiles[state.options.trimPreset] = { ...state.options };
  const device = state.options.encoder;
  state.options = { ...state.options, ...(state.trimProfiles[preset] || trimPresetDefaults(preset, current())) };
  state.options.encoder = compatibleDevice(device, state.options.codec);
  state.trimAdvancedOpen = false;
  $('#output-name').value = '';
  renderOptions(); schedulePlan();
  $(`[data-trim-preset="${preset}"]`)?.focus();
}
function trimSummary() {
  const o = state.options, label = { h264: 'H.264', hevc: 'H.265', av1: 'AV1' }[o.codec];
  return `${label} · ${o.rateControl === 'bitrate' ? `${o.videoBitrateMbps || '—'} Mbps` : '按画质分配码率'} · ${o.container.toUpperCase()}`;
}
function trimOptions() {
  const o = state.options, file = current();
  const choices = [['original', '保持原编码', '原画质保留 · 处理最快'], ['small', '体积优先', '精确裁剪 · 控制文件大小'], ['high', '画质优先', '精确裁剪 · 减少画质损失']];
  let html = `<fieldset class="trim-presets"><legend>你希望怎样导出？</legend>${choices.map(([id, name, hint]) => `<label class="trim-preset ${o.trimPreset === id ? 'active' : ''}"><input type="radio" name="trim-preset" value="${id}" data-trim-preset="${id}" ${o.trimPreset === id ? 'checked' : ''}><span class="preset-copy"><strong>${name}${id === 'original' ? '<em>默认</em>' : ''}</strong><small>${hint}</small></span></label>`).join('')}</fieldset>`;
  if (o.trimPreset === 'original') {
    html += `<div class="trim-explanation">${icon('info', 14)}<p>按附近关键帧裁剪，起止时间可能略有偏差。另两种方式可以精确到所选时间。</p></div><div class="original-format"><span>输出格式</span><strong>${file?.video ? `${esc(file.video.codec.toUpperCase())} · ${originalContainer(file).toUpperCase()}` : '沿用原视频'}</strong><small>直接复制音视频，无需调整设备或码率。</small></div>`;
    return html;
  }
  html += `<p class="preset-description">${o.trimPreset === 'small' ? '默认参考原视频码率压缩，保留分辨率和帧率。' : '默认使用较高画质重新编码，保留分辨率和帧率。'}</p>`;
  html += deviceField();
  html += `<details class="trim-advanced" id="trim-advanced" ${state.trimAdvancedOpen ? 'open' : ''}><summary><span><strong>高级设置</strong><small id="trim-settings-summary">${esc(trimSummary())}</small></span>${icon('down', 14)}</summary><div class="trim-advanced-body">`;
  html += `<div class="section-heading"><h3>编码参数</h3><button class="text-button" id="reset-trim-settings">恢复推荐值 ${icon('refresh', 12)}</button></div>`;
  html += selectField('codec', '视频编码', [['h264', 'H.264 · 通用'], ['hevc', 'H.265 / HEVC'], ['av1', 'AV1']]);
  html += selectField('rateControl', '码率控制', [['bitrate', '指定目标码率 · 控制体积'], ['quality', '按画质分配码率 · 体积随内容变化']]);
  if (o.rateControl === 'bitrate') {
    const source = sourceVideoRate(file);
    html += `<div class="field"><label for="option-videoBitrateMbps">视频目标码率</label><div class="input-with-unit"><input id="option-videoBitrateMbps" type="number" min="0.01" max="300" step="0.001" value="${esc(o.videoBitrateMbps)}" data-option="videoBitrateMbps"><span>Mbps</span></div><p class="field-hint">${source ? `原视频${source.estimated ? '估算' : ''}码率约 ${(source.bits / 1e6).toFixed(2)} Mbps。` : '码率越低，文件通常越小，也更容易损失细节。'}实际码率会随画面浮动。</p></div>`;
  } else {
    html += `<div class="field"><label for="quality-range">质量等级 · 数值越小，保留细节越多</label><div class="range-input-row"><input id="quality-range" type="range" min="14" max="35" step="1" value="${o.qualityValue}" data-option="qualityValue"><output>${o.qualityValue}</output></div><p class="field-hint">编码器根据画面复杂度分配码率，不限定输出大小。</p></div>`;
  }
  html += selectField('audioBitrateKbps', '音频码率 · AAC', [['96', '96 kbps · 小体积'], ['128', '128 kbps · 日常使用'], ['192', '192 kbps · 高音质'], ['256', '256 kbps'], ['320', '320 kbps']]);
  html += selectField('container', '输出封装', [['mp4', 'MP4'], ['mkv', 'MKV']]);
  html += '</div></details><p class="field-hint preset-limit">重新编码会有画质损失；提高码率无法增加原片已有的细节。</p><p id="trim-size-estimate" class="trim-size-estimate" hidden></p>';
  return html;
}
function dimensions() { return `<div class="two-fields">${selectField('height', '输出高度', [['original', '保持原尺寸'], ['2160', '2160p · 4K'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']])}${selectField('fps', '帧率', [['original', '保持原帧率'], ['60', '60 fps'], ['30', '30 fps'], ['24', '24 fps']])}</div>`; }
function renderCover() {
  const file = current(), cover = state.cover;
  $('#cover-comparison').innerHTML = `<div class="cover-compare-heading"><h3>封面对照</h3><span>原画面与声音保持不变</span></div><div class="cover-grid">
    <figure class="cover-card"><figcaption><span>当前封面</span><small>${file?.cover ? '内嵌图片' : '未设置'}</small></figcaption><div class="cover-art">${file?.cover ? `<img src="/api/media/${file.id}/cover" alt="视频当前内嵌封面">` : `<div class="cover-placeholder">${icon('image', 32)}<strong>${file ? '没有内嵌封面' : '先添加视频素材'}</strong><span>${file ? '播放器可能使用视频画面作为缩略图' : '支持 MP4、M4V 和 MKV'}</span></div>`}</div></figure>
    <figure class="cover-card proposed"><figcaption><span>新封面</span><small>${cover ? '等待导出' : 'JPG / PNG'}</small></figcaption><button class="cover-art cover-picker" data-pick-cover aria-label="${cover ? '更换封面图片' : '选择封面图片'}">${cover ? `<img src="/api/covers/${cover.id}" alt="新封面预览"><span class="cover-hover">${icon('image', 14)} 更换图片</span>` : `<span class="cover-placeholder">${icon('plus', 30)}<strong>选择一张图片</strong><span>点击浏览本地图片</span></span>`}</button></figure></div><p class="cover-preview-note">${icon('info', 14)}此处展示文件中的内嵌封面。部分播放器和资源管理器会自行截取视频画面，可能不显示这张图片。</p>`;
}
function renderOptions() {
  const op = state.operation, o = state.options, file = current(); let html = '';
  $('.editing-panel').classList.toggle('cover-editing', op === 'cover');
  $('#cover-comparison').hidden = op !== 'cover';
  if (op === 'trim') {
    html = trimOptions();
  } else if (op === 'transcode' || op === 'resize') {
    html = selectField('codec', '视频编码', [['h264', 'H.264 · 兼容性好'], ['hevc', 'H.265 / HEVC · 高效压缩'], ['av1', 'AV1 · 高效压缩']]);
    html += selectField('container', '输出封装', [['mp4', 'MP4 · 通用视频'], ['mkv', 'MKV · 灵活容器']]) + qualityFields();
    html += '<div class="option-divider"></div>' + dimensions();
    if (op === 'resize') html += '<div class="option-divider"></div>' + selectField('rotate', '画面旋转', [['0', '保持原方向'], ['90', '顺时针 90°'], ['180', '旋转 180°'], ['270', '逆时针 90°']]) + `<label class="check-field"><input type="checkbox" data-option="flip" ${o.flip ? 'checked' : ''}> 水平镜像</label>`;
    html += '<p class="field-hint">高度按画面比例缩放；音频输出为 AAC。</p>';
  } else if (op === 'concat') {
    html = segments('mode', '拼接方式', [['normalize', '兼容拼接'], ['copy', '快速拼接']]);
    html += `<div class="mode-description">${icon('info', 13)}<span>${o.mode === 'normalize' ? '统一画面尺寸和编码；缺少音轨的片段自动补静音。使用素材列表中的顺序。' : '素材的编码、分辨率、帧率及音轨结构必须一致。输出 MKV。'}</span></div><div class="option-divider"></div>`;
    if (o.mode === 'normalize') html += `<div class="two-fields">${selectField('height', '输出高度', [['480', '480p'], ['720', '720p'], ['1080', '1080p'], ['2160', '2160p']])}${selectField('fps', '统一帧率', [['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps']])}</div><div class="option-divider"></div>` + qualityFields('h264');
    html += `<p class="field-hint">已添加 ${state.files.length} 个素材。使用列表右侧箭头调整顺序。</p>`;
  } else if (op === 'audio') {
    html = selectField('action', '音频操作', [['extract', '提取 / 转换音频'], ['mute', '移除视频中的音频'], ['volume', '调整音量'], ['replace', '替换视频音轨']]);
    if (['extract', 'volume'].includes(o.action)) html += selectField('track', '源音轨', file?.audio.length ? file.audio.map((a, i) => [String(i), `音轨 ${i + 1} · ${a.codec.toUpperCase()} · ${a.channels} 声道${a.language ? ` · ${a.language}` : ''}`]) : [['0', '等待音频素材']]);
    if (o.action === 'extract') html += selectField('format', '音频格式', [['mp3', 'MP3 · 192 kbps'], ['m4a', 'AAC / M4A · 192 kbps'], ['wav', 'WAV · 无压缩'], ['flac', 'FLAC · 无损编码'], ['copy', 'MKA · 复制原音频流']]);
    if (o.action === 'volume') html += `<div class="field"><label for="volume-range">音量倍率</label><div class="range-input-row"><input id="volume-range" type="range" min="0" max="400" step="5" value="${o.volume}" data-option="volume"><output>${o.volume}%</output></div><p class="field-hint">100% 为原音量。大幅增益可能产生失真。</p></div>`;
    if (o.action === 'replace') {
      const candidates = state.files.filter(f => f.id !== state.activeId && f.audio.length);
      if (!candidates.some(f => f.id === o.audioFileId)) o.audioFileId = candidates[0]?.id || '';
      html += selectField('audioFileId', '新音频素材', candidates.length ? candidates.map(f => [f.id, f.name]) : [['', '请点击“添加素材”添加音频']]);
      html += '<p class="field-hint">先选择原视频，再添加音频。新音轨从头开始；超出部分裁掉，不足部分补静音。</p>';
    }
    if (o.action !== 'extract') html += '<p class="field-hint">视频流保持原编码，输出为 MKV。</p>';
  } else if (op === 'gif') {
    html = selectField('width', '动图宽度', [['320', '320 px · 小巧'], ['480', '480 px · 推荐'], ['640', '640 px'], ['960', '960 px']]) + selectField('fps', '流畅度', [['8', '8 fps · 小体积'], ['12', '12 fps · 推荐'], ['20', '20 fps · 更流畅'], ['25', '25 fps']]);
    html += `<div class="mode-description">${icon('info', 13)}<span>在左侧时间轴选择片段。建议 3～10 秒，最长 60 秒。GIF 不包含声音。</span></div>`;
  } else if (op === 'snapshot') {
    html = selectField('format', '图片格式', [['png', 'PNG · 无损图像'], ['jpg', 'JPG · 更小体积']]) + `<div class="field"><label for="option-time">截图位置（秒）</label><input id="option-time" type="number" min="0" step="0.01" max="${Math.max(0, (file?.duration || 0) - .04)}" value="${Number(o.time)}" data-option="time"><button class="text-button" id="snapshot-current">使用当前播放位置 ${icon('arrow', 12)}</button></div><p class="field-hint">导出原始画面尺寸，不经过浏览器截图。</p>`;
  } else if (op === 'cover') {
    renderCover();
    html = `<div class="cover-method"><span>${icon('shield', 18)}</span><div><strong>仅替换内嵌封面</strong><p>不重编码、不插入画面，保留音视频轨道、字幕和章节。</p></div></div><div class="field"><label>封面图片</label><button class="button cover-browse" data-pick-cover>${icon('folder')} ${state.cover ? '更换图片' : '选择 JPG / PNG 图片'}</button>${state.cover ? `<div class="cover-file"><strong title="${esc(state.cover.path)}">${esc(state.cover.name)}</strong><small>${state.cover.width} × ${state.cover.height} · ${size(state.cover.size)}</small><button class="text-button" id="remove-cover">移除图片</button></div>` : '<p class="field-hint">保持图片原有比例，不裁切。单张图片不超过 32 MB。</p>'}</div><div class="original-format"><span>输出格式</span><strong>${file ? esc((file.name.split('.').pop() || '').toUpperCase()) : '沿用原视频'}</strong><small>支持 MP4、M4V、MKV。仅重新封装文件，无需选择 CPU / GPU。</small></div><p class="field-hint">先生成新文件；完成后可以使用“替换原素材”。</p>`;
  } else {
    html = selectField('container', '输出容器', [['mkv', 'MKV · 兼容更多编码'], ['mp4', 'MP4'], ['mov', 'MOV'], ['webm', 'WebM']]);
    html += `<div class="mode-description">${icon('info', 13)}<span>封装转换不会改变编码。AV1 转 H.264 请使用“转码与压缩”。</span></div><div class="option-divider"></div><p class="field-hint">保留所有音轨；字幕、附件和数据轨道不导出。WebM 通常需要 VP8 / VP9 / AV1 和 Opus / Vorbis。</p>`;
  }
  $('#operation-options').innerHTML = html;
  const advanced = $('#trim-advanced');
  advanced?.addEventListener('toggle', () => { if (advanced.isConnected) state.trimAdvancedOpen = advanced.open; });
  $('#timeline-section').hidden = !['trim', 'gif'].includes(op);
  $('#media-details').hidden = ['trim', 'gif'].includes(op) || !file;
  $('#seek-range').hidden = ['trim', 'gif'].includes(op) || !file;
  $('#set-start').hidden = $('#set-end').hidden = !['trim', 'gif'].includes(op);
  if (file) $('#media-details').innerHTML = [['编码', file.video?.codec.toUpperCase() || file.audio[0]?.codec.toUpperCase()], ['分辨率', file.video ? `${file.video.width} × ${file.video.height}` : '纯音频'], ['帧率', file.video ? `${file.video.fps.toFixed(2)} fps` : '—'], ['时长', time(file.duration, false)], ['文件大小', size(file.size)], ['音频', file.audio.length ? `${file.audio.length} 条音轨` : '无音频']].map(([key, value]) => `<div class="media-detail"><span>${key}</span><strong>${value}</strong></div>`).join('');
}
function optionChange(key, value) {
  state.options[key] = value;
  if (key === 'codec') state.options.encoder = compatibleDevice(state.options.encoder, value);
  if (key === 'action' || key === 'format' || key === 'container') $('#output-name').value = '';
  if (['codec', 'mode', 'action', 'quality', 'format', 'rateControl'].includes(key)) { renderOptions(); renderFiles(); }
  if ($('#trim-settings-summary')) $('#trim-settings-summary').textContent = trimSummary();
  schedulePlan();
}
$('#operation-options').addEventListener('click', event => {
  if (event.target.closest('#remove-cover')) { state.cover = null; renderOptions(); schedulePlan(); }
  const button = event.target.closest('[data-option-button]');
  if (button) optionChange(button.dataset.optionButton, button.dataset.value);
  if (event.target.closest('#reset-trim-settings')) {
    const device = state.options.encoder;
    state.options = { ...state.options, ...trimPresetDefaults(state.options.trimPreset, current()) };
    state.options.encoder = compatibleDevice(device, state.options.codec);
    renderOptions(); schedulePlan();
  }
  if (event.target.closest('#snapshot-current')) { state.options.time = Math.min(player().currentTime || 0, Math.max(0, (current()?.duration || 0) - .04)); renderOptions(); schedulePlan(); }
});
$('#operation-options').addEventListener('change', event => {
  if (event.target.dataset.trimPreset) { setTrimPreset(event.target.dataset.trimPreset); return; }
  if (event.target.dataset.option) optionChange(event.target.dataset.option, event.target.type === 'checkbox' ? event.target.checked : event.target.value);
});
$('#operation-options').addEventListener('input', event => {
  if (event.target.type === 'range') { event.target.nextElementSibling.textContent = `${event.target.value}${event.target.dataset.option === 'volume' ? '%' : ''}`; optionChange(event.target.dataset.option, event.target.value); }
  else if (event.target.type === 'number' && event.target.dataset.option) optionChange(event.target.dataset.option, event.target.value);
});

function renderFiles() {
  const file = current();
  $('#source-title').textContent = file ? file.name : '从一个视频开始';
  $('#source-title').title = file?.path || '';
  $('#source-detail').textContent = file ? `${file.video ? `${file.video.codec.toUpperCase()}  ·  ${file.video.width} × ${file.video.height}` : '音频素材'}  ·  ${time(file.duration, false)}  ·  ${size(file.size)}${file.imported ? '  ·  本地临时副本' : ''}` : '直接读取本地文件，保留原始素材';
  $('#file-list').hidden = !state.files.length || (state.files.length === 1 && state.operation !== 'concat');
  $('#file-list').innerHTML = state.files.map((f, i) => `<div class="file-row ${f.id === state.activeId ? 'active' : ''}"><span class="file-order">${String(i + 1).padStart(2, '0')}</span><button class="file-select" data-select-file="${f.id}" title="${esc(f.path)}">${f.video ? `<img src="/api/media/${f.id}/thumb?time=0" alt="">` : icon('audio')}<div style="min-width:0"><span class="file-name">${esc(f.name)}</span><small>${time(f.duration, false)} · ${f.video?.codec.toUpperCase() || 'AUDIO'}</small></div></button><div class="file-row-actions">${state.operation === 'concat' ? `<button class="icon-button" data-move="${i}" data-direction="-1" aria-label="上移 ${esc(f.name)}" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="icon-button" data-move="${i}" data-direction="1" aria-label="下移 ${esc(f.name)}" ${i === state.files.length - 1 ? 'disabled' : ''}>${icon('down')}</button>` : ''}<button class="icon-button" data-remove="${f.id}" aria-label="移除 ${esc(f.name)}">${icon('close')}</button></div></div>`).join('');
}
function selectFile(id) {
  $('#video').pause(); $('#audio').pause();
  state.activeId = id; const file = current();
  if (state.operation === 'trim') {
    state.trimProfiles = {};
    const device = state.options.encoder;
    state.options = { ...state.options, ...trimPresetDefaults(state.options.trimPreset, file) };
    state.options.encoder = compatibleDevice(device, state.options.codec);
  }
  state.start = 0; state.end = state.operation === 'gif' ? Math.min(file?.duration || 0, 10) : file?.duration || 0;
  state.options.time = 0; state.options.track = '0'; state.previewFailed = false;
  $('#output-name').value = ''; $('#preview-error').hidden = true; $('#fallback-image').hidden = true;
  $('#video').removeAttribute('src'); $('#audio').removeAttribute('src');
  $('#video').hidden = !file?.video; $('#audio-stage').hidden = !file || !!file.video; $('#empty-stage').hidden = !!file;
  if (file) {
    if (file.video) { $('#video').poster = `/api/media/${file.id}/thumb?time=0`; $('#video').src = `/api/media/${file.id}`; }
    else $('#audio').src = `/api/media/${file.id}`;
  }
  $('#play-button').disabled = $('#set-start').disabled = $('#set-end').disabled = !file;
  $('#fullscreen').disabled = !file?.video;
  $('#preview-meta').textContent = file?.video ? `${file.video.width} × ${file.video.height} · ${file.video.fps.toFixed(2)} fps` : file ? '音频预览' : '等待添加素材';
  $('#total-time').textContent = time(file?.duration); $('#current-time').textContent = time(0);
  $('#seek-range').max = file?.duration || 0; $('#seek-range').value = 0;
  $('#filmstrip').innerHTML = file?.video ? Array.from({ length: 7 }, (_, i) => `<img src="/api/media/${file.id}/thumb?time=${(file.duration * i / 7).toFixed(2)}" alt="" loading="lazy">`).join('') : '';
  renderFiles(); renderOptions(); renderRange(); schedulePlan();
}
async function addPaths(paths) {
  toast('正在读取素材信息…');
  const result = await api('/api/files', { paths });
  for (const file of result.files) if (!state.files.some(f => f.id === file.id)) state.files.push(file);
  if (!current() && result.files.length) selectFile(result.files[0].id);
  else if (result.files.length && state.operation !== 'concat' && !(state.operation === 'audio' && state.options.action === 'replace')) selectFile(result.files[0].id);
  else { renderFiles(); renderOptions(); schedulePlan(); }
  if (result.errors.length) toast(result.errors.map(e => `${e.path.split(/[\\/]/).pop()}：${e.error}`).join('；'), true);
  else toast(`已添加 ${result.files.length} 个素材`);
}
$('#file-list').addEventListener('click', event => {
  const select = event.target.closest('[data-select-file]'), move = event.target.closest('[data-move]'), remove = event.target.closest('[data-remove]');
  if (select) selectFile(select.dataset.selectFile);
  if (move) { const i = Number(move.dataset.move), j = i + Number(move.dataset.direction); [state.files[i], state.files[j]] = [state.files[j], state.files[i]]; renderFiles(); schedulePlan(); }
  if (remove) { state.files = state.files.filter(f => f.id !== remove.dataset.remove); if (state.activeId === remove.dataset.remove) selectFile(state.files[0]?.id || ''); else { renderFiles(); renderOptions(); schedulePlan(); } }
});

function renderRange(preserveInputs = false) {
  const duration = current()?.duration || 0, left = duration ? state.start / duration * 100 : 0, right = duration ? state.end / duration * 100 : 100;
  $('#range-selection').style.left = `${left}%`; $('#range-selection').style.right = `${100 - right}%`;
  $('#shade-left').style.width = `${left}%`; $('#shade-right').style.width = `${100 - right}%`;
  $('#handle-start').style.left = `${left}%`; $('#handle-end').style.left = `${right}%`;
  for (const [id, value] of [['start', state.start], ['end', state.end]]) { const el = $(`#handle-${id}`); el.disabled = !duration; el.setAttribute('aria-valuemax', duration); el.setAttribute('aria-valuenow', value); el.setAttribute('aria-valuetext', time(value)); }
  if (!preserveInputs) { $('#start-time').value = time(state.start); $('#end-time').value = time(state.end); state.rangeInputError = ''; }
  $('#start-time').disabled = $('#end-time').disabled = $('#quick-apply').disabled = !duration;
  $('#timeline-ruler').innerHTML = Array.from({ length: 6 }, (_, i) => `<span>${time(duration * i / 5, false)}</span>`).join('');
  $('#selection-duration').textContent = duration ? `已选择 ${time(state.end - state.start)} · ${((state.end - state.start) / duration * 100).toFixed(0)}%` : '添加素材后选择片段';
}
let frameTimer;
function seek(value) {
  const file = current(); if (!file) return;
  const target = Math.max(0, Math.min(value, Math.max(0, file.duration - .001)));
  if (!state.previewFailed) player().currentTime = target;
  else { clearTimeout(frameTimer); frameTimer = setTimeout(() => { $('#fallback-image').src = `/api/media/${file.id}/thumb?time=${target.toFixed(2)}`; }, 130); }
  $('#current-time').textContent = time(target); $('#playhead').style.left = `${target / (file.duration || 1) * 100}%`; $('#seek-range').value = target;
}
for (const side of ['start', 'end']) {
  const handle = $(`#handle-${side}`);
  handle.addEventListener('pointerdown', event => {
    if (!current()) return; event.preventDefault(); event.stopPropagation(); handle.setPointerCapture(event.pointerId);
    const update = e => { const rect = $('#timeline').getBoundingClientRect(), t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * current().duration; state[side] = side === 'start' ? Math.min(t, state.end - .04) : Math.max(t, state.start + .04); renderRange(); seek(state[side]); };
    const finish = () => { handle.removeEventListener('pointermove', update); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); schedulePlan(); };
    handle.addEventListener('pointermove', update); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('keydown', event => {
    if (!current() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); const step = (event.shiftKey ? 1 : .1) * (event.key === 'ArrowLeft' ? -1 : 1);
    state[side] = side === 'start' ? Math.max(0, Math.min(state.start + step, state.end - .04)) : Math.min(current().duration, Math.max(state.end + step, state.start + .04)); renderRange(); seek(state[side]); schedulePlan();
  });
  const applyInput = normalize => {
    try {
      const value = parseTime($(`#${side}-time`).value);
      if (value < 0 || value > (current()?.duration || 0) || (side === 'start' ? state.end - value < .04 : value - state.start < .04)) throw new Error('请输入有效范围内的时间，所选片段至少 0.04 秒');
      state[side] = value; state.rangeInputError = ''; seek(value); renderRange(!normalize);
    } catch (err) { state.rangeInputError = err.message; if (normalize) toast(err.message, true); }
    schedulePlan();
  };
  $(`#${side}-time`).addEventListener('input', () => applyInput(false));
  $(`#${side}-time`).addEventListener('change', () => applyInput(true));
}
$('#timeline').addEventListener('pointerdown', event => { if (event.target.closest('.trim-handle') || !current()) return; const rect = $('#timeline').getBoundingClientRect(); seek((event.clientX - rect.left) / rect.width * current().duration); });
$('#seek-range').addEventListener('input', event => seek(Number(event.target.value)));
$('#reset-range').onclick = () => { state.start = 0; state.end = current()?.duration || 0; renderRange(); schedulePlan(); };
$('#quick-apply').onclick = () => {
  const duration = current()?.duration || 0, seconds = Number($('#quick-seconds').value);
  if (!(seconds > 0 && seconds < duration)) { toast('秒数需大于 0 且小于视频时长', true); return; }
  const mode = $('#quick-mode').value;
  state.start = mode === 'drop-start' ? seconds : mode === 'keep-end' ? duration - seconds : 0;
  state.end = mode === 'drop-end' ? duration - seconds : mode === 'keep-start' ? seconds : duration;
  renderRange(); seek(state.start); schedulePlan();
};
function setBoundary(side) {
  if (!current()) return; const value = Number($('#seek-range').value);
  if (side === 'start' ? value >= state.end : value <= state.start) { toast('起点需要早于终点', true); return; }
  state[side] = value; renderRange(); schedulePlan();
}
$('#set-start').onclick = () => setBoundary('start'); $('#set-end').onclick = () => setBoundary('end');
$('#play-button').onclick = safeAction(async () => { if (player().paused) { if (['trim', 'gif'].includes(state.operation) && (player().currentTime < state.start || player().currentTime >= state.end)) seek(state.start); await player().play(); } else player().pause(); });
$('#fullscreen').onclick = safeAction(async () => { if ($('#video').requestFullscreen) await $('#video').requestFullscreen(); });
for (const media of [$('#video'), $('#audio')]) {
  media.addEventListener('timeupdate', () => {
    if (media !== player()) return;
    const duration = current()?.duration || 1; $('#current-time').textContent = time(media.currentTime); $('#playhead').style.left = `${media.currentTime / duration * 100}%`; $('#seek-range').value = media.currentTime;
    if (['trim', 'gif'].includes(state.operation) && !media.paused && media.currentTime >= state.end && state.end > state.start) media.pause();
  });
  media.addEventListener('play', () => { $('#play-button').innerHTML = icon('pause'); });
  media.addEventListener('pause', () => { $('#play-button').innerHTML = icon('play'); });
  media.addEventListener('error', () => {
    if (!current() || !media.getAttribute('src')) return;
    state.previewFailed = true; $('#play-button').disabled = true;
    if (current().video) { $('#preview-error').hidden = false; $('#fallback-image').hidden = false; $('#fallback-image').src = `/api/media/${current().id}/thumb?time=0`; $('#video').hidden = true; $('#proxy-button').disabled = false; $('#proxy-status').textContent = '会在本机生成低清预览副本'; }
    else toast('浏览器不支持此音频编码，仍可正常导出为 MP3 / M4A 后播放。', true);
  });
}
let proxyTimer;
$('#proxy-button').onclick = safeAction(async () => {
  const id = state.activeId; $('#proxy-button').disabled = true; $('#proxy-status').textContent = '正在生成完整低清预览，大视频可能需要一些时间…';
  const poll = async () => {
    try {
      const result = await api('/api/preview-media', { id });
      if (id !== state.activeId) return;
      if (result.error) throw new Error(result.error);
      if (result.ready) { $('#video').src = `/api/media/${id}/preview`; $('#video').hidden = false; $('#fallback-image').hidden = true; $('#preview-error').hidden = true; $('#play-button').disabled = false; state.previewFailed = false; toast('兼容预览已就绪，导出仍使用原素材'); }
      else proxyTimer = setTimeout(poll, 1600);
    } catch (err) { $('#proxy-status').textContent = err.message; $('#proxy-button').disabled = false; }
  };
  clearTimeout(proxyTimer); await poll();
});

function spec() {
  const file = current();
  let fileIds = state.operation === 'concat' ? state.files.map(f => f.id) : file ? [file.id] : [];
  if (state.operation === 'audio' && state.options.action === 'replace' && state.options.audioFileId) fileIds.push(state.options.audioFileId);
  return { operation: state.operation, fileIds, options: { ...state.options, ...(state.operation === 'cover' ? { coverId: state.cover?.id } : {}), start: state.start, end: state.end }, outputDir: $('#output-dir').value, outputName: $('#output-name').value.trim() };
}
let planTimer, planSequence = 0;
function schedulePlan() { clearTimeout(planTimer); state.plan = null; $('#export-button').disabled = true; if ($('#trim-size-estimate')) $('#trim-size-estimate').hidden = true; planSequence++; planTimer = setTimeout(updatePlan, 240); }
async function updatePlan() {
  const sequence = planSequence;
  if (!current()) { $('#command-text').textContent = '添加素材后，这里会显示对应的 FFmpeg 命令。'; $('#plan-warnings').innerHTML = ''; $('#export-duration').textContent = '—'; return; }
  try {
    if (state.rangeInputError && ['trim', 'gif'].includes(state.operation)) throw new Error(state.rangeInputError);
    const plan = await api('/api/preview-command', spec()); if (sequence !== planSequence) return;
    state.plan = plan; state.commandError = '';
    $('#command-text').textContent = plan.command;
    $('#command-extras').innerHTML = plan.extraFiles.map(extra => `<p class="command-extras">拼接清单（手动执行前，需将下面内容保存为 ${esc(extra.path)}）</p><pre>${esc(extra.content)}</pre>`).join('') + (plan.preCommands || []).map(command => `<p class="command-extras">保留非封面图片附件：主命令之前先执行此命令。工具会自动执行并清理临时文件。</p><pre>${esc(command)}</pre>`).join('');
    $('#output-extension').textContent = `.${plan.extension}`;
    $('#output-name').placeholder = (plan.outputPath.split(/[\\/]/).pop() || '').replace(new RegExp(`\\.${plan.extension}$`), '');
    $('#export-duration').textContent = state.operation === 'snapshot' ? '1 帧' : time(plan.duration);
    $('#encoder-description').textContent = plan.encoder;
    const warnings = plan.warnings.filter(w => !(state.operation === 'trim' && state.options.trimPreset === 'original' && w.startsWith('保持原编码按')));
    $('#plan-warnings').innerHTML = warnings.map(w => `<div class="plan-warning">${esc(w)}</div>`).join('');
    const estimate = $('#trim-size-estimate');
    if (estimate) { estimate.hidden = !plan.estimatedSize; estimate.textContent = plan.estimatedSize ? `预计约 ${size(plan.estimatedSize)} · 按目标码率估算，实际可能浮动` : ''; }
    $('#export-button').disabled = !state.system.ready || state.busy;
  } catch (err) { if (sequence !== planSequence) return; state.plan = null; state.commandError = err.message; $('#command-text').textContent = err.message; $('#command-extras').innerHTML = ''; $('#plan-warnings').innerHTML = `<div class="plan-warning error">${esc(err.message)}</div>`; $('#export-button').disabled = true; }
}
$('#output-name').addEventListener('input', schedulePlan); $('#output-dir').addEventListener('input', schedulePlan);
$('#copy-command').onclick = safeAction(async () => { if (!state.plan) throw new Error('请先添加素材并设置有效参数'); await navigator.clipboard.writeText(state.plan.command); toast('命令已复制'); });
$('#export-button').onclick = safeAction(async () => {
  if (!state.plan || state.busy) return;
  state.busy = true; $('#export-button').disabled = true;
  try { await api('/api/jobs', spec()); await refreshJobs(); $('#queue-dialog').showModal(); toast('已加入处理队列'); }
  finally { state.busy = false; schedulePlan(); }
});

function openModal(html, type) { state.modalType = type; $('#modal-content').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); $('[data-close-modal]')?.addEventListener('click', closeModal); }
function closeModal() { $('#modal').close(); state.modalType = ''; }
const modalHeader = (title, eyebrow = 'FRAME · LOCAL WORKSPACE') => `<div class="modal-header"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div><button class="icon-button" data-close-modal aria-label="关闭">${icon('close')}</button></div>`;
function modalError(message) { let el = $('#modal-error'); if (!el) { el = document.createElement('div'); el.id = 'modal-error'; el.className = 'modal-error'; $('#modal-content').append(el); } el.textContent = message; }
async function openBrowser(mode = 'files', initial) {
  const selected = new Set(); let listing;
  const load = async p => {
    try { listing = await api(`/api/browse?kind=${mode === 'cover' ? 'cover' : 'media'}${p ? `&path=${encodeURIComponent(p)}` : ''}`); draw(); }
    catch (err) { if (state.modalType !== 'browser') openModal(modalHeader('浏览本地文件') + '<p class="modal-subtitle">无法打开初始目录。可以直接输入其他路径。</p><div class="browser-path"><input id="browser-path-input" aria-label="目录路径"><button class="button" id="browser-go">前往</button></div>', 'browser'); modalError(err.message); $('#browser-go').onclick = () => load($('#browser-path-input').value); }
  };
  const draw = () => {
    openModal(modalHeader(mode === 'directory' ? '选择输出目录' : mode === 'cover' ? '选择封面图片' : '浏览本地素材') + `<p class="modal-subtitle">${mode === 'directory' ? '处理后的文件会保存在这里。' : mode === 'cover' ? '选择一张 JPG 或 PNG 图片，直接读取原文件。最多 32 MB。' : '直接读取磁盘文件，无需复制或上传。单击文件可多选。'}</p><div class="browser-shortcuts">${listing.shortcuts.map(s => `<button data-shortcut="${esc(s.path)}">${esc(s.name)}</button>`).join('')}</div><div class="browser-path"><button class="icon-button" id="browser-up" aria-label="上级目录">${icon('arrowLeft')}</button><input id="browser-path-input" value="${esc(listing.path)}" aria-label="目录路径"><button class="button" id="browser-go">前往</button></div><div class="browser-entries">${listing.entries.filter(e => mode !== 'directory' || e.directory).map(e => `<button class="browser-entry ${selected.has(e.path) ? 'selected' : ''}" data-entry="${esc(e.path)}" data-directory="${e.directory}">${icon(e.directory ? 'folder' : mode === 'cover' ? 'image' : 'film')}<span class="entry-name">${esc(e.name)}</span><span>${e.directory ? icon('chevron', 13) : selected.has(e.path) ? icon('check', 15) : ''}</span></button>`).join('') || '<div class="browser-empty">这个目录里没有可显示的文件。<br>试试快捷目录或直接输入路径。</div>'}</div><div class="browser-footer"><span id="browser-selection">${mode === 'directory' ? '将使用当前目录' : `已选择 ${selected.size} 个文件`}</span><div class="modal-actions"><button class="button" id="browser-cancel">取消</button><button class="button primary" id="browser-confirm" ${mode !== 'directory' && !selected.size ? 'disabled' : ''}>${mode === 'directory' ? '使用此目录' : mode === 'cover' ? '使用这张封面' : '添加所选素材'}</button></div></div>${mode !== 'directory' ? '<div class="import-note">也可以<button class="text-button" id="browser-upload">使用系统文件选择器</button>，这会将文件复制到项目的本地临时目录。</div>' : ''}`, 'browser');
    $$('[data-shortcut]').forEach(el => { el.onclick = () => load(el.dataset.shortcut); });
    $('#browser-up').onclick = () => load(listing.parent);
    $('#browser-go').onclick = () => load($('#browser-path-input').value);
    $('#browser-path-input').onkeydown = e => { if (e.key === 'Enter') load(e.target.value); };
    $$('[data-entry]').forEach(el => { el.onclick = () => { if (el.dataset.directory === 'true') load(el.dataset.entry); else { const wasSelected = selected.has(el.dataset.entry); if (mode === 'cover') selected.clear(); wasSelected ? selected.delete(el.dataset.entry) : selected.add(el.dataset.entry); draw(); } }; });
    $('#browser-cancel').onclick = closeModal;
    $('#browser-confirm').onclick = safeAction(async () => { if (mode === 'directory') { $('#output-dir').value = listing.path; schedulePlan(); closeModal(); } else if (mode === 'cover') { const result = await api('/api/covers', { path: [...selected][0] }); state.cover = result.file; closeModal(); renderOptions(); schedulePlan(); } else { closeModal(); await addPaths([...selected]); } });
    if ($('#browser-upload')) $('#browser-upload').onclick = () => { closeModal(); $(mode === 'cover' ? '#cover-upload-input' : '#upload-input').click(); };
  };
  await load(initial || (mode === 'directory' ? $('#output-dir').value : current()?.path.replace(/[^\\/]+$/, '')));
}
document.addEventListener('click', safeAction(async event => { if (event.target.closest('[data-pick-cover]')) await openBrowser('cover', state.cover?.path.replace(/[^\\/]+$/, '')); }));
$('#cover-upload-input').onchange = safeAction(async event => {
  const blob = event.target.files[0]; event.target.value = '';
  if (!blob) return;
  if (blob.size > 32 * 1024 * 1024) throw new Error('封面图片不能超过 32 MB');
  toast('正在读取封面图片…');
  const response = await fetch(`/api/import?kind=cover&name=${encodeURIComponent(blob.name)}`, { method: 'POST', headers: { 'X-Frame-Token': state.token }, body: blob });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  state.cover = result.file; renderOptions(); schedulePlan(); toast('封面已选择，开始处理后写入新视频。');
});
for (const id of ['browse-button', 'stage-browse']) $(`#${id}`).onclick = safeAction(() => openBrowser());
$('#choose-output').onclick = safeAction(() => openBrowser('directory'));
$('#path-button').onclick = () => {
  openModal(modalHeader('粘贴本地路径') + '<p class="modal-subtitle">输入视频或音频文件的完整路径，每行一个。Windows 的“复制文件地址”可以直接粘贴。</p><textarea id="path-input" class="path-entry" placeholder="D:\\Videos\\my-video.mp4" spellcheck="false" aria-label="本地素材路径"></textarea><div class="modal-actions"><button id="add-paths" class="button primary">读取素材</button></div>', 'paths');
  $('#add-paths').onclick = safeAction(async () => { const paths = $('#path-input').value.split(/\r?\n/).map(p => p.trim()).filter(Boolean); if (!paths.length) throw new Error('请先输入文件路径'); closeModal(); await addPaths(paths); }); $('#path-input').focus();
};
async function upload(files) {
  for (const blob of files) {
    toast(`正在复制 ${blob.name} 到本地临时目录…`);
    const response = await fetch(`/api/import?name=${encodeURIComponent(blob.name)}`, { method: 'POST', headers: { 'X-Frame-Token': state.token }, body: blob });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    state.files.push(result.file); if (!current()) selectFile(result.file.id);
  }
  renderFiles(); renderOptions(); schedulePlan(); toast('素材已复制到本地；需要替换原文件时，请通过本地路径添加素材。');
}
$('#upload-input').onchange = safeAction(async event => { await upload([...event.target.files]); event.target.value = ''; });
$('#drop-zone').addEventListener('dragover', event => { event.preventDefault(); $('#drop-zone').classList.add('drag-over'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('drag-over'));
$('#drop-zone').addEventListener('drop', safeAction(async event => { event.preventDefault(); $('#drop-zone').classList.remove('drag-over'); if (event.dataTransfer.files.length) await upload([...event.dataTransfer.files]); }));

function systemView() {
  const sys = state.system;
  $('#engine-status').innerHTML = `<span class="status-dot ${!sys.ready && !sys.checking ? 'error' : ''}"></span><span>${sys.checking ? '检测编码器中…' : sys.ready ? `FFmpeg ${sys.version.match(/version\s+(\S+)/)?.[1].split('-')[0] || ''} 已连接` : 'FFmpeg 未连接'}</span>${icon('chevron', 13)}`;
  $('#system-alert').hidden = sys.ready || sys.checking;
  $('#system-alert').textContent = sys.error || '';
  if (state.modalType === 'settings') updateHardware();
}
function updateHardware() {
  const list = $('#hardware-list'); if (!list) return;
  list.innerHTML = state.system.encoders.map(e => `<div class="hardware-item ${e.available ? '' : 'unavailable'}" title="${esc(e.reason || e.id)}"><span>${esc(e.label)}</span><span>${e.available ? '可用' : '不可用'}</span></div>`).join('') || '<p class="muted">正在检测本机编码器…</p>';
  $('#hardware-checking').textContent = state.system.checking ? '正在逐项试运行显卡编码器…' : '显卡编码器经过实际编码试运行；不可用项不会出现在导出选项中。';
}
function openSettings() {
  openModal(modalHeader('工作台设置') + `<p class="modal-subtitle">自动寻找本机 FFmpeg；也可以指定自己的版本。</p><div class="settings-version">${esc(state.system.version || state.system.error || '正在检测…')}<br>${esc(state.system.cpu || '')}</div><label class="modal-field">FFmpeg 可执行文件路径<input id="setting-ffmpeg" value="${esc(state.settings.ffmpegPath)}" placeholder="留空自动检测" spellcheck="false"></label><label class="modal-field">FFprobe 可执行文件路径<input id="setting-ffprobe" value="${esc(state.settings.ffprobePath)}" placeholder="留空自动检测" spellcheck="false"></label><label class="modal-field">默认输出目录<input id="setting-output" value="${esc(state.settings.outputDir)}" spellcheck="false"></label><div class="section-heading"><h3>本机编码能力</h3><button class="text-button" id="redetect">${icon('refresh', 12)} 重新检测</button></div><div class="hardware-list" id="hardware-list"></div><p class="field-hint" id="hardware-checking"></p><div class="modal-actions"><button class="button primary" id="save-settings">保存设置</button></div>`, 'settings');
  updateHardware();
  $('#redetect').onclick = safeAction(async () => { state.system = await api('/api/redetect', {}); systemView(); toast('已开始重新检测'); });
  $('#save-settings').onclick = async () => {
    try { const result = await api('/api/settings', { ffmpegPath: $('#setting-ffmpeg').value.trim(), ffprobePath: $('#setting-ffprobe').value.trim(), outputDir: $('#setting-output').value.trim() }); state.settings = result.settings; state.system = result.system; $('#output-dir').value = state.settings.outputDir; closeModal(); systemView(); schedulePlan(); toast('设置已保存，正在检测 FFmpeg'); }
    catch (err) { modalError(err.message); }
  };
}
$('#settings-button').onclick = $('#engine-status').onclick = openSettings;
$('#help-button').onclick = () => openModal(modalHeader('几步，就能完成') + `<div class="help-section"><h3>01 · 添加本地素材</h3><p>“添加素材”浏览本机磁盘，或直接粘贴文件路径。素材在本机读取。拖入文件会复制一份到项目 .data/imports 目录。</p></div><div class="help-section"><h3>02 · 选择处理方式</h3><p>裁剪时拖动两端手柄，或输入精确时间；按空格播放，I / O 标记起止点。手柄支持方向键微调，Shift + 方向键每次调整 1 秒。</p><p>裁剪只需选择导出目标：保持原编码会原样复制音视频，按附近关键帧定位；体积优先和画质优先会精确裁剪并重新编码。展开“高级设置”可调整编码和码率，处理设备默认自动优先选择可用显卡。拼接用素材列表的上下箭头调整顺序。</p></div><div class="help-section"><h3>03 · 导出与替换</h3><p>输出始终是新文件，同名自动另存。任务完成后可打开文件位置或预览；单个原视频可通过两次确认执行替换。替换时可以编辑新文件名。默认保留一份原片备份；选择“直接覆盖”时不保留备份，成功后无法通过本工具还原。任务队列的“清理空间”可清理重复文件、闲置缓存和选中的备份。</p><p>改变封装时，替换后的文件使用新扩展名。通过拖拽复制的素材不提供替换原文件功能。</p></div><div class="help-section"><h3>预览与编码</h3><p>浏览器无法播放的编码，可生成本地兼容预览；导出始终读取原文件。显卡用于编码，滤镜和解码可能仍使用 CPU。</p><p>当前重编码输出为 8-bit SDR 常规处理；HDR 素材会提示颜色变化风险。多音轨选择及字幕保留范围以各工具说明为准。</p><p>参数参考 <a href="https://ffmpeg.org/ffmpeg.html" target="_blank" rel="noopener noreferrer">FFmpeg 官方文档 ↗</a></p></div>`, 'help');

const statusLabels = { queued: '等待中', running: '处理中', completed: '已完成', failed: '处理失败', cancelled: '已取消', interrupted: '已中断' };
let jobSignature = '';
function backupMarkup(job) {
  const r = job.replacement;
  if (!r) return '';
  let content;
  if (r.restoredAt) content = `原素材已恢复。${r.processedCleanedAt ? '处理后的历史版本已清理。' : `处理后版本保存在：${esc(r.replacedBackup)}`}`;
  else if (r.mode === 'overwrite') content = `已直接覆盖，保存为：${esc(r.targetPath)}<br>本次未保留原片备份，无法通过本工具还原。`;
  else content = `原素材已替换：${esc(r.targetPath)}<br>${r.backupCleanedAt ? '原片备份已清理，无法再恢复。' : `原片备份：${esc(r.backupPath)}`}`;
  if (r.redundantOutputPath) content += '<br>尚有重复输出未移除，可通过“清理空间”处理。';
  return `<div class="job-backup">${content}</div>`;
}
function jobMarkup(job, openLogs) {
  const resultAvailable = job.status === 'completed' && !job.resultCleanedAt;
  let actions = '';
  if (resultAvailable) actions = `<a class="button" href="/api/jobs/${job.id}/media" target="_blank" rel="noopener">${icon('play')} 预览结果</a>
    ${job.nativeReveal ? `<a class="button" href="${esc(job.nativeReveal.url)}" data-job-action="native-reveal" data-job-id="${job.id}" data-native-ticket="${job.nativeReveal.id}">${icon('folder')} 打开位置</a>` : `<button class="button" data-job-action="reveal" data-job-id="${job.id}">${icon('folder')} 打开位置</button>`}
    <a class="button" href="/api/jobs/${job.id}/download" download title="通过浏览器另存一份副本，会额外占用磁盘空间">${icon('download')} 另存副本</a>
    ${job.replaceable ? `<button class="button replace-button" data-job-action="replace" data-job-id="${job.id}">${icon('replace')} 替换原素材</button>` : ''}
    ${job.restorable ? `<button class="button" data-job-action="restore" data-job-id="${job.id}">${icon('refresh')} 恢复原素材</button>` : ''}
    <span class="text-button muted">${size(job.size)}</span>`;
  else if (['running', 'queued'].includes(job.status)) actions = `<button class="button" data-job-action="cancel" data-job-id="${job.id}">${icon('close')} 取消任务</button>`;
  else if (job.resultCleanedAt) actions = `<span class="text-button muted">${esc(job.resultRemovalReason || '该处理版本已清理，任务记录保留。')}</span>`;
  return `<article class="job-card">
    <div class="job-title-row"><strong>${esc(job.title)} <span class="muted">· ${new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></strong><span class="job-status ${job.status}">${statusLabels[job.status] || job.status}</span></div>
    <div class="job-path">${esc(job.outputPath)}</div><div class="job-source">${esc(job.sourceNames.join(' + '))} · ${esc(job.encoder)}</div>
    ${['running', 'queued'].includes(job.status) ? `<div class="progress-bar"><div class="progress-fill" style="width:${Number(job.progress) || 0}%"></div></div><div class="job-progress"><span>${job.progress.toFixed(1)}% · ${esc(job.speed || '等待进度')}</span><span>${job.duration ? time(job.duration, false) : '1 帧'}</span></div>` : ''}
    ${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ''}${backupMarkup(job)}
    <div class="job-actions">${actions}</div>
    <details class="job-log" data-log="${job.id}" ${openLogs.has(job.id) ? 'open' : ''}><summary>执行命令与日志</summary><pre>${esc(job.command)}\n\n${esc(job.log || '等待执行')}</pre></details>
  </article>`;
}
function renderJobs() {
  const openLogs = new Set($$('#jobs-list details[open]').map(el => el.dataset.log));
  $('#jobs-list').innerHTML = state.jobs.length ? state.jobs.map(job => jobMarkup(job, openLogs)).join('') : `<div class="queue-empty">${icon('queue')}还没有处理任务<br><small>添加素材并点击“开始处理”，结果会出现在这里。</small></div>`;
}
async function refreshJobs() {
  state.jobs = await api('/api/jobs');
  const count = state.jobs.filter(j => ['running', 'queued'].includes(j.status)).length;
  $('#queue-count').textContent = count || state.jobs.length; $('#queue-count').classList.toggle('busy', count > 0);
  const signature = JSON.stringify(state.jobs.map(j => [j.id, j.status, Math.floor(j.progress), j.replacement?.appliedAt, j.replacement?.restoredAt, j.storageUpdatedAt, j.resultCleanedAt, j.nativeReveal?.id]));
  if (signature !== jobSignature) { jobSignature = signature; renderJobs(); }
}
$('#queue-button').onclick = safeAction(async () => { await refreshJobs(); renderJobs(); $('#queue-dialog').showModal(); });
$('#close-queue').onclick = () => $('#queue-dialog').close();
$('#storage-button').onclick = safeAction(openStorage);
async function openStorage() {
  openModal(modalHeader('清理空间', 'KEEP ONLY WHAT YOU NEED') + '<p class="modal-subtitle">正在统计导出文件、重复文件、缓存和备份…</p>', 'storage');
  let plan;
  try { plan = await api('/api/storage/plan', {}); }
  catch (err) { modalError(err.message); return; }
  if (state.modalType !== 'storage') return;
  const groups = [
    ['export', '导出文件 · 可选', '包含 outputs 文件夹内的媒体文件，以及任务记录中的其他导出结果。默认不勾选；清理后无法还原。'],
    ['duplicate', '重复文件', '清理前会核对内容一致，并保留另一份文件。'],
    ['cache', '闲置缓存', '未使用的导入副本、兼容预览和任务临时文件。'],
    ['backup', '备份与历史版本 · 可选', '默认不勾选。删除原片备份后无法恢复；删除历史版本后不再保留该处理结果。'],
  ];
  openModal(modalHeader('清理空间', 'KEEP ONLY WHAT YOU NEED') + '<p class="modal-subtitle">勾选“导出文件”可清理 outputs 中的结果。默认仅选择重复文件和闲置缓存；源素材、替换后的原片和正在使用的文件自动跳过。</p>' +
    (plan.entries.length ? groups.map(([category, title, hint]) => {
      const entries = plan.entries.filter(e => e.category === category);
      if (!entries.length) return '';
      return `<section class="storage-group ${['backup', 'export'].includes(category) ? 'optional' : ''}"><div class="storage-group-heading"><label><input type="checkbox" data-storage-group="${category}" ${entries.every(e => e.defaultSelected) ? 'checked' : ''}> ${title}</label><span>${entries.length} 项 · ${size(entries.reduce((sum, e) => sum + e.bytes, 0))}</span></div><p>${hint}</p><details><summary>查看文件清单</summary><div class="storage-entries">${entries.map(e => `<label class="storage-entry"><input type="checkbox" data-storage-id="${e.id}" data-category="${category}" ${e.defaultSelected ? 'checked' : ''}><span><strong>${esc(e.path.split(/[\\/]/).pop())}</strong><small>${esc(e.label)} · ${size(e.size)}${e.sharedData ? ' · 数据共享，不计入释放空间' : ''}</small><code>${esc(e.path)}</code>${e.retainedPath ? `<small>保留位置：${esc(e.retainedPath)}</small>` : ''}</span></label>`).join('')}</div></details></section>`;
    }).join('') + '<div class="storage-total"><span id="storage-selected-count"></span><strong id="storage-selected-size"></strong></div><div class="modal-actions"><button class="button" id="storage-cancel">取消</button><button class="button primary" id="storage-review">清理所选</button></div>' : '<div class="queue-empty">没有可清理的文件。<br><small>正在使用的素材和预览会自动跳过。</small></div>'), 'storage');
  if (!plan.entries.length) return;
  const selected = () => new Set($$('[data-storage-id]:checked').map(el => el.dataset.storageId));
  const update = () => {
    const ids = selected(), entries = plan.entries.filter(e => ids.has(e.id));
    $('#storage-selected-count').textContent = `已选择 ${entries.length} 项`;
    $('#storage-selected-size').textContent = `预计释放 ${size(entries.reduce((sum, e) => sum + e.bytes, 0))}`;
    $('#storage-review').disabled = !entries.length;
    $$('[data-storage-group]').forEach(el => {
      const group = plan.entries.filter(e => e.category === el.dataset.storageGroup), count = group.filter(e => ids.has(e.id)).length;
      el.checked = count === group.length; el.indeterminate = count > 0 && count < group.length;
    });
  };
  $$('[data-storage-id]').forEach(el => { el.onchange = update; });
  $$('[data-storage-group]').forEach(el => { el.onchange = () => { $$(`[data-category="${el.dataset.storageGroup}"]`).forEach(item => { item.checked = el.checked; }); update(); }; });
  $('#storage-cancel').onclick = closeModal;
  $('#storage-review').onclick = () => {
    const ids = selected(), entries = plan.entries.filter(e => ids.has(e.id));
    openModal(modalHeader('确认清理所选文件') + `<p class="modal-subtitle">将永久删除下列 ${entries.length} 个文件，预计释放 ${size(entries.reduce((sum, e) => sum + e.bytes, 0))}。所选导出文件和备份无法通过本工具还原；任务记录继续保留，未勾选的文件不会删除。</p><div class="storage-confirm-list">${entries.map(e => `<div><strong>${esc(e.label)}</strong><code>${esc(e.path)}</code></div>`).join('')}</div><div class="modal-actions"><button class="button" id="storage-cancel">取消</button><button class="button danger" id="storage-confirm">确认清理 ${entries.length} 项</button></div>`, 'storage');
    $('#storage-cancel').onclick = closeModal;
    $('#storage-confirm').onclick = async () => {
      $('#storage-confirm').disabled = true; $('#storage-confirm').textContent = '正在核对并清理…';
      try {
        const result = await api('/api/storage/clean', { token: plan.token, entryIds: [...ids], confirmed: true });
        await refreshJobs();
        if (result.skipped.length) openModal(modalHeader('清理完成') + `<p class="modal-subtitle">已清理 ${result.removed.length} 项，释放约 ${size(result.freedBytes)}。以下文件已保留：</p><div class="storage-confirm-list">${result.skipped.map(e => `<div><strong>${esc(e.reason)}</strong><code>${esc(e.path)}</code></div>`).join('')}</div>`, 'storage');
        else { closeModal(); toast(`已清理 ${result.removed.length} 项，释放约 ${size(result.freedBytes)}`); }
      } catch (err) { modalError(`${err.message}。请重新打开清理清单后重试。`); }
    };
  };
  update();
}
$('#jobs-list').addEventListener('click', safeAction(async event => {
  const button = event.target.closest('[data-job-action]'); if (!button) return;
  const { jobAction: action, jobId: id } = button.dataset;
  if (action === 'native-reveal') {
    if (pendingNativeReveal.has(id)) { event.preventDefault(); return; }
    // Keep the anchor's default action: the browser launches the protocol directly in this user gesture.
    void watchNativeReveal(id, button.dataset.nativeTicket);
    return;
  }
  if (['replace', 'restore'].includes(action)) { await confirmReplacement(id, action); return; }
  button.disabled = true;
  try {
    const result = await api(`/api/jobs/${id}/${action}`, {});
    if (action === 'reveal') revealFeedback(result);
    await refreshJobs();
  }
  finally { if (button.isConnected) button.disabled = false; }
}));
const pendingNativeReveal = new Set();
function revealFeedback(result) {
  if (!result.verified) toast('已请求系统打开文件位置');
  else if (!result.foreground) toast('文件夹已显示，但 Windows 未将其切到前台。请在任务栏切换到文件资源管理器。', false, 7000);
  else toast(result.selected ? '已打开文件位置并选中文件' : '已打开文件所在的文件夹');
}
function nativeFallback(jobId, message) {
  openModal(modalHeader('本机助手尚未完成打开') + `<p class="modal-subtitle">${esc(message)}</p><p class="field-hint">浏览器首次调用可能询问是否打开“Frame 文件夹助手”。允许后才能由本机程序接手。如果当前浏览器不支持，也可使用兼容方式打开。</p><div class="modal-actions"><button class="button" id="native-cancel">关闭</button><button class="button primary" id="native-fallback">使用兼容方式</button></div>`, 'native-reveal');
  $('#native-cancel').onclick = closeModal;
  $('#native-fallback').onclick = safeAction(async () => { closeModal(); revealFeedback(await api(`/api/jobs/${jobId}/reveal`, {})); });
}
async function watchNativeReveal(jobId, ticket) {
  pendingNativeReveal.add(jobId);
  toast('正在等待本机助手；如浏览器询问，请允许打开 Frame 文件夹助手。', false, 10000);
  const deadline = Date.now() + 45000;
  try {
    while (Date.now() < deadline) {
      const response = await api(`/api/native-reveal/${ticket}/status`);
      if (response.state === 'completed') { revealFeedback(response.result); return; }
      if (['failed', 'cancelled'].includes(response.state)) throw new Error(response.error || '打开请求已取消');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    await api(`/api/native-reveal/${ticket}/cancel`, {});
    nativeFallback(jobId, '未收到本机助手的回应。浏览器可能取消或拦截了应用唤起。');
  } catch (error) { nativeFallback(jobId, error.message); }
  finally { pendingNativeReveal.delete(jobId); await refreshJobs().catch(() => {}); }
}
async function editReplacement(id, draft) {
  const initial = draft ? await api(`/api/jobs/${id}/replace-plan`, draft) : await api(`/api/jobs/${id}/replace-plan`);
  let plan = initial, requestVersion = 0, timer;
  openModal(modalHeader('替换原素材', 'SAVE IT YOUR WAY') + `<div class="confirm-step"><i>1</i> 设置文件名与替换方式</div>
    <div class="confirm-path"><span>原素材</span><code>${esc(initial.sourcePath)}</code></div>
    <label class="modal-field">替换后的文件名<input id="replacement-name" value="${esc(initial.targetName)}" spellcheck="false" autocomplete="off" maxlength="160" aria-describedby="replacement-name-hint"></label>
    <p class="field-hint" id="replacement-name-hint">可填写新名称；输出格式为 ${esc(initial.extension.toUpperCase())}，省略扩展名时自动补齐 .${esc(initial.extension)}。</p>
    <fieldset class="replacement-modes"><legend>替换方式</legend>
      <label class="replacement-mode ${initial.mode === 'backup' ? 'active' : ''}"><input type="radio" name="replacement-mode" value="backup" ${initial.mode === 'backup' ? 'checked' : ''}><span><strong>保留原片备份 <em>默认</em></strong><small>保留一份原片，可在任务队列中恢复。</small></span></label>
      <label class="replacement-mode destructive ${initial.mode === 'overwrite' ? 'active' : ''}"><input type="radio" name="replacement-mode" value="overwrite" ${initial.mode === 'overwrite' ? 'checked' : ''}><span><strong>直接覆盖</strong><small>不保留备份，覆盖后无法通过本工具还原。</small></span></label>
    </fieldset>
    <div class="confirm-path"><span>新文件保存位置</span><code id="replacement-target">${esc(initial.targetPath)}</code></div>
    <p class="confirm-note" id="replacement-mode-note"></p><div class="modal-error" id="replacement-form-error" role="alert" hidden></div>
    <div class="modal-actions"><button class="button" id="replace-cancel">取消</button><button class="button dark" id="replace-next">确认设置，继续</button></div>`, 'replacement');
  const nameInput = $('#replacement-name'), next = $('#replace-next'), target = $('#replacement-target'), error = $('#replacement-form-error');
  const readDraft = () => ({ targetName: nameInput.value, mode: $('[name="replacement-mode"]:checked').value });
  const updateMode = () => {
    const mode = readDraft().mode;
    $$('.replacement-mode').forEach(el => el.classList.toggle('active', el.querySelector('input').checked));
    $('#replacement-mode-note').textContent = mode === 'overwrite'
      ? '原文件会被移除，仅保留处理结果。下一步需要确认不可还原。'
      : '原片会移到备份目录；导出结果移到上方位置，不额外保留重复副本。';
    $('#replacement-mode-note').classList.toggle('destructive-text', mode === 'overwrite');
  };
  const validate = async version => {
    if (!nameInput.isConnected) return;
    try {
      const result = await api(`/api/jobs/${id}/replace-plan`, readDraft());
      if (!nameInput.isConnected || version !== requestVersion) return;
      plan = result; target.textContent = result.targetPath; error.hidden = true; next.disabled = false;
    } catch (err) {
      if (!nameInput.isConnected || version !== requestVersion) return;
      error.textContent = err.message; error.hidden = false; target.textContent = '请先修正文件名称';
    }
  };
  const changed = immediate => {
    clearTimeout(timer); plan = null; next.disabled = true; error.hidden = true; updateMode(); target.textContent = '正在核对保存位置…';
    const version = ++requestVersion;
    if (immediate) void validate(version); else timer = setTimeout(() => void validate(version), 220);
  };
  nameInput.oninput = () => changed(false);
  $$('[name="replacement-mode"]').forEach(el => { el.onchange = () => changed(true); });
  $('#replace-cancel').onclick = () => { clearTimeout(timer); closeModal(); };
  next.onclick = async () => {
    if (!plan) return; next.disabled = true;
    try {
      const response = await api(`/api/jobs/${id}/replace-prepare`, { acknowledged: true, targetName: plan.targetName, mode: plan.mode });
      if (nameInput.isConnected) showReplacementReview(id, response);
    } catch (err) { if (nameInput.isConnected) { error.textContent = err.message; error.hidden = false; next.disabled = false; } }
  };
  updateMode();
  nameInput.focus(); nameInput.setSelectionRange(0, Math.max(0, nameInput.value.length - initial.extension.length - 1));
}
function showReplacementReview(id, response) {
  const plan = response.plan, direct = plan.mode === 'overwrite';
  openModal(modalHeader(direct ? '确认直接覆盖' : '确认替换原素材') + `<div class="confirm-step"><i>2</i> 核对最终操作</div>
    <div class="confirm-path"><span>将被替换的原文件</span><code>${esc(plan.sourcePath)}</code></div>
    <div class="confirm-path"><span>处理后的视频保存为</span><code>${esc(plan.targetPath)}</code></div>
    ${direct ? `<div class="replacement-warning">${icon('info', 18)}<div><strong>覆盖后无法通过本工具还原</strong><p>本次不保留原片备份。原文件会被移除，仅保留处理后的视频。</p></div></div><label class="overwrite-ack"><input id="overwrite-ack" type="checkbox">我已确认处理结果，并了解本次直接覆盖无法还原。</label>` : `<p class="confirm-note">原片保留一份备份，可在任务队列恢复。新文件名为 ${esc(plan.targetFileName)}，导出目录不再额外保留副本。</p>`}
    <div class="modal-actions"><button class="button" id="replace-back">返回修改</button><button class="button" id="replace-cancel">取消</button><button class="button ${direct ? 'danger' : 'primary'}" id="replace-final" ${direct ? 'disabled' : ''}>${direct ? '确认直接覆盖' : '确认替换'}</button></div>`, 'replacement');
  $('#replace-back').onclick = safeAction(() => editReplacement(id, { targetName: plan.targetName, mode: plan.mode }));
  $('#replace-cancel').onclick = closeModal;
  if (direct) $('#overwrite-ack').onchange = event => { $('#replace-final').disabled = !event.target.checked; };
  $('#replace-final').onclick = async () => {
    const button = $('#replace-final'); button.disabled = true; button.textContent = '正在替换…';
    try {
      await api(`/api/jobs/${id}/replace`, { token: response.token, confirmed: true, overwriteAcknowledged: direct && $('#overwrite-ack').checked });
      closeModal(); await refreshJobs(); toast(direct ? '已直接覆盖，本次未保留原片备份。' : '已按新名称替换，原片备份已保留。');
    } catch (err) { modalError(err.message + '。请返回重新核对状态。'); }
  };
}
async function confirmReplacement(id, action) {
  if (action === 'replace') return editReplacement(id);
  const job = state.jobs.find(j => j.id === id), restoring = action === 'restore';
  const plan = restoring ? job.replacement : await api(`/api/jobs/${id}/replace-plan`);
  const verb = restoring ? '恢复' : '替换';
  openModal(modalHeader(`${verb}原素材`, 'A CAREFUL LAST STEP') + `<div class="confirm-step"><i>1</i> 第一次确认 · 核对文件</div><p class="modal-subtitle">${restoring ? '将原片移回原位置，处理后版本移到备份目录，仍只保留两份文件。' : '处理结果会放回原素材所在目录。请确认下方路径。'}</p><div class="confirm-path"><span>原素材</span><code>${esc(plan.sourcePath)}</code></div><div class="confirm-path"><span>${restoring ? '恢复自备份' : '替换后的位置'}</span><code>${esc(restoring ? plan.backupPath : plan.targetPath)}</code></div><p class="confirm-note">${restoring ? '如果文件在替换后又被修改，将停止自动恢复。' : `原文件将备份到 ${esc(plan.backupDirectory)}。${plan.formatChanged ? '输出格式不同，将使用新的扩展名。' : ''}导出结果会移到原位置，不再保留重复的导出副本。`}</p><div class="modal-actions"><button class="button" id="replace-cancel">取消</button><button class="button dark" id="replace-next">已核对，继续</button></div>`, 'replacement');
  $('#replace-cancel').onclick = closeModal;
  $('#replace-next').onclick = async () => {
    try {
      const response = await api(`/api/jobs/${id}/${action}-prepare`, { acknowledged: true });
      openModal(modalHeader(`确认${verb}这个文件`) + `<div class="confirm-step"><i>2</i> 第二次确认 · 输入文件名</div><p class="modal-subtitle">请输入下面的原文件名，以确认${verb}操作。确认在 2 分钟内有效。</p><p><span class="confirm-name">${esc(plan.confirmName)}</span></p><label class="modal-field">原文件名<input id="confirm-filename" autocomplete="off" spellcheck="false" placeholder="包含扩展名，需完全一致"></label><p class="confirm-note">${restoring ? '将恢复已备份的原素材。' : '将修改原素材所在位置；原文件会保留备份。'}</p><div class="modal-actions"><button class="button" id="replace-cancel">取消</button><button class="button danger" id="replace-final" disabled>确认${verb}</button></div>`, 'replacement');
      $('#replace-cancel').onclick = closeModal;
      $('#confirm-filename').oninput = event => { $('#replace-final').disabled = event.target.value !== plan.confirmName; };
      $('#confirm-filename').focus();
      $('#replace-final').onclick = async () => {
        $('#replace-final').disabled = true;
        try { await api(`/api/jobs/${id}/${action}`, { token: response.token, confirmName: $('#confirm-filename').value }); closeModal(); await refreshJobs(); toast(restoring ? '原素材已恢复，只保留原片与处理后版本。' : '已替换原素材，保留一份原片备份，任务位置已更新。'); }
        catch (err) { modalError(err.message + '。请关闭此窗口后重新确认。'); }
      };
    } catch (err) { modalError(err.message); }
  };
}

document.addEventListener('keydown', event => {
  if ($('dialog[open]') || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (event.code === 'Space' && current() && !state.previewFailed) { event.preventDefault(); $('#play-button').click(); }
  if (['trim', 'gif'].includes(state.operation)) { if (event.key.toLowerCase() === 'i') setBoundary('start'); if (event.key.toLowerCase() === 'o') setBoundary('end'); }
});
for (const dialog of [$('#modal'), $('#queue-dialog')]) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
$('#modal').addEventListener('close', () => { state.modalType = ''; });
$('#tools').innerHTML = tools.map(tool => `<button class="nav-item ${tool.id === state.operation ? 'active' : ''}" data-tool="${tool.id}" title="${tool.name}" aria-label="${tool.name}" aria-current="${tool.id === state.operation ? 'page' : 'false'}">${icon(tool.icon)}<span>${tool.name}</span></button>`).join('');
$('#tool-count').textContent = String(tools.length).padStart(2, '0');
$$('[data-tool]').forEach(button => { button.onclick = () => setOperation(button.dataset.tool); });
injectIcons(); renderOptions(); renderRange();
async function poll() {
  try {
    await refreshJobs();
    if (state.system.checking || !state.system.ready || state.modalType === 'settings') {
      const previous = JSON.stringify(state.system.encoders), wasChecking = state.system.checking;
      state.system = await api('/api/status'); systemView();
      if (previous !== JSON.stringify(state.system.encoders) || wasChecking !== state.system.checking) { renderOptions(); schedulePlan(); }
    }
  } catch { $('#system-alert').hidden = false; $('#system-alert').textContent = '无法连接本地服务。请保持启动窗口运行，服务恢复后刷新网页。'; }
  setTimeout(poll, 1400);
}
try {
  const bootstrap = await api('/api/bootstrap');
  Object.assign(state, { token: bootstrap.token, settings: bootstrap.settings, system: bootstrap.system, platform: bootstrap.platform });
  $('#output-dir').value = state.settings.outputDir;
  $('#command-shell').textContent = state.platform === 'win32' ? 'PowerShell · 参数化执行，不经过 shell' : 'Shell 命令预览 · 后端使用参数数组执行';
  systemView(); renderOptions(); void poll();
} catch (err) { $('#system-alert').hidden = false; $('#system-alert').textContent = `连接失败：${err.message}。请刷新页面重试。`; }
