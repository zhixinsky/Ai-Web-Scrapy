/**
 * 腾讯云翻译 TextTranslate
 * 文档：项目根目录 22.md
 *
 * 依赖环境变量：
 * - TENCENT_SECRET_ID
 * - TENCENT_SECRET_KEY
 * - TENCENT_TMT_REGION（可选，默认 ap-guangzhou）
 *
 * 接口：
 * - Host: tmt.tencentcloudapi.com
 * - Action: TextTranslate
 * - Version: 2018-03-21
 * - 签名：TC3-HMAC-SHA256
 */

import crypto from 'node:crypto';

const SERVICE = 'tmt';
const HOST = 'tmt.tencentcloudapi.com';
const VERSION = '2018-03-21';
const ACTION = 'TextTranslate';
const ENDPOINT = `https://${HOST}`;

function getTencentCreds() {
  const secretId = String(process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = String(process.env.TENCENT_SECRET_KEY || '').trim();
  const region = String(process.env.TENCENT_TMT_REGION || 'ap-guangzhou').trim() || 'ap-guangzhou';
  return { secretId, secretKey, region };
}

export function isTencentTranslateConfigured() {
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

/**
 * 翻译文本
 * @param {string} text - 待翻译文本
 * @param {string} source - 源语言（如 'en'）
 * @param {string} target - 目标语言（如 'zh'）
 * @returns {Promise<string>} 翻译后的文本
 */
export async function tencentTranslate(text, source = 'en', target = 'zh') {
  const { secretId, secretKey, region } = getTencentCreds();
  if (!secretId || !secretKey) {
    throw new Error('未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
  }

  const payloadObj = {
    SourceText: text,
    Source: source,
    Target: target,
    ProjectId: 0,
  };

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(payloadObj);

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

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`腾讯翻译请求失败: ${res.status} ${errText}`);
  }

  const data = await res.json();

  if (data.Response?.Error) {
    const err = data.Response.Error;
    throw new Error(`腾讯翻译错误: ${err.Code} - ${err.Message}`);
  }

  return data.Response?.TargetText || '';
}
