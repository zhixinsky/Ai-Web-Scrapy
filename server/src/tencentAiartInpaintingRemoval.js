/**
 * 腾讯云 AIArt：局部消除 ImageInpaintingRemoval（mask 指定区域消除并补全）
 * 文档：项目根目录 22.md
 *
 * 依赖环境变量：
 * - TENCENT_SECRET_ID
 * - TENCENT_SECRET_KEY
 * - TENCENT_AIART_REGION（可选，默认 ap-guangzhou）
 *
 * 接口：
 * - Host: aiart.tencentcloudapi.com
 * - Action: ImageInpaintingRemoval
 * - Version: 2022-12-29
 * - 签名：TC3-HMAC-SHA256
 */

import crypto from 'node:crypto';
import sharp from 'sharp';

const SERVICE = 'aiart';
const HOST = 'aiart.tencentcloudapi.com';
const VERSION = '2022-12-29';
const ACTION = 'ImageInpaintingRemoval';
const ENDPOINT = `https://${HOST}`;

const MAX_SIDE_PX = 4990; // 文档要求 <5000px，留安全边际
const MAX_B64_BYTES = 6 * 1024 * 1024; // 文档：Base64 字符串后 < 6MB（这里按字节近似控制）
// base64 开销约 4/3，这里用更保守的二进制阈值
const MAX_BINARY_BYTES = Math.floor((MAX_B64_BYTES * 3) / 4) - 1024;

async function coerceToTencentLimits(opts) {
  const imgIn = opts.imageBuffer;
  const maskIn = opts.maskBuffer;
  if (!Buffer.isBuffer(imgIn) || imgIn.length === 0) throw new Error('缺少 imageBuffer');
  if (!Buffer.isBuffer(maskIn) || maskIn.length === 0) throw new Error('缺少 maskBuffer');

  // 读尺寸；若无法识别，直接走原 buffer（让腾讯侧报错更清晰）
  let meta;
  try {
    meta = await sharp(imgIn, { failOnError: false }).metadata();
  } catch {
    meta = null;
  }
  const w0 = Number(meta?.width || 0);
  const h0 = Number(meta?.height || 0);

  let scale = 1;
  if (w0 > 0 && h0 > 0) {
    const maxSide = Math.max(w0, h0);
    if (maxSide >= MAX_SIDE_PX) {
      scale = MAX_SIDE_PX / maxSide;
    }
  }

  const targetW = w0 > 0 ? Math.max(1, Math.floor(w0 * scale)) : null;
  const targetH = h0 > 0 ? Math.max(1, Math.floor(h0 * scale)) : null;

  // 图片：优先转 JPEG（体积更可控）；透明背景用白底 flatten
  let img = sharp(imgIn, { failOnError: false });
  if (targetW && targetH && (scale < 1)) {
    img = img.resize(targetW, targetH, { fit: 'fill' });
  }

  let outImgBuf = null;
  const qualities = [88, 78, 68, 58, 48, 40];
  for (const q of qualities) {
    try {
      const b = await img
        .clone()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();
      outImgBuf = b;
      if (b.length <= MAX_BINARY_BYTES) break;
    } catch {
      // try next
      outImgBuf = null;
    }
  }
  if (!outImgBuf) {
    // fallback：直接转 PNG（可能较大，但至少可用）
    outImgBuf = await img.clone().png({ compressionLevel: 9 }).toBuffer();
  }

  // 掩码：保持 PNG，缩放到与图片一致；用 nearest 避免边缘模糊
  let mask = sharp(maskIn, { failOnError: false });
  if (targetW && targetH && (scale < 1)) {
    mask = mask.resize(targetW, targetH, { fit: 'fill', kernel: sharp.kernel.nearest });
  }
  const outMaskBuf = await mask.png({ compressionLevel: 9 }).toBuffer();

  return { imageBuffer: outImgBuf, maskBuffer: outMaskBuf };
}

function getTencentCreds() {
  const secretId = String(process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = String(process.env.TENCENT_SECRET_KEY || '').trim();
  const region = String(process.env.TENCENT_AIART_REGION || 'ap-guangzhou').trim() || 'ap-guangzhou';
  return { secretId, secretKey, region };
}

export function isTencentAiartConfigured() {
  const { secretId, secretKey } = getTencentCreds();
  return Boolean(secretId && secretKey);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hmacSha256(key, msg, encoding = undefined) {
  return crypto.createHmac('sha256', key).update(msg).digest(encoding);
}

/**
 * TC3 签名（简化：POST JSON，canonicalQueryString 为空，canonicalHeaders 固定）。
 * @param {{ payload: string; timestamp: number; secretId: string; secretKey: string; region: string }} opts
 */
function buildTencentAuthorization(opts) {
  const date = new Date(opts.timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const canonicalRequest =
    'POST\n' +
    '/\n' +
    '\n' +
    `content-type:application/json; charset=utf-8\nhost:${HOST}\n` +
    '\n' +
    'content-type;host\n' +
    sha256Hex(opts.payload);

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign =
    'TC3-HMAC-SHA256\n' + `${opts.timestamp}\n` + `${credentialScope}\n` + sha256Hex(canonicalRequest);

  const secretDate = hmacSha256(`TC3${opts.secretKey}`, date);
  const secretService = hmacSha256(secretDate, SERVICE);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');

  return `TC3-HMAC-SHA256 Credential=${opts.secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;
}

async function postTencentJson(payloadObj) {
  const { secretId, secretKey, region } = getTencentCreds();
  if (!secretId || !secretKey) {
    throw new Error('未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(payloadObj || {});

  const Authorization = buildTencentAuthorization({
    payload,
    timestamp,
    secretId,
    secretKey,
    region,
  });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: HOST,
      'X-TC-Action': ACTION,
      'X-TC-Version': VERSION,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      Authorization,
    },
    body: payload,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && data?.Response?.Error?.Message
        ? String(data.Response.Error.Message)
        : res.statusText || '腾讯云请求失败';
    throw new Error(msg);
  }
  return data;
}

/**
 * @param {{ imageBuffer: Buffer; maskBuffer: Buffer }} opts
 * @returns {Promise<{ buf: Buffer; contentType: string }>}
 */
export async function runTencentImageInpaintingRemoval(opts) {
  const coerced = await coerceToTencentLimits(opts);
  const imgB64 = coerced.imageBuffer.toString('base64');
  const maskB64 = coerced.maskBuffer.toString('base64');

  const resp = await postTencentJson({
    InputImage: imgB64,
    Mask: maskB64,
    RspImgType: 'base64',
    LogoAdd: 0,
  });
  const outB64 = String(resp?.Response?.ResultImage || '').trim();
  if (!outB64) {
    const errMsg = resp?.Response?.Error?.Message ? String(resp.Response.Error.Message) : '';
    throw new Error(errMsg || '腾讯局部消除失败：未返回 ResultImage');
  }
  const buf = Buffer.from(outB64, 'base64');
  return { buf, contentType: 'image/png' };
}

