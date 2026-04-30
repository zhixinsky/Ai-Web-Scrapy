/**
 * 采集入库后：对通用数据做 MiMo 二次处理，整条链路由采集记录的 export_dest_platform_id
 * 解析出的 enrich 平台键（与管理员「内部 id → 规则键」映射一致）统一驱动：
 * 标题、五点描述、颜色/sku_axes、详情段翻译、搜索关键字。
 * 主图/副图为 URL 标准化（无 MiMo），在 generic→平台数据 定型时执行。
 */
import { isMimoConfigured, mimoChatCompletion, extractMessageText } from './mimo.js';
import {
  getPlatformTitleSystemPrompt,
  getPlatformDescSystemPrompt,
  getPlatformDescFromTitleSystemPrompt,
  getPlatformColorBatchSystemPrompt,
  getPlatformColorSingleLineSystemPrompt,
  getPlatformDetailTranslateSystemPrompt,
  getPlatformSearchKeywordsSystemPrompt,
} from './prompts.js';
import {
  normalizeTitleText,
  normalizeDescLines,
  normalizeAmazonSearchKeywordsText,
  containsChinese,
  parseColorTranslateOutput,
  parseSingleLineColorOutput,
  truncateColorLine,
} from './responseNormalize.js';

function getAiConcurrency() {
  const v = Number(process.env.MIMO_AI_CONCURRENCY ?? 2);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(6, Math.floor(v));
}

function clampTitleToLength(value, maxLength = 120) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (title.length <= maxLength) return title;
  const cut = title.slice(0, maxLength).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= 80 ? cut.slice(0, lastSpace) : cut).replace(/[,\-–—:;]+$/, '').trim();
}

/**
 * 简单并发控制（无依赖）
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 按 maxLines / maxChars 切分多行，避免单次 prompt 过大拖慢
 * @param {string[]} lines
 * @param {{ maxLines: number, maxChars: number }} opts
 * @returns {{ start: number, lines: string[] }[]}
 */
function chunkLines(lines, opts) {
  const maxLines = Math.max(1, Number(opts?.maxLines ?? 100));
  const maxChars = Math.max(200, Number(opts?.maxChars ?? 8000));
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    // 尝试在 maxLines 限制下，进一步用字符数控制
    while (end > start + 1) {
      const s = lines.slice(start, end).join('\n');
      if (s.length <= maxChars) break;
      end -= 1;
    }
    chunks.push({ start, lines: lines.slice(start, end) });
    start = end;
  }
  return chunks;
}

function deepCloneRows(rows) {
  return JSON.parse(JSON.stringify(rows));
}

function sharedRowIndex(rows) {
  const idx = rows.findIndex((r) => r && r['父子关系'] === 'parent');
  if (idx >= 0) return idx;
  return 0;
}

function getTitleFromRows(rows) {
  for (const r of rows) {
    const t = r['标题'] ?? r['商品标题'];
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return '';
}

function compactPromptValue(value, maxChars = 6000) {
  const s = String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars).trim()}\n...`;
}

function renderCollectionPrompt(template, vars = {}) {
  let s = String(template ?? '');
  for (const [key, value] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), compactPromptValue(value));
  }
  return s;
}

function getDetailContextFromRows(rows) {
  if (!Array.isArray(rows)) return '';
  const lines = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const [key, val] of Object.entries(r)) {
      if (!key.includes('详情')) continue;
      if (key === '详情图' || key.startsWith('详情图')) continue;
      const coerced = coerceDetailFieldValueToBrString(val);
      if (coerced == null || !coerced.trim()) continue;
      const normalized = compactPromptValue(coerced, 2000);
      if (!normalized) continue;
      const line = `${key}: ${normalized}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return compactPromptValue(lines.join('\n'), 6000);
}

/** 与前台 readDescriptions 一致 */
function readDescriptionEntries(row) {
  const blocks = [];
  if (!row || typeof row !== 'object') return blocks;
  for (const [k, v] of Object.entries(row)) {
    if (!k.includes('描述') || k.includes('详情')) continue;
    if (Array.isArray(v)) {
      blocks.push({ key: k, lines: v.map((x) => String(x ?? '')) });
    } else if (typeof v === 'string') {
      blocks.push({ key: k, lines: v ? [v] : [''] });
    }
  }
  if (!blocks.length && row['描述'] != null) {
    const v = row['描述'];
    if (Array.isArray(v)) blocks.push({ key: '描述', lines: v.map(String) });
    else if (typeof v === 'string') blocks.push({ key: '描述', lines: [v] });
  }
  return blocks;
}

/** 汇总行上所有「描述」类字段是否均无实质内容（与 readDescriptionEntries 范围一致） */
function isDescriptionContentEmpty(row) {
  const blocks = readDescriptionEntries(row);
  if (!blocks.length) return true;
  for (const b of blocks) {
    if (b.lines.join('\n').trim()) return false;
  }
  return true;
}

/** 写入描述时优先使用已有描述字段的键；否则用「描述」 */
function getPrimaryDescriptionKey(row) {
  const blocks = readDescriptionEntries(row);
  if (blocks.length) return blocks[0].key;
  return '描述';
}

export function isMimoAutoEnrichEnabled() {
  if (!isMimoConfigured()) return false;
  const v = String(process.env.MIMO_AUTO_ENRICH ?? '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/** AI 二次处理所用平台键（默认 amazon） */
function getMimoEnrichTitlePlatformKey() {
  return String(process.env.MIMO_ENRICH_PLATFORM ?? 'amazon')
    .trim()
    .toLowerCase() || 'amazon';
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ enrichPlatformKey?: string }} [options] enrichPlatformKey：管理员映射的提示词平台键（如 amazon），缺省读环境变量
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function enrichCollectedRowsWithAi(rows, options = {}) {
  if (!isMimoAutoEnrichEnabled() || !Array.isArray(rows) || rows.length === 0) {
    return rows;
  }

  const titleKey =
    typeof options.enrichPlatformKey === 'string' && options.enrichPlatformKey.trim()
      ? options.enrichPlatformKey.trim().toLowerCase()
      : getMimoEnrichTitlePlatformKey();
  const promptUserId = options.userId;

  const out = deepCloneRows(rows);
  const titleIn = getTitleFromRows(out);
  const detailIn = getDetailContextFromRows(out);

  const sharedIdx = sharedRowIndex(out);
  const shared = out[sharedIdx];
  if (!shared || typeof shared !== 'object') return out;

  const concurrency = getAiConcurrency();
  /** @type {Array<() => Promise<any>>} */
  const tasks = [];

  // 标题、描述可以并行请求（写回时再按结果应用）
  if (titleIn) {
    tasks.push(
      async () => {
        try {
          const completion = await mimoChatCompletion({
            messages: [
              {
                role: 'system',
                content: renderCollectionPrompt(getPlatformTitleSystemPrompt(titleKey, promptUserId), {
                  title: titleIn,
                  detail: detailIn,
                }),
              },
              { role: 'user', content: titleIn },
            ],
            max_completion_tokens: 180,
            temperature: 0.6,
          });
          const text = extractMessageText(completion);
          let newTitle = normalizeTitleText(text).trim();
          if (newTitle && (newTitle.length < 80 || newTitle.length > 120)) {
            const retry = await mimoChatCompletion({
              messages: [
                {
                  role: 'system',
                  content: renderCollectionPrompt(getPlatformTitleSystemPrompt(titleKey, promptUserId), {
                    title: titleIn,
                    detail: detailIn,
                  }),
                },
                {
                  role: 'user',
                  content:
                    `Rewrite the product title to be 80-120 characters long, natural English, and SEO-friendly. ` +
                    `Only output the final title.\n\nOriginal source title:\n${titleIn}\n\nInvalid draft (${newTitle.length} characters):\n${newTitle}`,
                },
              ],
              max_completion_tokens: 180,
              temperature: 0.6,
            });
            const retryTitle = normalizeTitleText(extractMessageText(retry)).trim();
            if (retryTitle.length >= 80) newTitle = retryTitle;
          }
          newTitle = clampTitleToLength(newTitle, 120);
          return { kind: 'title', value: newTitle || null };
        } catch (e) {
          console.error('[collectionAuto] title enrich failed', e);
          return { kind: 'title', value: null };
        }
      }
    );
  }

  const descBlocks = readDescriptionEntries(shared);
  for (const b of descBlocks) {
    const raw = b.lines.join('\n').trim();
    if (!raw) continue;
    tasks.push(
      async () => {
        try {
          const completion = await mimoChatCompletion({
            messages: [
              {
                role: 'system',
                content: renderCollectionPrompt(getPlatformDescSystemPrompt(titleKey, promptUserId), {
                  title: titleIn,
                  bullets: raw,
                  detail: detailIn,
                }),
              },
              {
                role: 'user',
                content: `Raw source text (any number of lines; synthesize into exactly five English bullets per the rules):\n\n${raw}`,
              },
            ],
            max_completion_tokens: 2048,
          });
          const text = extractMessageText(completion);
          const lines = normalizeDescLines(text);
          return { kind: 'desc', key: b.key, value: lines.length ? lines : null };
        } catch (e) {
          console.error('[collectionAuto] desc enrich failed', b.key, e);
          return { kind: 'desc', key: b.key, value: null };
        }
      }
    );
  }

  if (tasks.length) {
    const results = await mapWithConcurrency(tasks, concurrency, (fn) => fn());
    for (const r of results) {
      if (!r) continue;
      if (r.kind === 'title' && r.value) {
        for (const row of out) {
          if (row && typeof row === 'object') row['标题'] = r.value;
        }
      } else if (r.kind === 'desc' && r.value && r.key) {
        shared[r.key] = r.value;
      }
    }
  }

  if (isDescriptionContentEmpty(shared)) {
    const titleForDesc = getTitleFromRows(out);
    if (titleForDesc) {
      try {
        const completion = await mimoChatCompletion({
          messages: [
            {
              role: 'system',
              content: renderCollectionPrompt(getPlatformDescFromTitleSystemPrompt(titleKey, promptUserId), {
                title: titleForDesc,
                bullets: '',
                detail: detailIn,
              }),
            },
            {
              role: 'user',
              content: `Product title:\n${titleForDesc}`,
            },
          ],
          max_completion_tokens: 2048,
        });
        const text = extractMessageText(completion);
        const lines = normalizeDescLines(text);
        if (lines.length > 0) {
          const descKey = getPrimaryDescriptionKey(shared);
          shared[descKey] = lines;
        }
      } catch (e) {
        console.error('[collectionAuto] desc from title failed', e);
      }
    }
  }

  return out;
}

/**
 * 单行颜色 → MiMo，输出强制取首行，避免多行同义拆分
 * @param {string} line
 * @param {string} enrichPlatformKey
 * @returns {Promise<string | null>}
 */
async function translateSingleColorLine(line, enrichPlatformKey) {
  const completion = await mimoChatCompletion({
    messages: [
      {
        role: 'system',
        content: getPlatformColorSingleLineSystemPrompt(enrichPlatformKey),
      },
      { role: 'user', content: line },
    ],
    max_completion_tokens: 128,
    temperature: 0.2,
  });
  const text = extractMessageText(completion);
  return parseSingleLineColorOutput(text);
}

/**
 * 多行颜色文本 → MiMo 翻译；批量输出行数须与输入一致，否则逐行重试以保证行数准确
 * @param {string} multiline
 * @param {string} enrichPlatformKey
 * @returns {Promise<string | null>}
 */
async function translateColorMultilineString(multiline, enrichPlatformKey) {
  const linesIn = String(multiline).split(/\r?\n/);
  const expectedCount = linesIn.length;
  if (expectedCount < 1) return null;

  const completion = await mimoChatCompletion({
    messages: [
      {
        role: 'system',
        content: getPlatformColorBatchSystemPrompt(enrichPlatformKey),
      },
      { role: 'user', content: multiline },
    ],
    max_completion_tokens: 512,
    temperature: 0.2,
  });
  const text = extractMessageText(completion);
  const parsed = parseColorTranslateOutput(text, expectedCount);
  if (parsed) return parsed.join('\n');

  console.warn('[collectionAuto] color batch line count mismatch, retry line-by-line', {
    expected: expectedCount,
    preview: String(text).slice(0, 200),
  });

  const outLines = [];
  for (let i = 0; i < expectedCount; i++) {
    const lineTrim = linesIn[i].trim();
    if (!lineTrim) {
      outLines.push('');
      continue;
    }
    try {
      const one = await translateSingleColorLine(lineTrim, enrichPlatformKey);
      if (one == null) {
        console.error('[collectionAuto] color single-line translate failed', { line: lineTrim });
        return null;
      }
      outLines.push(one);
    } catch (e) {
      console.error('[collectionAuto] color single-line translate error', e);
      return null;
    }
  }
  return outLines.join('\n');
}

/**
 * 统一详情键值格式：英文更可读，保持 Key: Value（冒号后恰好 1 个空格）
 * @param {string} line
 */
function normalizeDetailColonSpacing(line) {
  const s = String(line ?? '').trim();
  if (!s) return s;
  // 规则：
  // - 若为 "Key:" 结尾，不加空格
  // - 若为 "Key:Value" / "Key:   Value"，归一为 "Key: Value"
  const noTrail = s.replace(/([:：])\s*$/, '$1');
  return noTrail.replace(/([:：])\s*(\S)/g, '$1 $2').trim();
}

/**
 * 整段详情（含 <br>）一次性翻译：最快路径。
 * 要求：输出仍为单行、用 <br> 分段，段数与输入一致；失败则返回 null 交由兜底处理。
 * @param {string} brText
 * @param {string} enrichPlatformKey
 * @returns {Promise<string | null>}
 */
async function translateDetailWholeBrString(brText, enrichPlatformKey) {
  const segsIn = splitDetailToNonEmptyLines(brText);
  if (!segsIn.length) return null;
  if (!segsIn.some((s) => containsChinese(s))) return segsIn.map(normalizeDetailColonSpacing).join('<br>');

  // 单行输入：用 <br> 串联（不带末尾多余 <br>）
  const input = segsIn.join('<br>');
  const completion = await mimoChatCompletion({
    messages: [
      { role: 'system', content: getPlatformDetailTranslateSystemPrompt(enrichPlatformKey) },
      { role: 'user', content: input },
    ],
    // 详情整段翻译可能较长，给足输出空间；若仍截断会走兜底
    max_completion_tokens: 8192,
    temperature: 0.2,
  });
  let out = String(extractMessageText(completion) ?? '').trim();
  if (!out) return null;

  // 兼容：模型偶发用换行代替 <br>
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/<br\s*\/?>/i.test(out) && out.includes('\n')) {
    out = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('<br>');
  }

  const segsOut = out
    .split(/<br\s*\/?>/gi)
    .map((s) => String(s ?? '').trim())
    .filter((s) => s !== '');

  if (segsOut.length !== segsIn.length) return null;
  // 若仍含中文，认为不合格，交由更严格兜底
  if (segsOut.some((s) => containsChinese(s))) return null;

  return segsOut.map(normalizeDetailColonSpacing).join('<br>');
}

/**
 * 多行详情段（每行对应原 br 一段）→ MiMo 翻译；行数须与输出一致
 * @param {string[]} lines
 * @param {{ max_completion_tokens?: number }} [opts]
 * @returns {Promise<string[] | null>}
 */
async function translateDetailSegmentsBatch(lines, opts = {}) {
  const expectedCount = lines.length;
  if (expectedCount < 1) return null;
  const userContent = lines.join('\n');
  /**
   * 详情翻译输出解析：比颜色更宽松。
   * 模型偶发会把某一段翻译“折行”，导致行数 > expectedCount；此时尝试合并回 expectedCount。
   * @param {string} raw
   * @param {number} expected
   * @returns {string[] | null}
   */
  function parseDetailTranslateOutput(raw, expected) {
    if (expected < 1) return [];
    let s = String(raw ?? '');
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!s) return null;

    // 有些模型会用 <br> 代替换行
    if (/<br\s*\/?>/i.test(s)) {
      s = s.replace(/<br\s*\/?>/gi, '\n');
    }

    let out = s
      .split('\n')
      .map((l) => String(l ?? '').trim())
      .filter((l) => l !== '');

    if (out.length === expected) return out;
    if (out.length < expected) return null;

    // out.length > expected：尝试把多出来的行合并回前一行（通常是折行造成）
    while (out.length > expected) {
      // 把最后一行并到倒数第二行，优先减少尾部折行
      const tail = out.pop();
      if (tail == null) break;
      if (out.length === 0) return null;
      out[out.length - 1] = `${out[out.length - 1]} ${tail}`.replace(/\s+/g, ' ').trim();
    }
    return out.length === expected ? out : null;
  }
  const detailKey =
    typeof opts.enrichPlatformKey === 'string' && opts.enrichPlatformKey.trim()
      ? opts.enrichPlatformKey.trim().toLowerCase()
      : getMimoEnrichTitlePlatformKey();
  const completion = await mimoChatCompletion({
    messages: [
      { role: 'system', content: getPlatformDetailTranslateSystemPrompt(detailKey) },
      { role: 'user', content: userContent },
    ],
    max_completion_tokens: opts.max_completion_tokens ?? 8192,
    temperature: 0.3,
  });
  const text = extractMessageText(completion);
  const parsed = parseDetailTranslateOutput(text, expectedCount);
  if (!parsed) {
    console.warn('[collectionAuto] detail translate segment count mismatch', {
      expected: expectedCount,
      preview: String(text).slice(0, 200),
    });
    // 批量输出不稳定（常被截断少行），这里兜底逐行翻译，确保行数对齐
    try {
      const concurrency = Math.min(getAiConcurrency(), 3);
      const system0 = getPlatformDetailTranslateSystemPrompt(detailKey);
      const outLines = await mapWithConcurrency(lines, concurrency, async (line) => {
        const src = String(line ?? '').trim();
        if (!src) return null;
        // 已无中文则直接保留（只做格式归一）
        if (!containsChinese(src)) return normalizeDetailColonSpacing(src);
        const completion1 = await mimoChatCompletion({
          messages: [
            {
              role: 'system',
              content:
                `${system0}\n\nIMPORTANT:\n- Output must contain no Chinese characters.\n- Output exactly one line.\n`,
            },
            { role: 'user', content: src },
          ],
          max_completion_tokens: 256,
          temperature: 0.1,
        });
        const t1 = String(extractMessageText(completion1) ?? '').trim();
        const firstLine = t1
          .replace(/<br\s*\/?>/gi, '\n')
          .split('\n')
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)[0];
        if (!firstLine) return normalizeDetailColonSpacing(src);
        const norm = normalizeDetailColonSpacing(firstLine);
        // 逐行兜底不再“全有或全无”：该行若仍含中文，则保留原文，避免整段回退失败导致完全不写回
        if (!norm || containsChinese(norm)) return normalizeDetailColonSpacing(src);
        return norm;
      });
      if (outLines.length !== expectedCount) return null;
      if (outLines.some((x) => x == null)) return null;
      return /** @type {string[]} */ (outLines);
    } catch (e) {
      console.error('[collectionAuto] detail translate per-line fallback failed', e);
      return null;
    }
  }
  return parsed.map(normalizeDetailColonSpacing);
}

/**
 * 详情字符串（按 br 分段）→ MiMo 翻译；段数须与模型输出行数一致，否则放弃替换
 * @param {string} brText
 * @returns {Promise<string | null>}
 */
/**
 * 亚马逊合并后的详情常为 `A:1<br>B:2<br>`，按 br 拆分时末尾会产生空串；
 * 若把空行送进 MiMo，模型常少输一行，parse 行数不一致则整段翻译失败。
 * @param {string} brText
 * @returns {string[]}
 */
function splitDetailToNonEmptyLines(brText) {
  // 编辑器里用户可能直接输入真实换行（\n），而不是 <br>；
  // 若只按 <br> 拆分，会导致 expectedCount=1，但模型常输出多行，从而整段翻译被放弃。
  // 这里统一把 <br> 与换行都当作分段符，保证段数对齐更稳。
  const normalized = String(brText)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return normalized
    .split('\n')
    .map((p) => String(p ?? '').trim())
    .filter((line) => line.length > 0);
}

async function translateDetailBrString(brText, enrichPlatformKey) {
  const userLines = splitDetailToNonEmptyLines(brText);
  if (!userLines.length) return null;
  const parsed = await translateDetailSegmentsBatch(userLines, {
    // 详情字段常较长，2048 容易被截断导致行数不足，从而整段放弃替换
    max_completion_tokens: 4096,
    enrichPlatformKey,
  });
  if (!parsed) return null;
  return parsed.join('<br>');
}

/**
 * 单段详情（单行）翻译：用于批量失败时的更稳回退。
 * @param {string} line
 * @param {string} enrichPlatformKey
 * @returns {Promise<string | null>}
 */
async function translateDetailSingleLine(line, enrichPlatformKey) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  const parsed = await translateDetailSegmentsBatch([trimmed], {
    max_completion_tokens: 512,
    enrichPlatformKey,
  });
  if (!parsed || !parsed.length) return null;
  const out0 = String(parsed[0] ?? '').trim();
  if (!out0) return null;
  if (!containsChinese(out0)) return normalizeDetailColonSpacing(out0);

  // 兜底重试：模型偶发会保留中文属性名（如“适用场景”），这里强制英文且只允许单行输出。
  try {
    const system0 = getPlatformDetailTranslateSystemPrompt(enrichPlatformKey);
    const completion = await mimoChatCompletion({
      messages: [
        {
          role: 'system',
          content:
            `${system0}\n\nIMPORTANT:\n- Output must contain no Chinese characters.\n- Output exactly one line.\n`,
        },
        { role: 'user', content: trimmed },
      ],
      max_completion_tokens: 256,
      temperature: 0.1,
    });
    const text = extractMessageText(completion);
    const parsed2 = [String(text ?? '').trim()].filter(Boolean);
    if (parsed2.length !== 1) return null;
    const out1 = String(parsed2[0] ?? '').trim();
    if (!out1 || containsChinese(out1)) return null;
    return normalizeDetailColonSpacing(out1);
  } catch {
    return null;
  }
}

/**
 * 详情字段：string 按既有 &lt;br&gt; 分段；string[] 视为多段（每元素一段，常见于插件），拼接后再参与翻译/合并。
 * @param {unknown} val
 * @returns {string | null}
 */
export function coerceDetailFieldValueToBrString(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val
      .map((x) => String(x ?? '').replace(/\r?\n/g, ' ').trim())
      .filter(Boolean)
      .join('<br>');
  }
  return null;
}

/**
 * 将所有行中含中文的「详情」字段按 br 段展开为一条多行列表，便于单次 MiMo 翻译后写回。
 * @param {unknown[]} rows
 * @returns {{ flatLines: string[], owners: { rowIdx: number, key: string }[] }}
 */
// collectionAuto.js 中的对应函数修改建议：
export function flattenRowDetailBrSegments(rows) {
  const flatLines = [];
  const owners = [];
  if (!Array.isArray(rows)) return { flatLines, owners };
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx];
    if (!r || typeof r !== 'object') continue;
    for (const [key, val] of Object.entries(r)) {
      // 保持只处理包含“详情”的字段
      if (!key.includes('详情')) continue;
      
      // 注意：由于清洗脚本已经删除了 _value_xpath，这里的判断依然安全
      if (key.endsWith('_value_xpath')) continue; 

      const coerced = coerceDetailFieldValueToBrString(val);
      if (coerced == null || !coerced.trim()) continue;

      // 关键：清洗后的数据现在是 "面料: 涤纶<br>风格: 休闲"
      // 这里的 containsChinese 会正确识别出其中的中文并加入翻译队列
      if (!containsChinese(coerced)) continue;

      for (const line of splitDetailToNonEmptyLines(coerced)) {
        flatLines.push(line);
        owners.push({ rowIdx, key });
      }
    }
  }
  return { flatLines, owners };
}

/**
 * @param {unknown[]} rows
 * @param {{ rowIdx: number, key: string }[]} owners
 * @param {string[]} translatedLines
 */
function writeBackRowDetails(rows, owners, translatedLines) {
  if (!owners.length || owners.length !== translatedLines.length) return false;
  const byComposite = new Map();
  for (let i = 0; i < owners.length; i++) {
    const { rowIdx, key } = owners[i];
    const composite = `${rowIdx}\t${key}`;
    if (!byComposite.has(composite)) byComposite.set(composite, []);
    byComposite.get(composite).push(translatedLines[i]);
  }
  for (const [composite, segs] of byComposite) {
    const tab = composite.indexOf('\t');
    const rowIdx = Number(composite.slice(0, tab));
    const key = composite.slice(tab + 1);
    if (!rows[rowIdx] || typeof rows[rowIdx] !== 'object') continue;
    rows[rowIdx][key] = segs.join('<br>');
  }
  return true;
}

async function translateCollectionDetailsPerFieldFallback(rows, enrichPlatformKey) {
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const [key, val] of Object.entries(r)) {
      if (!key.includes('详情')) continue;
      if (key.endsWith('_value_xpath')) continue;
      const coerced = coerceDetailFieldValueToBrString(val);
      if (coerced == null || !coerced.trim()) continue;
      if (!containsChinese(coerced)) continue;
      try {
        // 更稳：逐段翻译，避免模型不按行输出导致整段放弃
        const segs = splitDetailToNonEmptyLines(coerced);
        if (!segs.length) continue;
        const out = [];
        let translatedCount = 0;
        for (const seg of segs) {
          const s = String(seg ?? '').trim();
          if (!s) continue;
          if (!containsChinese(s)) {
            out.push(s);
            continue;
          }
          const one = await translateDetailSingleLine(s, enrichPlatformKey);
          if (one == null) out.push(normalizeDetailColonSpacing(s));
          else {
            out.push(one);
            translatedCount += 1;
          }
        }
        // 只要有任一段成功翻译，就写回（失败段保持原文），避免“某一段失败导致整条详情完全不翻译”
        if (out.length === segs.length && out.length > 0 && translatedCount > 0) {
          r[key] = out.join('<br>');
        }
      } catch (e) {
        console.error('[collectionAuto] detail translate failed', key, e);
      }
    }
  }
}

/**
 * 采集入库后：各 row 中键名含「详情」且值为 string 或 string[]、含中文时译为英文（保留 br 分段数）。
 * 所有待译详情段的 br 行合并为一次请求；失败时回退为逐字段翻译。
 * 受 MIMO_AUTO_ENRICH 与 MIMO_API_KEY 控制。
 * @param {Record<string, unknown>} data
 * @param {{ enrichPlatformKey?: string }} [options] 与标题/颜色同源（由 export_dest_platform_id 解析）
 */
export async function translateCollectionDetailsWithAi(data, options = {}) {
  if (!isMimoAutoEnrichEnabled() || !isMimoConfigured()) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  if (!Array.isArray(data.rows)) return;

  const enrichPlatformKey =
    typeof options.enrichPlatformKey === 'string' && options.enrichPlatformKey.trim()
      ? options.enrichPlatformKey.trim().toLowerCase()
      : getMimoEnrichTitlePlatformKey();

  // 最快路径：逐字段整段翻译（保持 <br>），成功即写回；失败再走批量/兜底
  try {
    for (const r of data.rows) {
      if (!r || typeof r !== 'object') continue;
      for (const [key, val] of Object.entries(r)) {
        if (!key.includes('详情')) continue;
        if (key === '详情图' || key.startsWith('详情图')) continue;
        if (key.endsWith('_value_xpath')) continue;
        const coerced = coerceDetailFieldValueToBrString(val);
        if (coerced == null || !coerced.trim()) continue;
        if (!containsChinese(coerced)) continue;
        const translated = await translateDetailWholeBrString(coerced, enrichPlatformKey);
        if (translated != null) r[key] = translated;
      }
    }
    // 若整段翻译已完成（所有详情均无中文），可直接返回，避免额外批量请求
    let anyChineseLeft = false;
    for (const r of data.rows) {
      if (!r || typeof r !== 'object') continue;
      for (const [key, val] of Object.entries(r)) {
        if (!key.includes('详情')) continue;
        if (key === '详情图' || key.startsWith('详情图')) continue;
        if (key.endsWith('_value_xpath')) continue;
        const coerced = coerceDetailFieldValueToBrString(val);
        if (coerced && containsChinese(coerced)) {
          anyChineseLeft = true;
          break;
        }
      }
      if (anyChineseLeft) break;
    }
    if (!anyChineseLeft) return;
  } catch (e) {
    console.warn('[collectionAuto] whole detail translate failed, fallback to batch', e);
  }

  const { flatLines, owners } = flattenRowDetailBrSegments(data.rows);
  if (!flatLines.length) return;

  try {
    const chunks = chunkLines(flatLines, { maxLines: 80, maxChars: 8000 });
    const concurrency = getAiConcurrency();
    const translatedChunks = await mapWithConcurrency(chunks, concurrency, async (ch) => {
      const parsed = await translateDetailSegmentsBatch(ch.lines, {
        // 详情段数多时需要更高输出上限，否则模型常只返回前几行，触发行数不一致
        max_completion_tokens: 8192,
        enrichPlatformKey,
      });
      if (!parsed) return null;
      if (parsed.length !== ch.lines.length) return null;
      return parsed;
    });
    if (!translatedChunks.some((x) => x == null)) {
      const merged = translatedChunks.flat();
      if (merged.length === flatLines.length && writeBackRowDetails(data.rows, owners, merged)) {
        return;
      }
    }
    console.warn('[collectionAuto] batch detail translate failed (chunked), fallback per field', {
      chunks: chunks.length,
    });
  } catch (e) {
    console.error('[collectionAuto] batch detail translate failed', e);
  }

  await translateCollectionDetailsPerFieldFallback(data.rows, enrichPlatformKey);
}

/**
 * 平台数据：根据当前商品标题（经标题 AI 与亚马逊加工后的文案）生成「搜索关键字」，写入汇总行。
 * 须在 {@link genericToAmazonPlatformData} 与 {@link translateCollectionDetailsWithAi} 之后调用。
 * @param {Record<string, unknown>} data
 * @param {{ enrichPlatformKey?: string }} [options] 与标题/详情同源
 */
export async function generateCollectionSearchKeywordsWithAi(data, options = {}) {
  if (!isMimoAutoEnrichEnabled() || !isMimoConfigured()) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  if (!Array.isArray(data.rows) || data.rows.length === 0) return;

  const enrichPlatformKey =
    typeof options.enrichPlatformKey === 'string' && options.enrichPlatformKey.trim()
      ? options.enrichPlatformKey.trim().toLowerCase()
      : getMimoEnrichTitlePlatformKey();
  const promptUserId = options.userId;

  const title = getTitleFromRows(data.rows);
  if (!title.trim()) return;
  const detail = getDetailContextFromRows(data.rows);

  try {
    const completion = await mimoChatCompletion({
      messages: [
        {
          role: 'system',
          content: renderCollectionPrompt(getPlatformSearchKeywordsSystemPrompt(enrichPlatformKey, promptUserId), {
            title,
            detail,
          }),
        },
        { role: 'user', content: title },
      ],
      max_completion_tokens: 512,
      temperature: 0.3,
    });
    const text = extractMessageText(completion);
    const line = normalizeAmazonSearchKeywordsText(text);
    if (!line) {
      console.warn('[collectionAuto] search keywords: empty model output');
      return;
    }
    const idx = sharedRowIndex(data.rows);
    const row = data.rows[idx];
    if (!row || typeof row !== 'object') return;
    data.rows[idx] = { ...row, 搜索关键字: line };
  } catch (e) {
    console.error('[collectionAuto] search keywords generation failed', e);
  }
}

/**
 * 将所有行「颜色」「Color」字段按行展开为一条列表，便于单次 MiMo 翻译后再按 owners 写回。
 * 支持 string（按换行拆）与 string[]（插件常见：多色列表），二者写回时分别还原为换行串或数组。
 * @param {unknown[]} rows
 * @returns {{ flatLines: string[], owners: { rowIdx: number, key: string, mode: 'lines' | 'array' }[] }}
 */
export function flattenRowColorFields(rows) {
  const flatLines = [];
  const owners = [];
  if (!Array.isArray(rows)) return { flatLines, owners };
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx];
    if (!r || typeof r !== 'object') continue;
    for (const key of ['颜色', 'Color']) {
      if (!(key in r)) continue;
      const c = r[key];
      if (typeof c === 'string') {
        if (!c.trim()) continue;
        const parts = c.split(/\r?\n/);
        for (const p of parts) {
          flatLines.push(truncateColorLine(p));
          owners.push({ rowIdx, key, mode: 'lines' });
        }
      } else if (Array.isArray(c) && c.length) {
        for (const item of c) {
          const p = String(item ?? '').trim();
          flatLines.push(p ? truncateColorLine(p) : '');
          owners.push({ rowIdx, key, mode: 'array' });
        }
      }
    }
  }
  return { flatLines, owners };
}

/**
 * @param {unknown[]} rows
 * @param {{ rowIdx: number, key: string, mode?: 'lines' | 'array' }[]} owners
 * @param {string[]} translatedLines
 */
export function writeBackRowColors(rows, owners, translatedLines) {
  if (!owners.length || owners.length !== translatedLines.length) return false;
  const byComposite = new Map();
  for (let i = 0; i < owners.length; i++) {
    const { rowIdx, key, mode = 'lines' } = owners[i];
    const composite = `${rowIdx}\t${key}`;
    if (!byComposite.has(composite)) {
      byComposite.set(composite, { mode, lines: [] });
    }
    const entry = byComposite.get(composite);
    entry.lines.push(translatedLines[i]);
  }
  for (const [composite, { mode, lines }] of byComposite) {
    const tab = composite.indexOf('\t');
    const rowIdx = Number(composite.slice(0, tab));
    const key = composite.slice(tab + 1);
    if (!rows[rowIdx] || typeof rows[rowIdx] !== 'object') continue;
    rows[rowIdx][key] = mode === 'array' ? lines : lines.join('\n');
  }
  return true;
}

/**
 * 采集入库后：从通用数据副本上对「颜色」/ sku_axes.colors 做二次处理，写回 data（即平台数据）。
 * 映射为 amazon 时使用亚马逊颜色规范提示词；含中文或其它平台键时走对应批量/单行规则。
 * 亚马逊映射下即使全英文也会调用 MiMo 做首字母大写等规范化。
 * 受 MIMO_AUTO_ENRICH 与 MIMO_API_KEY 控制，与标题/描述自动处理一致。
 * @param {Record<string, unknown>} data
 * @param {{ enrichPlatformKey?: string }} [options] 与标题二次处理同一解析键（如 amazon）
 */
export async function translateCollectionColorsWithAi(data, options = {}) {
  if (!isMimoAutoEnrichEnabled() || !isMimoConfigured()) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  const enrichPlatformKey =
    typeof options.enrichPlatformKey === 'string' && options.enrichPlatformKey.trim()
      ? options.enrichPlatformKey.trim().toLowerCase()
      : getMimoEnrichTitlePlatformKey();

  if (Array.isArray(data.rows)) {
    const { flatLines, owners } = flattenRowColorFields(data.rows);
    const runColorAi =
      flatLines.length &&
      (enrichPlatformKey === 'amazon' || flatLines.some((l) => containsChinese(l)));
    if (runColorAi) {
      const chunks = chunkLines(flatLines, { maxLines: 200, maxChars: 12000 });
      const concurrency = getAiConcurrency();
      try {
        const translatedChunks = await mapWithConcurrency(chunks, concurrency, async (ch) => {
          const joined = ch.lines.join('\n');
          const translated = await translateColorMultilineString(joined, enrichPlatformKey);
          if (translated == null) return null;
          const outLines = translated.split(/\r?\n/);
          if (outLines.length !== ch.lines.length) return null;
          return outLines.map((l) => truncateColorLine(l.trim()));
        });
        if (translatedChunks.some((x) => x == null)) {
          console.warn('[collectionAuto] batch row color translate failed (chunked)', {
            chunks: chunks.length,
          });
        } else {
          const merged = translatedChunks.flat();
          if (merged.length === flatLines.length) {
            writeBackRowColors(data.rows, owners, merged);
          }
        }
      } catch (e) {
        console.error('[collectionAuto] batch row color translate failed (chunked)', e);
      }
    } else if (flatLines.length) {
      writeBackRowColors(data.rows, owners, flatLines.map((l) => truncateColorLine(l)));
    }
  }

  const ax = data.sku_axes;
  if (ax && typeof ax === 'object' && !Array.isArray(ax) && Array.isArray(ax.colors) && ax.colors.length) {
    const rawLines = ax.colors.map((x) => truncateColorLine(String(x ?? '')));
    const skuRunAi =
      rawLines.length &&
      (enrichPlatformKey === 'amazon' || rawLines.some((l) => containsChinese(l)));
    if (skuRunAi) {
      const joined = rawLines.join('\n');
      try {
        const translated = await translateColorMultilineString(joined, enrichPlatformKey);
        if (translated != null) {
          const outLines = translated.split(/\r?\n/);
          if (outLines.length === rawLines.length) {
            ax.colors = outLines.map((l) => truncateColorLine(l.trim()));
          }
        }
      } catch (e) {
        console.error('[collectionAuto] color translate sku_axes failed', e);
      }
    } else {
      ax.colors = rawLines;
    }
  }
}
