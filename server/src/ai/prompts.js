/**
 * 采集入库自动处理与 admin-ui 手动 AI 共用的服务端提示词入口。
 */
import {
  AMAZON_COLOR_TRANSLATE_BATCH_SYSTEM,
  AMAZON_COLOR_TRANSLATE_SINGLE_LINE_SYSTEM,
  AMAZON_COLLECTION_DESCRIPTION_SYSTEM,
  AMAZON_COLLECTION_SEARCH_KEYWORDS_SYSTEM,
  AMAZON_COLLECTION_TITLE_SYSTEM,
} from './defaultCollectionAiPrompts.js';
import { getAppSetting } from '../platform/enrichPlatformResolve.js';

const COLLECTION_AI_PROMPTS_KEY_PREFIX = 'collection_ai_prompts:';
const COLLECTION_AI_PROMPT_PROFILES_KEY_PREFIX = 'collection_ai_prompt_profiles:';
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = '服装（默认）';

function platformKeyOf(platformKey) {
  return String(platformKey ?? 'amazon')
    .trim()
    .toLowerCase() || 'amazon';
}

function normalizePromptUserId(userId) {
  const n = Number(userId);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parsePromptOverrideJson(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function normalizeTitlePromptLengthRules(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  s = s.replace(/80\s*[-–—]\s*150/g, '80–120');
  s = s.replace(/80\s*至\s*150/g, '80–120');
  s = s.replace(/80\s*到\s*150/g, '80–120');
  s = s.replace(/不得超过\s*170\s*(?:个\s*)?字符/g, '不得超过 120 个字符');
  s = s.replace(/不超过\s*170\s*(?:个\s*)?字符/g, '不超过 120 个字符');
  s = s.replace(/最多\s*170\s*(?:个\s*)?字符/g, '最多 120 个字符');
  s = s.replace(/≤\s*170\s*字符/g, '80–120 字符');
  s = s.replace(/小于等于\s*170\s*(?:个\s*)?字符/g, '80–120 个字符');
  s = s.replace(/长度必须不超过\s*170\s*(?:个\s*)?字符，?且尽量不少于\s*80\s*(?:个\s*)?字符/g, '长度必须在 80–120 个字符之间');
  return s;
}

function normalizePromptField(field, value) {
  const s = String(value ?? '').trim();
  if (field === 'title') return normalizeTitlePromptLengthRules(s);
  if (field === 'searchKeywords') {
    return s
      .replace(/例如\s*Men Shirts/g, "例如 Men's Shirts")
      .replace(/如\s*Men Shirts/g, "如 Men's Shirts")
      .replace(/Gender \+ Product Type（如 Men Shirts）/g, "Gender + Product Type（如 Men's Shirts / Women's Shirts / Unisex Shirts）")
      .replace(/第一个关键词必须是：性别 \+ 核心服装类型（例如 Men Shirts）/g, "第一个关键词必须是：性别 + 核心服装类型（例如 Men's Shirts / Women's Shirts / Unisex Shirts），男装必须使用 Men's，女装必须使用 Women's，禁止简写为 Men 或 Women");
  }
  return s;
}

function readCollectionAiPromptOverrides(platformKey, userId) {
  const uid = normalizePromptUserId(userId);
  if (!uid) return {};
  const userKey = collectionAiPromptsSettingKey(platformKey, uid);
  return parsePromptOverrideJson(getAppSetting(userKey));
}

function parseProfilesStateJson(raw) {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeProfilesState(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const activeProfileId = String(src.activeProfileId ?? '').trim();
  const profilesSrc = Array.isArray(src.profiles) ? src.profiles : [];
  const profiles = profilesSrc
    .map((p) => {
      const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
      const id = String(o.id ?? '').trim();
      const name = String(o.name ?? '').trim();
      const prompts = normalizeCollectionAiPromptSettings(o.prompts);
      if (!id || !name) return null;
      return { id, name, prompts };
    })
    .filter(Boolean);
  return {
    version: 1,
    activeProfileId,
    profiles,
  };
}

function collectionAiPromptProfilesSettingKey(platformKey, userId) {
  const uid = normalizePromptUserId(userId);
  if (!uid) return `${COLLECTION_AI_PROMPT_PROFILES_KEY_PREFIX}${platformKeyOf(platformKey)}`;
  return `${COLLECTION_AI_PROMPT_PROFILES_KEY_PREFIX}user:${uid}:${platformKeyOf(platformKey)}`;
}

function overridePrompt(platformKey, field, userId) {
  const active = getActiveAiPromptProfile(platformKey, userId);
  const v0 = active?.prompts?.[field];
  if (typeof v0 === 'string' && v0.trim()) return normalizePromptField(field, v0);
  const v = readCollectionAiPromptOverrides(platformKey, userId)?.[field];
  return typeof v === 'string' && v.trim() ? normalizePromptField(field, v) : null;
}

/** 平台键 → 标题系统提示词（二次处理：通用数据标题 → 该平台平台数据标题） */
const PLATFORM_TITLE_PROMPTS = {
  /** 亚马逊：Gender + Season + Product Type + Key Features，80–120 字符 */
  amazon: AMAZON_COLLECTION_TITLE_SYSTEM,
};

/**
 * @param {string} [platformKey] 目标平台键，默认 amazon；未来可扩展 temu、shopee 等
 * @returns {string}
 */
export function getPlatformTitleSystemPrompt(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const custom = overridePrompt(k, 'title', userId);
  if (custom) return custom;
  const p = PLATFORM_TITLE_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : PLATFORM_TITLE_PROMPTS.amazon;
}

/** @deprecated 请使用 getPlatformTitleSystemPrompt('amazon')；保留别名以免遗漏引用 */
export const MIMO_TITLE_SYSTEM = AMAZON_COLLECTION_TITLE_SYSTEM;

export const MIMO_DESC_SYSTEM = AMAZON_COLLECTION_DESCRIPTION_SYSTEM;


/** 平台键 → 五点描述系统提示（与标题同色：由 export_dest_platform_id 解析出的 enrich 键选用） */
const PLATFORM_DESC_PROMPTS = {
  amazon: MIMO_DESC_SYSTEM,
};

/**
 * @param {string} [platformKey] 与 {@link getPlatformTitleSystemPrompt} 同源
 * @returns {string}
 */
export function getPlatformDescSystemPrompt(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const custom = overridePrompt(k, 'description', userId);
  if (custom) return custom;
  const p = PLATFORM_DESC_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : PLATFORM_DESC_PROMPTS.amazon;
}

/** 无采集描述时：仅根据商品标题推断并生成五点英文描述（输出格式与 MIMO_DESC_SYSTEM 一致） */
export const MIMO_DESC_FROM_TITLE_SYSTEM = `You are an Amazon listing copy expert. The user provides ONLY a product title (usually English). There is no raw bullet text from the supplier.

Task: Infer product category, materials, style, and plausible features from the title alone, and write exactly five bullet lines in English only.

Each line must follow this theme in order: (1) material & composition, (2) versatile style, (3) year-round / all-season wear, (4) functional design, (5) comfort & fit.

Rules:
- Do not invent a specific country of origin or garment measurements; avoid country/region references and clothing size tokens (S, M, L, XL, etc.).
- No marketing hype, years, or vague superlatives (e.g. Best, New, #1).
- Base bullets on what the title reasonably implies; if the title is minimal, use category-appropriate, plausible attributes (fabric feel, cut, use case, comfort) without contradicting the title.
- The entire output must be pure English: no Chinese, no other languages, no mixed scripts.

Output format (exactly 5 lines, one bullet per line, in this order). Each line starts with this English label followed by a space and the sentence:
Material & Composition:
Versatile Style:
Year-Round Wear:
Functional Design:
Comfort & Fit:

After each label, write the body in English on the same line. Do not use Markdown, do not add numbering, no extra lines before or after the five lines.`;

const PLATFORM_DESC_FROM_TITLE_PROMPTS = {
  amazon: MIMO_DESC_SYSTEM,
};

/**
 * @param {string} [platformKey]
 * @returns {string}
 */
export function getPlatformDescFromTitleSystemPrompt(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const custom = overridePrompt(k, 'description', userId);
  if (custom) return custom;
  const p = PLATFORM_DESC_FROM_TITLE_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : PLATFORM_DESC_FROM_TITLE_PROMPTS.amazon;
}

/** 平台键 → 多行颜色系统提示（非注册平台用通用 MIMO_COLOR_TRANSLATE_SYSTEM） */
const PLATFORM_COLOR_BATCH_PROMPTS = {
  amazon: AMAZON_COLOR_TRANSLATE_BATCH_SYSTEM,
};

/** 平台键 → 单行颜色回退提示 */
const PLATFORM_COLOR_SINGLE_PROMPTS = {
  amazon: AMAZON_COLOR_TRANSLATE_SINGLE_LINE_SYSTEM,
};

/**
 * @param {string} [platformKey] 如 amazon；缺省或非注册键时用通用颜色规则
 * @returns {string}
 */
export function getPlatformColorBatchSystemPrompt(platformKey) {
  const k = platformKeyOf(platformKey);
  const p = PLATFORM_COLOR_BATCH_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : MIMO_COLOR_TRANSLATE_SYSTEM;
}

/**
 * @param {string} [platformKey]
 * @returns {string}
 */
export function getPlatformColorSingleLineSystemPrompt(platformKey) {
  const k = platformKeyOf(platformKey);
  const p = PLATFORM_COLOR_SINGLE_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : MIMO_COLOR_TRANSLATE_SINGLE_LINE;
}

/** 采集入库：多行颜色中文 → 英文颜色词（与行数严格一致）；非亚马逊平台或回退用 */
export const MIMO_COLOR_TRANSLATE_SYSTEM = `你是一个数据清洗助手。

任务：
对输入的颜色数据进行处理。输入与输出均为多行文本，一行对应一个颜色。

规则：
1. 如果是中文，将其译为英文颜色词；若已是英文，则保持或轻微规范化为常见写法
2. 每一行只输出一个英文颜色词或一个简短英文颜色短语（如 Light Blue、Army Green），该行内不要换行
3. 输出行数必须与输入行数完全一致：多一行、少一行、或空行均视为错误
4. 严禁将「同一行输入」拆成多行输出。例如输入仅一行「军绿色」时，输出只能一行（如 Army Green），不得再输出第二行 Dark Green 或其它同义拆分
5. 同一中文颜色只选一个最贴切的英文译名，不要并列输出多个同义词
6. 不允许输出解释、编号、Markdown、首尾空行
7. 不要输出完整句子，只能是颜色词或简短颜色短语

示例输入：
红色
蓝色
Black
深灰色

示例输出：
Red
Blue
Black
Dark Gray`;

/** 单行颜色翻译（批量行数不一致时的回退）：输出必须且仅能解析为一行 */
export const MIMO_COLOR_TRANSLATE_SINGLE_LINE = `你是一个数据清洗助手。用户每次只输入一行，表示一个颜色名称（中文或英文）。

规则：
1. 只输出一行英文：一个颜色单词或一个简短英文颜色短语（如 Olive Green、Army Green），不要换行
2. 若中文有多种译法，只输出一个最常用、最贴切的英文名
3. 若已是英文，输出保持为一行，可轻微规范化
4. 不要输出第二行、不要解释、不要同义词各占一行

只输出一行英文，不要其它任何内容。`;

/** 采集入库：详情字段（Key:Value，按 br 分段）含中文时整段译为英文，行数与段数严格一致 */
export const MIMO_DETAIL_TRANSLATE_SYSTEM = `你是跨境电商商品「规格/属性详情」英译助手。

输入格式：一行文本，使用 <br> 分隔多段属性。每一段对应页面上原先用 <br> 分隔的一条属性段，常见形如 Key:Value、Key: 或 :Value（冒号可为半角或全角）。

任务：
1. 若某段含中文，将该段译为英文；若该段已是英文且无中文，保持原样。
2. 尽量保留「属性名: 属性值」结构：冒号前译为简洁英文属性名，冒号后译为值；若原文无冒号，将该段译为一句简洁的英文说明。
3. 必须保留相同的 <br> 分段数量与顺序：不得增减 <br>，不得合并或拆分段落。
4. 输出必须是单行：仅输出译文正文，不要编号、不要 Markdown、不要解释、不要多余空行。
5. 输出语言为英文；避免在译文中再出现中文。`;

/** 平台键 → 详情段翻译系统提示 */
const PLATFORM_DETAIL_TRANSLATE_PROMPTS = {
  amazon: MIMO_DETAIL_TRANSLATE_SYSTEM,
};

/**
 * @param {string} [platformKey]
 * @returns {string}
 */
export function getPlatformDetailTranslateSystemPrompt(platformKey) {
  const k = platformKeyOf(platformKey);
  const p = PLATFORM_DETAIL_TRANSLATE_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : PLATFORM_DETAIL_TRANSLATE_PROMPTS.amazon;
}

/** 平台键 → 由标题生成搜索关键字 */
const PLATFORM_SEARCH_KEYWORDS_PROMPTS = {
  amazon: AMAZON_COLLECTION_SEARCH_KEYWORDS_SYSTEM,
};

/**
 * @param {string} [platformKey]
 * @returns {string}
 */
export function getPlatformSearchKeywordsSystemPrompt(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const custom = overridePrompt(k, 'searchKeywords', userId);
  if (custom) return custom;
  const p = PLATFORM_SEARCH_KEYWORDS_PROMPTS[k];
  return typeof p === 'string' && p.trim() ? p : PLATFORM_SEARCH_KEYWORDS_PROMPTS.amazon;
}

function builtInDefaultProfile(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const defaults = {
    title: PLATFORM_TITLE_PROMPTS[k] || PLATFORM_TITLE_PROMPTS.amazon,
    description: PLATFORM_DESC_PROMPTS[k] || PLATFORM_DESC_PROMPTS.amazon,
    searchKeywords: PLATFORM_SEARCH_KEYWORDS_PROMPTS[k] || PLATFORM_SEARCH_KEYWORDS_PROMPTS.amazon,
  };
  const legacy = readCollectionAiPromptOverrides(k, userId);
  const prompts = {
    title: normalizePromptField('title', legacy.title || defaults.title),
    description: String(legacy.description || defaults.description).trim(),
    searchKeywords: String(legacy.searchKeywords || defaults.searchKeywords).trim(),
  };
  return { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, prompts, defaults };
}

export function getCollectionAiPromptProfiles(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const uid = normalizePromptUserId(userId);
  const raw = getAppSetting(collectionAiPromptProfilesSettingKey(k, uid));
  const parsed = normalizeProfilesState(parseProfilesStateJson(raw));

  const builtin = builtInDefaultProfile(k, uid);
  const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  const hasDefault = profiles.some((p) => p.id === DEFAULT_PROFILE_ID);
  const mergedProfiles = hasDefault ? profiles : [builtin, ...profiles];

  const activeId0 = String(parsed?.activeProfileId || '').trim();
  const activeId = mergedProfiles.some((p) => p.id === activeId0) ? activeId0 : DEFAULT_PROFILE_ID;
  const active = mergedProfiles.find((p) => p.id === activeId) || builtin;

  return {
    platformKey: k,
    userId: uid,
    activeProfileId: active.id,
    activeProfileName: active.name,
    profiles: mergedProfiles.map((p) => ({ id: p.id, name: p.name, prompts: p.prompts })),
    defaults: {
      title: builtin.defaults.title,
      description: builtin.defaults.description,
      searchKeywords: builtin.defaults.searchKeywords,
    },
  };
}

export function getActiveAiPromptProfile(platformKey, userId) {
  const r = getCollectionAiPromptProfiles(platformKey, userId);
  const p = r.profiles.find((x) => x.id === r.activeProfileId);
  return p || null;
}

export function getCollectionAiPromptSettings(platformKey, userId) {
  const k = platformKeyOf(platformKey);
  const uid = normalizePromptUserId(userId);
  const userOverrides = uid ? parsePromptOverrideJson(getAppSetting(collectionAiPromptsSettingKey(k, uid))) : {};
  const profiles = getCollectionAiPromptProfiles(k, uid);
  const active = profiles.profiles.find((p) => p.id === profiles.activeProfileId);
  return {
    platformKey: k,
    userId: uid,
    hasUserOverride: Boolean(
      userOverrides.title || userOverrides.description || userOverrides.searchKeywords
    ),
    activeProfileId: profiles.activeProfileId,
    activeProfileName: profiles.activeProfileName,
    prompts: {
      title: active?.prompts?.title || getPlatformTitleSystemPrompt(k, uid),
      description: active?.prompts?.description || getPlatformDescSystemPrompt(k, uid),
      searchKeywords: active?.prompts?.searchKeywords || getPlatformSearchKeywordsSystemPrompt(k, uid),
    },
    defaults: {
      title: PLATFORM_TITLE_PROMPTS[k] || PLATFORM_TITLE_PROMPTS.amazon,
      description: PLATFORM_DESC_PROMPTS[k] || PLATFORM_DESC_PROMPTS.amazon,
      searchKeywords: PLATFORM_SEARCH_KEYWORDS_PROMPTS[k] || PLATFORM_SEARCH_KEYWORDS_PROMPTS.amazon,
    },
  };
}

export function normalizeCollectionAiPromptSettings(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    title: normalizePromptField('title', src.title),
    description: normalizePromptField('description', src.description),
    searchKeywords: normalizePromptField('searchKeywords', src.searchKeywords),
  };
}

export function collectionAiPromptsSettingKey(platformKey, userId) {
  const uid = normalizePromptUserId(userId);
  if (uid) return `${COLLECTION_AI_PROMPTS_KEY_PREFIX}user:${uid}:${platformKeyOf(platformKey)}`;
  return `${COLLECTION_AI_PROMPTS_KEY_PREFIX}${platformKeyOf(platformKey)}`;
}
