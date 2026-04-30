/** 与 server/src/ai/responseNormalize.js 逻辑一致 */

function stripAiFences(s: string): string {
  let t = String(s ?? '').trim();
  if (!t) return t;
  const full = /^```(?:\w*)?\s*([\s\S]*?)```$/m.exec(t);
  if (full) return full[1].trim();
  t = t.replace(/^```(?:\w*)?\s*\n?/, '');
  t = t.replace(/\n?```\s*$/, '').trim();
  return t;
}

export function normalizeTitleText(raw: string | undefined | null): string {
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
  return lines[lines.length - 1]!;
}

/**
 * 将模型偶发输出的粘连英文（如 MenSummerShirt）拆成空格分隔，与 server responseNormalize 一致。
 */
function expandStuckEnglishKeywordTokens(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    if (next === t) break;
    t = next;
  }
  return t;
}

function normalizeFirstSearchKeywordGender(s: string): string {
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
 * 亚马逊搜索关键字：单行、≤100 字符。
 * 含分号时按短语分段，短语内展开粘连 CamelCase，分号保留为分隔符。
 */
export function normalizeAmazonSearchKeywordsText(raw: string | undefined | null): string {
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

export function normalizeDescLines(raw: string | undefined | null): string[] {
  let s = stripAiFences(String(raw ?? ''));
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1 && /Material\s*&\s*Composition:/i.test(lines[0]!)) {
    const chunk = lines[0]!;
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
