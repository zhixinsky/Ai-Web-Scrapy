/**
 * 统一处理 MiMo / OpenAI 返回的正文：去代码块、取标题首行、拆描述行。
 * 与 admin-ui/src/utils/aiResponseNormalize.ts 保持逻辑一致。
 */

function stripAiFences(s) {
  let t = String(s ?? '').trim();
  if (!t) return t;
  const full = /^```(?:\w*)?\s*([\s\S]*?)```$/m.exec(t);
  if (full) return full[1].trim();
  t = t.replace(/^```(?:\w*)?\s*\n?/, '');
  t = t.replace(/\n?```\s*$/, '').trim();
  return t;
}

/**
 * 将模型偶发输出的粘连英文（如 MenSummerShirt）拆成空格分隔（与 admin-ui 一致）。
 * @param {string} s
 */
function expandStuckEnglishKeywordTokens(s) {
  let t = String(s ?? '').trim();
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    if (next === t) break;
    t = next;
  }
  return t;
}

function normalizeFirstSearchKeywordGender(s) {
  const parts = String(s ?? '').split(';');
  if (parts.length === 0) return String(s ?? '').trim();
  let first = String(parts[0] || '').trim();
  first = first
    .replace(/^Mens\b/i, "Men's")
    .replace(/^Men\b/i, "Men's")
    .replace(/^Womens\b/i, "Women's")
    .replace(/^Women\b/i, "Women's");
  parts[0] = first;
  return parts.map((p) => String(p || '').trim()).filter(Boolean).join('; ');
}

/**
 * 亚马逊搜索关键字：单行、≤100 字符（与 admin-ui aiResponseNormalize 一致）。
 * 若输出含分号，则按「关键词短语」分段处理，短语内仍展开粘连 CamelCase；分号保留为短语分隔符。
 */
export function normalizeAmazonSearchKeywordsText(raw) {
  let s = normalizeTitleText(raw);
  if (!s) return '';
  if (!/[;；]/.test(s)) {
    s = s.replace(/[,，|]/g, ' ');
    s = expandStuckEnglishKeywordTokens(s);
    s = s.replace(/\s+/g, ' ').trim();
    s = normalizeFirstSearchKeywordGender(s);
    if (s.length > 100) s = s.slice(0, 100).trim();
    return s;
  }
  const parts = s
    .split(/[;；]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      let x = p.replace(/[,，|]/g, ' ');
      x = expandStuckEnglishKeywordTokens(x);
      x = x.replace(/\s+/g, ' ').trim();
      return x;
    })
    .filter(Boolean);
  let out = parts.join('; ');
  out = normalizeFirstSearchKeywordGender(out);
  while (out.length > 100 && parts.length > 1) {
    parts.pop();
    out = parts.join('; ');
    out = normalizeFirstSearchKeywordGender(out);
  }
  if (out.length > 100) out = out.slice(0, 100).trim();
  return out;
}

export function normalizeTitleText(raw) {
  let s = stripAiFences(String(raw ?? ''));
  s = s.replace(/^\uFEFF/, '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const skip = /^(here|title|the optimized|以下是|优化后|ok[,，]?)/i;
  for (const line of lines) {
    if (!skip.test(line)) return line;
  }
  return lines[lines.length - 1];
}

export function normalizeDescLines(raw) {
  let s = stripAiFences(String(raw ?? ''));
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1 && /Material\s*&\s*Composition:/i.test(lines[0])) {
    const chunk = lines[0];
    const parts = chunk
      .split(
        /(?=Material\s*&\s*Composition:|Versatile\s+Style:|Year-Round\s+Wear:|Functional\s+Design:|Comfort\s*&\s*Fit:)/gi
      )
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) lines = parts;
  }
  return lines;
}

export function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text ?? ''));
}

/**
 * 颜色翻译模型输出：必须恰好 expectedLineCount 行（每行 trim 后为一个颜色词）
 * @param {string} raw
 * @param {number} expectedLineCount
 * @returns {string[] | null}
 */
export function parseColorTranslateOutput(raw, expectedLineCount) {
  if (expectedLineCount < 1) return [];
  let s = stripAiFences(String(raw ?? ''));
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let lines = s.split('\n');
  while (lines.length > expectedLineCount && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  while (lines.length > expectedLineCount && lines[0].trim() === '') {
    lines.shift();
  }
  lines = lines.map((l) => l.trim());
  if (lines.length !== expectedLineCount) return null;
  return lines;
}

/**
 * 单行颜色翻译：模型若仍输出多行，只取第一行非空行，避免「军绿色→两行英文」破坏行数对齐
 * @param {string} raw
 * @returns {string | null}
 */
export function parseSingleLineColorOutput(raw) {
  let s = stripAiFences(String(raw ?? ''));
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines[0];
}

const COLOR_TRUNCATE_STOP_WORDS = new Set([
  'men',
  "men's",
  'mens',
  'man',
  'male',
  'women',
  "women's",
  'womens',
  'woman',
  'female',
  'kids',
  "kid's",
  'kid',
  'boys',
  'boy',
  'girls',
  'girl',
  'unisex',
  'adult',
  'junior',
  'tshirt',
  't-shirt',
  'tee',
  'top',
  'shirt',
  'blouse',
  'hoodie',
  'sweatshirt',
  'jacket',
  'coat',
  'pants',
  'trousers',
  'shorts',
  'skirt',
  'dress',
  'jeans',
  'sweater',
  'cardigan',
  'suit',
  'vest',
  'bra',
  'underwear',
  'shoes',
  'sneakers',
  'boots',
  'sandals',
  'hat',
  'cap',
  'bag',
  'backpack',
]);

function normalizeTokenForStopWord(tok) {
  return String(tok || '')
    .toLowerCase()
    .replace(/^[\s\-\u2013\u2014_()【】[\]{}.,;:!?'"]+/, '')
    .replace(/[\s\-\u2013\u2014_()【】[\]{}.,;:!?'"]+$/, '');
}

/**
 * 颜色行截断：用于从「Gray Men Tshirt」提取「Gray」。
 * 仅做启发式清洗：遇到常见品类/人群词即截断；否则保持原样（最多 trim + 空白规整）。
 * @param {string} line
 */
export function truncateColorLine(line) {
  let s = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const parts = s.split(' ');
  if (parts.length <= 1) return s;
  let cut = parts.length;
  for (let i = 1; i < parts.length; i++) {
    const t = normalizeTokenForStopWord(parts[i]);
    if (!t) continue;
    if (COLOR_TRUNCATE_STOP_WORDS.has(t)) {
      cut = i;
      break;
    }
  }
  const out = parts.slice(0, cut).join(' ').trim();
  return out || s;
}
