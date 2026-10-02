import path from 'node:path';

export const COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
export const COVER_MAX_BYTES = 32 * 1024 * 1024;
export const COVER_CONTAINERS = new Set(['.mp4', '.m4v', '.mkv']);

// Matroska exposes image attachments as attached pictures. Keep unrelated artwork,
// fonts and other attachments; only the standard cover names are replaced there.
export function isCoverStream(stream, matroska = false) {
  if (!matroska) return Boolean(stream.disposition?.attached_pic);
  return Boolean(stream.disposition?.attached_pic || ['attachment'].includes(stream.type || stream.codec_type))
    && /^(?:small_)?cover(?:_land)?\.(?:jpe?g|png)$/i.test(stream.tags?.filename || '');
}

export function coverOperation(file, cover, fail, attachmentPath) {
  const suffix = path.extname(file.path).toLowerCase();
  if (!file.video || !COVER_CONTAINERS.has(suffix)) fail('替换封面支持 MP4、M4V 和 MKV 视频；请使用这些格式的原素材。');
  if (!cover) fail('请选择一张 JPG 或 PNG 封面图片');
  if (!COVER_EXTENSIONS.has(path.extname(cover.path).toLowerCase()) || !['png', 'mjpeg'].includes(cover.codec)) fail('封面图片格式无效');
  const matroska = suffix === '.mkv';
  if (!file.streamDetails?.length) fail('请重新添加视频，以读取完整的轨道信息');
  const retainedPictures = matroska ? file.streamDetails.filter(s => s.disposition?.attached_pic && !isCoverStream(s, true)) : [];
  const keep = file.streamDetails.filter(s => !isCoverStream(s, matroska) && !retainedPictures.includes(s));
  const preprocess = retainedPictures.map(stream => {
    const destination = attachmentPath(stream.index);
    return { path: destination, args: ['-protocol_whitelist', 'file,pipe', '-i', file.path, '-map', `0:${stream.index}`, '-c', 'copy', '-frames:v', '1', '-f', 'data', destination] };
  });
  const args = ['-copyts', '-protocol_whitelist', 'file,pipe', '-i', file.path];
  if (!matroska) args.push('-protocol_whitelist', 'file,pipe', '-i', cover.path);
  for (const stream of keep) args.push('-map', `0:${stream.index}`);
  if (!matroska) args.push('-map', '1:v:0');
  args.push('-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', '-copy_unknown');
  // Explicit dispositions avoid FFmpeg adding a default flag to an existing track.
  keep.forEach((stream, index) => {
    const flags = Object.entries(stream.disposition || {}).filter(([, value]) => value).map(([name]) => name);
    args.push(`-disposition:${index}`, flags.join('+') || '0');
  });
  if (matroska) {
    args.push('-attach', cover.path, `-metadata:s:${keep.length}`, `mimetype=${cover.mime}`,
      `-metadata:s:${keep.length}`, `filename=cover.${cover.codec === 'png' ? 'png' : 'jpg'}`);
    // FFmpeg maps Matroska attached pictures as regular video tracks on remux.
    // Extract their encoded packet unchanged and reattach it to keep that role.
    retainedPictures.forEach((stream, i) => {
      args.push('-attach', preprocess[i].path);
      for (const [key, value] of Object.entries(stream.tags || {})) args.push(`-metadata:s:${keep.length + i + 1}`, `${key}=${value}`);
    });
  } else {
    args.push(`-disposition:${keep.length}`, 'attached_pic');
    // mov_text already carries its bitrate box in extradata; avoid appending
    // another one on every remux while keeping the copied subtitle header.
    args.push('-f', 'mp4', '-movflags', '+faststart', '-write_btrt', '0');
  }
  args.push('-avoid_negative_ts', 'disabled');
  return { args, extension: suffix.slice(1), duration: file.duration, encoder: '音视频流复制 · 无需编码', title: '替换封面',
    warnings: ['只更新内嵌封面，音视频不重编码。播放器或资源管理器可能仍显示自行截取的缩略图。'], extraFiles: [], preprocess, estimatedSize: null };
}
