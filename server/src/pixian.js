/**
 * Pixian.AI 去背景 API
 * @see https://pixian.ai/api
 *
 * 优先使用表单字段 `image.url`（公网可访问的图片地址，与采集数据中的 URL 一致）；
 * 无 URL 时可回退为 multipart 字段 `image` 上传本地文件内容。
 *
 * 环境变量：
 * - PIXIAN_USER / PIXIAN_SECRET：Basic 鉴权（API Id / API Secret）
 * - PIXIAN_TEST=1：传 test=true，免费但结果含水印（无生产额度时可用）
 */
const PIXIAN_URL = 'https://api.pixian.ai/api/v2/remove-background';
const PRICING_URL = 'https://pixian.ai/pricing';
const PIXIAN_TARGET_SIZE = '1000 1000';
const PIXIAN_OUTPUT_FORMAT = 'jpeg';
const PIXIAN_BACKGROUND = '#FFFFFF';
const PIXIAN_JPEG_QUALITY = '90';

function isTestMode() {
  const v = String(process.env.PIXIAN_TEST || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function parsePixianErrorBody(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch {
    // ignore
  }
  return text.slice(0, 600);
}

async function postPixianForm(form) {
  const user = String(process.env.PIXIAN_USER || '').trim();
  const secret = String(process.env.PIXIAN_SECRET || '').trim();
  if (!user || !secret) {
    throw new Error('服务端未配置 PIXIAN_USER / PIXIAN_SECRET 环境变量');
  }
  const auth = Buffer.from(`${user}:${secret}`, 'utf8').toString('base64');

  /** 官方建议空闲超时至少 180 秒 @see https://pixian.ai/api — Timeouts */
  const signal = AbortSignal.timeout(180_000);

  const res = await fetch(PIXIAN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
    },
    body: form,
    redirect: 'follow',
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const detail = parsePixianErrorBody(text);
    if (res.status === 402) {
      if (isTestMode()) {
        throw new Error(
          `Pixian 402（已启用 test 模式仍失败）：${detail}。` +
            `请确认启动日志中有「[env] PIXIAN_TEST 已生效」；若无，检查 server/.env 是否为 UTF-8 无 BOM、并已重启进程。`
        );
      }
      throw new Error(
        `Pixian 402：当前账户没有可用于「正式」去背景的额度（或额度已休眠）。` +
          `请在官网购买额度：${PRICING_URL} 。` +
          `开发/试用可在 server/.env 设置 PIXIAN_TEST=1（对应官方参数 test=true，免费但结果含水印）。` +
          `接口原文：${detail}`
      );
    }
    throw new Error(`Pixian ${res.status}: ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function isPixianConfigured() {
  return Boolean(
    String(process.env.PIXIAN_USER || '').trim() && String(process.env.PIXIAN_SECRET || '').trim()
  );
}

/**
 * 使用采集到的图片公网 URL 调用 Pixian（form 字段 `image.url`，与官方 request 示例一致）
 * @param {string} imageUrl
 */
export async function removeBackgroundFromImageUrl(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!url) {
    throw new Error('图片 URL 为空');
  }
  const form = new FormData();
  /**
   * 按官方说明：jpeg 需要不透明背景；同时强制输出尺寸 1000×1000
   * - result.crop_to_foreground: 聚焦主体再缩放，避免主体过小
   * - result.target_size: 固定结果尺寸
   * - output.format: 强制 jpeg
   */
  if (isTestMode()) {
    form.append('test', 'true');
  }
  form.append('background.color', PIXIAN_BACKGROUND);
  form.append('result.crop_to_foreground', 'true');
  form.append('result.target_size', PIXIAN_TARGET_SIZE);
  form.append('output.format', PIXIAN_OUTPUT_FORMAT);
  form.append('output.jpeg_quality', PIXIAN_JPEG_QUALITY);
  form.append('image.url', url);
  return postPixianForm(form);
}

/**
 * 无可用 URL 时回退：multipart 字段 `image` 上传缓冲区
 * @param {Buffer} buffer
 * @param {string} [filenameHint]
 */
export async function removeBackgroundFromBuffer(buffer, filenameHint) {
  const fileName = filenameHint || 'image.jpg';
  const lower = fileName.toLowerCase();
  const mime = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : lower.endsWith('.gif')
        ? 'image/gif'
        : 'image/jpeg';
  const form = new FormData();
  if (isTestMode()) {
    form.append('test', 'true');
  }
  form.append('background.color', PIXIAN_BACKGROUND);
  form.append('result.crop_to_foreground', 'true');
  form.append('result.target_size', PIXIAN_TARGET_SIZE);
  form.append('output.format', PIXIAN_OUTPUT_FORMAT);
  form.append('output.jpeg_quality', PIXIAN_JPEG_QUALITY);
  if (typeof File !== 'undefined') {
    form.append('image', new File([buffer], fileName, { type: mime }));
  } else {
    form.append('image', new Blob([buffer], { type: mime }), fileName);
  }
  return postPixianForm(form);
}
