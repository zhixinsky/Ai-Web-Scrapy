/**
 * 文本 AI 模型统一封装。
 * - mimo：小米 MiMo（OpenAI 兼容 API）
 * - openai：OpenAI 官方 API
 *
 * 旧导出名保留为兼容层，现均指向当前 AI_PROVIDER。
 */
import OpenAI from 'openai';

const DEFAULT_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MIMO_MODEL = 'mimo-v2-flash';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_AI_REQUEST_TIMEOUT_MS = 75_000;

export function getAiProvider() {
  const p = String(process.env.AI_PROVIDER || process.env.TEXT_AI_PROVIDER || 'mimo')
    .trim()
    .toLowerCase();
  if (p === 'openai' || p === 'gpt') return 'openai';
  return 'mimo';
}

export function getAiModel(provider = getAiProvider(), model) {
  if (model != null && String(model).trim()) return String(model).trim();
  if (provider === 'openai') {
    return String(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
  }
  return String(process.env.MIMO_MODEL || DEFAULT_MIMO_MODEL).trim() || DEFAULT_MIMO_MODEL;
}

export function getAiRequestTimeoutMs() {
  const n = Number(process.env.AI_REQUEST_TIMEOUT_MS || process.env.MIMO_REQUEST_TIMEOUT_MS || 0);
  if (Number.isFinite(n) && n >= 5_000) return Math.min(Math.floor(n), 300_000);
  return DEFAULT_AI_REQUEST_TIMEOUT_MS;
}

export function isAiConfigured(provider = getAiProvider()) {
  if (provider === 'openai') return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  return Boolean(String(process.env.MIMO_API_KEY || '').trim());
}

export function getAiClient(provider = getAiProvider()) {
  if (!isAiConfigured(provider)) {
    throw new Error(provider === 'openai' ? '未配置 OPENAI_API_KEY' : '未配置 MIMO_API_KEY');
  }
  if (provider === 'openai') {
    const baseURL = String(process.env.OPENAI_BASE_URL || '').trim();
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
  }
  const baseURL = String(process.env.MIMO_BASE_URL || DEFAULT_MIMO_BASE_URL).trim() || DEFAULT_MIMO_BASE_URL;
  return new OpenAI({
    apiKey: process.env.MIMO_API_KEY,
    baseURL,
  });
}

/**
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string} [opts.model]
 * @param {number} [opts.max_completion_tokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.top_p]
 */
export async function aiChatCompletion({
  messages,
  model,
  max_completion_tokens,
  temperature,
  top_p,
} = {}) {
  const provider = getAiProvider();
  const client = getAiClient(provider);
  const modelResolved = getAiModel(provider, model);
  return client.chat.completions.create({
    model: modelResolved,
    messages,
    max_completion_tokens: max_completion_tokens ?? 1024,
    temperature: temperature ?? 1.0,
    top_p: top_p ?? 0.95,
    stream: false,
    stop: null,
    frequency_penalty: 0,
    presence_penalty: 0,
  }, {
    timeout: getAiRequestTimeoutMs(),
  });
}

export function isMimoConfigured() {
  return isAiConfigured();
}

export function getMimoClient() {
  return getAiClient();
}

export async function mimoChatCompletion(opts = {}) {
  return aiChatCompletion(opts);
}

/**
 * OpenAI 兼容返回里 message.content 可能为 string 或 part 数组（多模态）。
 * @param {any} completion
 */
export function extractMessageText(completion) {
  const msg = completion?.choices?.[0]?.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if ('text' in part && typeof part.text === 'string') return part.text;
          if ('content' in part && typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}
