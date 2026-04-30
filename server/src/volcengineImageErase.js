/**
 * 火山引擎视觉「i2i_inpainting」涂抹消除（异步任务 + 查询结果）。
 * @see 项目根目录 volc.md
 */

import ServiceMod from '@volcengine/openapi/lib/base/service.js';
import { downloadHttpBuffer } from './dashscopeImageErase.js';

const Service = ServiceMod.default;

const REQ_KEY = 'i2i_inpainting';
const VISUAL_HOST = 'visual.volcengineapi.com';

/** @returns {{ accessKeyId: string; secretKey: string }} */
export function getVolcAccessKeys() {
  const accessKeyId = String(
    process.env.VOLC_ACCESS_KEY_ID || process.env.VOLC_ACCESSKEY || ''
  ).trim();
  const secretKey = String(
    process.env.VOLC_SECRET_ACCESS_KEY || process.env.VOLC_SECRETKEY || ''
  ).trim();
  return { accessKeyId, secretKey };
}

export function isVolcImageEraseConfigured() {
  const { accessKeyId, secretKey } = getVolcAccessKeys();
  return Boolean(accessKeyId && secretKey);
}

function getVisualService() {
  const { accessKeyId, secretKey } = getVolcAccessKeys();
  if (!accessKeyId || !secretKey) {
    throw new Error('未配置 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY（火山引擎 AK/SK）');
  }
  return new Service({
    host: VISUAL_HOST,
    region: 'cn-north-1',
    serviceName: 'cv',
    accessKeyId,
    secretKey,
  });
}

function assertVolcInputLimits(imageBuffer, imageMime) {
  const m = String(imageMime || '').toLowerCase();
  if (!m.includes('jpeg') && !m.includes('jpg') && !m.includes('png')) {
    throw new Error('火山引擎 AI 消除仅支持 JPG、JPEG、PNG 原图');
  }
  const max = 5 * 1024 * 1024;
  if (imageBuffer.length > max) {
    throw new Error(`原图超过火山引擎限制（最大 ${max / 1024 / 1024}MB），请先压缩图片`);
  }
}

/**
 * @param {{ imageBuffer: Buffer; imageMime: string; maskBuffer: Buffer; dilateSize?: number }} opts
 * @returns {Promise<string>} task_id
 */
export async function createVolcInpaintTask(opts) {
  assertVolcInputLimits(opts.imageBuffer, opts.imageMime);
  const dilateSize =
    typeof opts.dilateSize === 'number' && Number.isFinite(opts.dilateSize)
      ? Math.max(0, Math.floor(opts.dilateSize))
      : 15;

  const svc = getVisualService();
  const submit = svc.createJSONAPI('CVSync2AsyncSubmitTask', { Version: '2022-08-31' });
  const body = {
    req_key: REQ_KEY,
    binary_data_base64: [opts.imageBuffer.toString('base64'), opts.maskBuffer.toString('base64')],
    steps: 30,
    strength: 0.8,
    seed: 0,
    dilate_size: dilateSize,
  };
  const res = await submit(body, { timeout: 180_000 });
  if (res.code !== 10000) {
    throw new Error(res.message || `火山提交任务失败（code=${res.code}）`);
  }
  const taskId = res.data?.task_id;
  if (!taskId) throw new Error('火山提交成功但未返回 task_id');
  return String(taskId);
}

/**
 * @param {string} taskId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ buf: Buffer; contentType: string }>}
 */
export async function pollVolcInpaintTaskAndDownload(taskId, options = {}) {
  const svc = getVisualService();
  const getResult = svc.createJSONAPI('CVSync2AsyncGetResult', { Version: '2022-08-31' });
  const reqJson = JSON.stringify({ return_url: true });
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 240_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await getResult(
      {
        req_key: REQ_KEY,
        task_id: taskId,
        req_json: reqJson,
      },
      { timeout: 120_000 }
    );
    if (res.code !== 10000) {
      throw new Error(res.message || `火山查询失败（code=${res.code}）`);
    }
    const data = res.data || {};
    const status = data.status;
    if (status === 'not_found' || status === 'expired') {
      throw new Error(`火山任务状态异常: ${status}`);
    }
    if (status === 'done') {
      const urls = data.image_urls;
      if (Array.isArray(urls) && urls[0]) {
        return downloadHttpBuffer(String(urls[0]));
      }
      const b64s = data.binary_data_base64;
      if (Array.isArray(b64s) && b64s[0]) {
        const buf = Buffer.from(String(b64s[0]), 'base64');
        return { buf, contentType: 'image/jpeg' };
      }
      throw new Error('火山任务完成但未返回图片（请稍后重试或更换通道）');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('火山 inpainting 任务超时');
}
