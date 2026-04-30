/**
 * AI 涂抹消除：DashScope（百炼）与火山引擎视觉二选一 / 可配置优先与回退。
 * 环境变量：AI_ERASE_PROVIDER、AI_ERASE_FALLBACK，见 server/.env.example
 */

import {
  createImageEraseTask,
  downloadHttpBuffer,
  getDashscopeApiKey,
  pollImageEraseTask,
} from './dashscopeImageErase.js';
import {
  createVolcInpaintTask,
  isVolcImageEraseConfigured,
  pollVolcInpaintTaskAndDownload,
} from './volcengineImageErase.js';
import { isTencentAiartConfigured, runTencentImageInpaintingRemoval } from './tencentAiartInpaintingRemoval.js';
import { getStabilityApiKey, stabilityErase } from './stabilityImageErase.js';

export function normalizeAiEraseProvider(value) {
  const p = String(value || '').trim().toLowerCase();
  if (p === 'volc' || p === 'volcano' || p === 'volcengine') return 'volc';
  if (p === 'tencent' || p === 'tx' || p === 'qcloud') return 'tencent';
  if (p === 'stability' || p === 'stable' || p === 'stabilityai') return 'stability';
  return 'dashscope';
}

function normalizeFallbackFlag(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function isAiEraseProviderConfigured(provider) {
  const p = normalizeAiEraseProvider(provider);
  if (p === 'dashscope') return Boolean(getDashscopeApiKey());
  if (p === 'volc') return isVolcImageEraseConfigured();
  if (p === 'tencent') return isTencentAiartConfigured();
  if (p === 'stability') return Boolean(getStabilityApiKey());
  return false;
}

/**
 * 当前策略下是否至少有一个可用通道（用于 503 前置校验）。
 */
export function getAiEraseAvailability() {
  const primary = normalizeAiEraseProvider(process.env.AI_ERASE_PROVIDER || 'dashscope');
  const fallback = normalizeFallbackFlag(process.env.AI_ERASE_FALLBACK || '');
  const dash = Boolean(getDashscopeApiKey());
  const volc = isVolcImageEraseConfigured();
  const tx = isTencentAiartConfigured();
  const stb = Boolean(getStabilityApiKey());

  if (fallback) {
    if (!dash && !volc && !tx && !stb) {
      return {
        ok: false,
        message:
          '服务端未配置可用的 AI 消除：请配置 DASHSCOPE_API_KEY（百炼）和/或 VOLC_ACCESS_KEY_ID + VOLC_SECRET_ACCESS_KEY（火山）和/或 TENCENT_SECRET_ID + TENCENT_SECRET_KEY（腾讯）和/或 STABILITY_API_KEY（Stability.ai），并可用 AI_ERASE_FALLBACK=1 启用回退',
      };
    }
    return { ok: true };
  }
  if (primary === 'dashscope' && !dash) {
    return {
      ok: false,
      message:
        '服务端未配置 DASHSCOPE_API_KEY（当前 AI_ERASE_PROVIDER=dashscope）。若改用火山请设置 AI_ERASE_PROVIDER=volc 并配置 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY',
    };
  }
  if (primary === 'volc' && !volc) {
    return {
      ok: false,
      message:
        '服务端未配置火山 AK/SK（当前 AI_ERASE_PROVIDER=volc）。请设置 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY，或改用 AI_ERASE_PROVIDER=dashscope 并配置 DASHSCOPE_API_KEY',
    };
  }
  if (primary === 'tencent' && !tx) {
    return {
      ok: false,
      message:
        '服务端未配置腾讯云密钥（当前 AI_ERASE_PROVIDER=tencent）。请设置 TENCENT_SECRET_ID 与 TENCENT_SECRET_KEY（可选 TENCENT_AIART_REGION），或改用其他通道',
    };
  }
  if (primary === 'stability' && !stb) {
    return {
      ok: false,
      message: '服务端未配置 STABILITY_API_KEY（当前 AI_ERASE_PROVIDER=stability）。请设置 STABILITY_API_KEY，或改用其他通道',
    };
  }
  return { ok: true };
}

/**
 * @param {{ imageBuffer: Buffer; imageMime: string; maskBuffer: Buffer; fastMode?: boolean; dilateFlag?: boolean; addWatermark?: boolean; provider?: string; fallback?: any }} opts
 * @returns {Promise<{ buf: Buffer; contentType: string; provider: 'dashscope' | 'volc' | 'tencent' | 'stability' }>}
 */
export async function runImageErase(opts) {
  const override = opts?.provider ? normalizeAiEraseProvider(opts.provider) : null;
  const primary = override || normalizeAiEraseProvider(process.env.AI_ERASE_PROVIDER || 'dashscope');
  const fallback = opts?.fallback != null ? normalizeFallbackFlag(opts.fallback) : normalizeFallbackFlag(process.env.AI_ERASE_FALLBACK || '');
  const order =
    primary === 'volc'
      ? fallback
        ? ['volc', 'dashscope', 'tencent', 'stability']
        : ['volc']
      : primary === 'tencent'
        ? fallback
          ? ['tencent', 'dashscope', 'volc', 'stability']
          : ['tencent']
        : primary === 'stability'
          ? fallback
            ? ['stability', 'dashscope', 'volc', 'tencent']
            : ['stability']
        : fallback
          ? ['dashscope', 'volc', 'tencent', 'stability']
          : ['dashscope'];

  let lastErr;
  for (const prov of order) {
    try {
      if (prov === 'dashscope') {
        if (!getDashscopeApiKey()) throw new Error('未配置 DASHSCOPE_API_KEY');
        const taskId = await createImageEraseTask({
          imageBuffer: opts.imageBuffer,
          imageMime: opts.imageMime,
          maskBuffer: opts.maskBuffer,
          fastMode: opts.fastMode !== false,
          dilateFlag: opts.dilateFlag === true,
          addWatermark: opts.addWatermark === true,
        });
        const outUrl = await pollImageEraseTask(taskId, { timeoutMs: 240_000 });
        const { buf, contentType } = await downloadHttpBuffer(outUrl);
        return { buf, contentType, provider: 'dashscope' };
      }
      if (prov === 'volc') {
        if (!isVolcImageEraseConfigured()) throw new Error('未配置火山 AK/SK');
        const dilateSize = opts.dilateFlag === true ? 24 : 15;
        const taskId = await createVolcInpaintTask({
          imageBuffer: opts.imageBuffer,
          imageMime: opts.imageMime,
          maskBuffer: opts.maskBuffer,
          dilateSize,
        });
        const { buf, contentType } = await pollVolcInpaintTaskAndDownload(taskId, { timeoutMs: 240_000 });
        return { buf, contentType, provider: 'volc' };
      }
      if (prov === 'tencent') {
        if (!isTencentAiartConfigured()) throw new Error('未配置腾讯云密钥');
        const { buf, contentType } = await runTencentImageInpaintingRemoval({
          imageBuffer: opts.imageBuffer,
          maskBuffer: opts.maskBuffer,
        });
        return { buf, contentType, provider: 'tencent' };
      }
      if (prov === 'stability') {
        if (!getStabilityApiKey()) throw new Error('未配置 STABILITY_API_KEY');
        const { buf, contentType } = await stabilityErase({
          imageBuffer: opts.imageBuffer,
          imageMime: opts.imageMime,
          maskBuffer: opts.maskBuffer,
        });
        return { buf, contentType, provider: 'stability' };
      }
    } catch (e) {
      lastErr = e;
      if (order.length > 1 && order.indexOf(prov) < order.length - 1) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('AI 消除失败');
}
