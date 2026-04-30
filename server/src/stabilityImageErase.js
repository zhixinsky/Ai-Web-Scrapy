/**
 * Stability.ai Stable Image API - Erase（对象消除/修补）
 * 文档见项目根目录 22.md
 *
 * 环境变量：
 * - STABILITY_API_KEY
 * - STABILITY_CLIENT_ID（可选）
 * - STABILITY_CLIENT_USER_ID（可选）
 * - STABILITY_CLIENT_VERSION（可选）
 * - STABILITY_ERASE_OUTPUT_FORMAT（可选：png/jpeg/webp；默认 png）
 */

const ERASE_URL = 'https://api.stability.ai/v2beta/stable-image/edit/erase';

export function getStabilityApiKey() {
  return String(process.env.STABILITY_API_KEY || '').trim();
}

function pickOutputFormat() {
  const v = String(process.env.STABILITY_ERASE_OUTPUT_FORMAT || 'png').trim().toLowerCase();
  if (v === 'jpeg' || v === 'jpg') return 'jpeg';
  if (v === 'webp') return 'webp';
  return 'png';
}

function withClientHeaders(headers) {
  const out = { ...(headers || {}) };
  const cid = String(process.env.STABILITY_CLIENT_ID || '').trim();
  const cuid = String(process.env.STABILITY_CLIENT_USER_ID || '').trim();
  const cver = String(process.env.STABILITY_CLIENT_VERSION || '').trim();
  if (cid) out['stability-client-id'] = cid;
  if (cuid) out['stability-client-user-id'] = cuid;
  if (cver) out['stability-client-version'] = cver;
  return out;
}

/**
 * @param {{ imageBuffer: Buffer; imageMime: string; maskBuffer: Buffer }} opts
 * @returns {Promise<{ buf: Buffer; contentType: string }>}
 */
export async function stabilityErase(opts) {
  const apiKey = getStabilityApiKey();
  if (!apiKey) throw new Error('未配置 STABILITY_API_KEY');

  const imageMime = String(opts.imageMime || 'image/png').trim() || 'image/png';
  const form = new FormData();
  form.append('image', new Blob([opts.imageBuffer], { type: imageMime }), 'image');
  form.append('mask', new Blob([opts.maskBuffer], { type: 'image/png' }), 'mask.png');
  form.append('output_format', pickOutputFormat());

  const res = await fetch(ERASE_URL, {
    method: 'POST',
    headers: withClientHeaders({
      Authorization: `Bearer ${apiKey}`,
      Accept: 'image/*',
    }),
    body: form,
    signal: AbortSignal.timeout(240_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const msg = t || res.statusText || `HTTP ${res.status}`;
    throw new Error(`Stability Erase 失败：${msg}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
  return { buf, contentType };
}

