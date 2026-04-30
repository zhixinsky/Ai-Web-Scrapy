/**
 * 百度智能云：图像修复（inpainting）
 * - Access Token: client_credentials（AK/SK）
 * - 修复接口：/rest/2.0/image-process/v1/inpainting
 *
 * 依赖环境变量：
 * - BAIDU_API_KEY
 * - BAIDU_SECRET_KEY
 */

const BAIDU_OAUTH_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_INPAINT_URL = 'https://aip.baidubce.com/rest/2.0/image-process/v1/inpainting';

let cachedToken = /** @type {{ accessToken: string; expireAtMs: number } | null} */ (null);

function getBaiduBearerApiKey() {
  // 新版：直接在 Header 里传 Authorization: Bearer bce-v3/...
  const bearer = String(
    process.env.BAIDU_BEARER_API_KEY ||
      process.env.BAIDU_API_KEY_BEARER ||
      process.env.BAIDU_BEARER_TOKEN ||
      ''
  ).trim();
  return bearer;
}

function getBaiduKeys() {
  const apiKey = String(process.env.BAIDU_API_KEY || '').trim();
  const secretKey = String(process.env.BAIDU_SECRET_KEY || '').trim();
  return { apiKey, secretKey };
}

export function isBaiduInpaintingConfigured() {
  const bearer = getBaiduBearerApiKey();
  if (bearer) return true;
  const { apiKey, secretKey } = getBaiduKeys();
  return Boolean(apiKey && secretKey);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error_description' in data
        ? String(data.error_description)
        : data && typeof data === 'object' && 'error_msg' in data
          ? String(data.error_msg)
          : res.statusText || '请求失败';
    const err = new Error(msg);
    // @ts-ignore
    err.status = res.status;
    // @ts-ignore
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * 获取百度 access_token，并做简单内存缓存。
 * @returns {Promise<string>}
 */
export async function getBaiduAccessToken() {
  const bearer = getBaiduBearerApiKey();
  if (bearer) {
    throw new Error('已配置 BAIDU_BEARER_API_KEY（Bearer bce-v3/...）；无需获取 access_token');
  }
  const { apiKey, secretKey } = getBaiduKeys();
  if (!apiKey || !secretKey) {
    throw new Error('未配置 BAIDU_API_KEY / BAIDU_SECRET_KEY（或改用 BAIDU_BEARER_API_KEY）');
  }

  const now = Date.now();
  if (cachedToken && cachedToken.accessToken && cachedToken.expireAtMs - now > 30_000) {
    return cachedToken.accessToken;
  }

  const q = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: secretKey,
  });
  const data = await fetchJson(`${BAIDU_OAUTH_URL}?${q.toString()}`, { method: 'POST' });
  const token = String(data?.access_token || '').trim();
  const expiresIn = Number(data?.expires_in || 0);
  if (!token) throw new Error('百度鉴权失败：未返回 access_token');
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 30 * 60 * 1000;
  cachedToken = {
    accessToken: token,
    expireAtMs: now + ttlMs,
  };
  return token;
}

/**
 * 调用百度图像修复（规则矩形）。
 * @param {{ imageBase64: string; rectangle: Array<{ left: number; top: number; width: number; height: number }> }} opts
 * @returns {Promise<{ imageBase64: string; logId?: string }>}
 */
export async function baiduInpaintRectangle(opts) {
  const bearer = getBaiduBearerApiKey();
  const rect = Array.isArray(opts.rectangle) ? opts.rectangle : [];
  if (!rect.length) throw new Error('缺少 rectangle');
  const imageBase64 = String(opts.imageBase64 || '').trim();
  if (!imageBase64) throw new Error('缺少 imageBase64');

  const url = bearer
    ? BAIDU_INPAINT_URL
    : `${BAIDU_INPAINT_URL}?access_token=${encodeURIComponent(await getBaiduAccessToken())}`;
  const body = JSON.stringify({
    rectangle: rect.map((r) => ({
      left: Math.max(0, Math.floor(Number(r.left) || 0)),
      top: Math.max(0, Math.floor(Number(r.top) || 0)),
      width: Math.max(1, Math.floor(Number(r.width) || 0)),
      height: Math.max(1, Math.floor(Number(r.height) || 0)),
    })),
    image: imageBase64,
  });

  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body,
  });
  const outB64 = String(data?.image || '').trim();
  if (!outB64) throw new Error('百度图像修复失败：未返回 image');
  return { imageBase64: outB64, logId: data?.log_id != null ? String(data.log_id) : undefined };
}

