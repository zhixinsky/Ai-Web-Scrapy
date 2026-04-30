import { extractImageUrlsFromRows } from '../images/downloader.js';
import { buildPublicCollectionImageUrl } from '../collectionImagePublic.js';
import { normalizeOneImageUrl } from '../imageUrlNormalize.js';
import { normalizeAmazonSearchKeywordsText } from '../ai/responseNormalize.js';
import { usSizeFullToShort } from '../sizeUsStandardize.js';
import { getExportRowsForDataJson, rawRowsFromStoredData } from './collectionExportRows.js';

/** 与 admin-ui CollectionDetailEditor 一致：根级数组，与 extractImageUrlsFromRows 副图顺序一一对应 */
const GALLERY_EXPORT_CHECKED_KEY = 'gallery_export_checked';
const LOCAL_GALLERY_SENTINEL_PREFIX = '__local_gallery__';

const AMAZON_VARIANT_TEMPLATE_OTHER_IMAGES = 8;
const OFFER_PRICE_US_KEY =
  'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax';
const OFFER_PRICE_CA_KEY =
  'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax';
const OFFER_PRICE_MX_KEY =
  'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax';

/** 中文颜色 → 英文（展示用；业务默认值请用 columnMapDraft const） */
/** @type {Record<string, string>} */
const COLOR_CN_TO_EN = {
  白色: 'White',
  黑: 'Black',
  黑色: 'Black',
  红色: 'Red',
  蓝色: 'Blue',
  绿色: 'Green',
  灰色: 'Gray',
  黄色: 'Yellow',
  橙色: 'Orange',
  紫色: 'Purple',
  粉色: 'Pink',
  棕色: 'Brown',
  米色: 'Beige',
  卡其: 'Khaki',
  卡其色: 'Khaki',
  咖啡色: 'Coffee',
  青色: 'Cyan',
  酒红: 'Wine Red',
  军绿: 'Army Green',
  银色: 'Silver',
  金色: 'Gold',
  肤色: 'Nude',
};


/**
 * @param {import('express').Request | null | undefined} req
 * @returns {string}
 */
export function getExportBaseUrl(req) {
  const fromEnv = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (!req || typeof req !== 'object') return '';
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = typeof req.get === 'function' ? req.get('host') : '';
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

/**
 * @param {string} s
 */
export function translateColorToAmazonEnglish(colorRaw) {
  const t = String(colorRaw ?? '').trim();
  if (!t) return '';
  if (COLOR_CN_TO_EN[t]) return COLOR_CN_TO_EN[t];
  if (/^[a-zA-Z0-9\s\-\/]+$/i.test(t.replace(/\s+/g, ' '))) {
    return t
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  return t;
}

/**
 * 平台尺码原文写入单元格；卖家 SKU 段仅在「已知美码全称」时压成简码。
 * @param {string} sizeRaw
 */
function exportSizeCellsFromPlatform(sizeRaw) {
  const sizeLine = String(sizeRaw ?? '').trim();
  if (!sizeLine) return { cellValue: '', skuPart: '' };
  const shortForSku = usSizeFullToShort(sizeLine);
  const skuPart = shortForSku !== sizeLine ? shortForSku : sizeLine;
  return { cellValue: sizeLine, skuPart };
}

/**
 * @param {string} s
 */
function sanitizeSkuPart(s) {
  const t = String(s || '')
    .replace(/[^\w\-]+/g, '')
    .slice(0, 48);
  return t || 'X';
}

/** 父 SKU 后缀：5 位随机大小写字母 + 数字 */
const PARENT_SKU_SUFFIX_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomParentSkuSuffix5() {
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += PARENT_SKU_SUFFIX_CHARS[Math.floor(Math.random() * PARENT_SKU_SUFFIX_CHARS.length)];
  }
  return s;
}

/** 父 SKU：随机 6 位（大小写字母+数字） */
function randomAlphaNum6Mixed() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 固定东八区（UTC+8）取月日：MMDD */
function mmddCstNow() {
  const ms = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${m}${day}`;
}

export function generateAmazonParentSellerSku() {
  return `${randomAlphaNum6Mixed()}-${mmddCstNow()}`;
}

/**
 * @param {object} parsed
 * @returns {Record<string, unknown>}
 */
function getSharedRow(parsed) {
  const raw = rawRowsFromStoredData(parsed);
  const parent = raw.find((r) => r && r['父子关系'] === 'parent');
  if (parent && typeof parent === 'object') return parent;
  return raw[0] && typeof raw[0] === 'object' ? raw[0] : {};
}

/**
 * 汇总行上的标价：优先 `list_price`（管理端编辑），否则回退插件常见字段 `价格`。
 * @param {Record<string, unknown>} shared
 * @returns {string}
 */
function getListPriceForExport(shared) {
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return '';
  const primary = shared['list_price'];
  const fallback = shared['价格'];
  const pick = primary != null && String(primary).trim() !== '' ? primary : fallback;
  if (pick == null) return '';
  if (Array.isArray(pick)) {
    return pick
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' / ');
  }
  return String(pick).trim();
}

/**
 * 三站价格：优先用平台数据里同名字段；无则回退到 list_price。
 * @param {Record<string, unknown>} row shared 或单条 sku 行
 * @param {string} fallback
 * @param {string} key
 */
function offerPriceValueForRow(row, fallback, key) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const v = row[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return String(fallback ?? '').trim();
}

function firstFiniteNumberFromText(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // list_price 可能是 "9.99 / 10.99"；取第一个可解析数字
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function formatOfferPriceFromListPrice(listPriceCell, factor) {
  const n = firstFiniteNumberFromText(listPriceCell);
  if (n == null) return '';
  const f = Number(factor);
  if (!Number.isFinite(f)) return '';
  return (n * f).toFixed(2);
}

/**
 * @param {Record<string, unknown>} shared
 */
function getTitle(shared) {
  const t =
    shared['标题'] ??
    shared['item_name'] ??
    shared['商品名称'] ??
    shared['title'] ??
    '';
  return String(t ?? '').trim();
}

/**
 * @param {Record<string, unknown>} shared
 */
function readDetailHtml(shared) {
  const d = shared['详情'] ?? shared['detail'] ?? '';
  return typeof d === 'string' ? d : '';
}

/**
 * @param {Record<string, unknown>} shared
 * @returns {string[]}
 */
function fiveBullets(shared) {
  const d = shared['描述'];
  /** @type {string[]} */
  const lines = [];
  if (Array.isArray(d)) {
    for (const x of d) {
      const s = String(x ?? '').trim();
      if (s) lines.push(s);
    }
  } else if (typeof d === 'string' && d.trim()) {
    for (const line of d.split(/\r?\n/)) {
      const s = line.trim();
      if (s) lines.push(s);
    }
  }
  while (lines.length < 5) lines.push('');
  return lines.slice(0, 5);
}

/**
 * @param {Record<string, unknown>} shared
 */
function getAmazonSearchKeywordsFromShared(shared) {
  const raw = String(shared['搜索关键词'] ?? shared['搜索关键字'] ?? '').trim();
  return normalizeAmazonSearchKeywordsText(raw);
}

/**
 * @param {Record<string, unknown>} shared
 * @param {string[]} galleryUrlList
 * @param {number} galleryLen
 */
function filterGalleryByExportChecked(shared, galleryUrlList, galleryLen) {
  const checked = shared[GALLERY_EXPORT_CHECKED_KEY];
  if (!Array.isArray(checked) || checked.length !== galleryLen) {
    return galleryUrlList
      .map((u) => String(u ?? '').trim())
      .filter(Boolean);
  }
  const out = [];
  for (let i = 0; i < galleryLen; i++) {
    if (checked[i]) out.push(String(galleryUrlList[i] ?? '').trim());
  }
  return out.filter(Boolean);
}

/**
 * @param {{ manifest: object | null, imagesNobgStatus: string | null }} opts
 */
function pickManifestFileArrays(opts) {
  const { manifest, imagesNobgStatus } = opts;
  const nobgDone = String(imagesNobgStatus || '') === 'done';
  const m = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
  const mainNobg = Array.isArray(m.mainFilesNobg) ? m.mainFilesNobg : [];
  const galNobg = Array.isArray(m.galleryFilesNobg) ? m.galleryFilesNobg : [];
  const mainFiles = Array.isArray(m.mainFiles) ? m.mainFiles : [];
  const galleryFiles = Array.isArray(m.galleryFiles) ? m.galleryFiles : [];
  const useNobgMain = nobgDone && mainNobg.length > 0;
  const useNobgGal = nobgDone && galNobg.length > 0;
  return {
    mainFiles,
    galleryFiles,
    mainNobg,
    galNobg,
    useNobgMain,
    useNobgGal,
  };
}

/**
 * @param {string} url
 * @param {string[]} list
 */
function urlIndexInMainList(url, list) {
  const a = normalizeOneImageUrl(String(url || '').trim());
  if (!a) return -1;
  for (let i = 0; i < list.length; i++) {
    if (normalizeOneImageUrl(String(list[i] ?? '').trim()) === a) return i;
  }
  return -1;
}

/**
 * @param {{
 *   collectionId: number,
 *   baseUrl: string,
 *   manifest: object | null,
 *   imagesNobgStatus: string | null,
 *   mainUrlList: string[],
 *   rowMainUrl: string,
 *   imagesStorage?: unknown,
 * }} opts
 */
function resolveMainPublicUrl(opts) {
  const { collectionId, baseUrl, manifest, imagesNobgStatus, mainUrlList, rowMainUrl, imagesStorage } =
    opts;
  const raw = String(rowMainUrl ?? '').trim();
  if (!raw) return '';
  const { mainFiles, mainNobg, useNobgMain } = pickManifestFileArrays({ manifest, imagesNobgStatus });
  const idx = urlIndexInMainList(raw, mainUrlList);
  if (idx >= 0 && mainFiles[idx]) {
    const fnNobg = useNobgMain && mainNobg[idx] ? String(mainNobg[idx]).trim() : '';
    const fn = String((fnNobg || mainFiles[idx]) ?? '').trim();
    if (!fn) return raw;
    const role = fnNobg ? 'main_nobg' : 'main';
    return buildPublicCollectionImageUrl(baseUrl, collectionId, role, fn, imagesStorage);
  }
  return raw;
}

/**
 * @param {{
 *   collectionId: number,
 *   baseUrl: string,
 *   manifest: object | null,
 *   imagesNobgStatus: string | null,
 *   galleryUrlList: string[],
 *   url: string,
 *   imagesStorage?: unknown,
 * }} opts
 */
function resolveGalleryPublicUrl(opts) {
  const { collectionId, baseUrl, manifest, imagesNobgStatus, galleryUrlList, url, imagesStorage } =
    opts;
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith(LOCAL_GALLERY_SENTINEL_PREFIX)) {
    const idx = Number(raw.slice(LOCAL_GALLERY_SENTINEL_PREFIX.length));
    if (!Number.isInteger(idx) || idx < 0) return '';
    const { galleryFiles, galNobg, useNobgGal } = pickManifestFileArrays({ manifest, imagesNobgStatus });
    if (idx >= galleryFiles.length) return '';
    const fnNobg = useNobgGal && galNobg[idx] ? String(galNobg[idx]).trim() : '';
    const fn = String((fnNobg || galleryFiles[idx]) ?? '').trim();
    if (!fn) return '';
    const role = fnNobg ? 'gallery_nobg' : 'gallery';
    return buildPublicCollectionImageUrl(baseUrl, collectionId, role, fn, imagesStorage);
  }
  const { galleryFiles, galNobg, useNobgGal } = pickManifestFileArrays({ manifest, imagesNobgStatus });
  const idx = urlIndexInMainList(raw, galleryUrlList);
  if (idx >= 0 && galleryFiles[idx]) {
    const fnNobg = useNobgGal && galNobg[idx] ? String(galNobg[idx]).trim() : '';
    const fn = String((fnNobg || galleryFiles[idx]) ?? '').trim();
    if (!fn) return raw;
    const role = fnNobg ? 'gallery_nobg' : 'gallery';
    return buildPublicCollectionImageUrl(baseUrl, collectionId, role, fn, imagesStorage);
  }
  return raw;
}

/**
 * @param {string[]} urls 已截断至 ≤8
 * @returns {Record<string, string>}
 */
function otherImageFieldsForTemplate(urls) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < AMAZON_VARIANT_TEMPLATE_OTHER_IMAGES; i++) {
    const u = String(urls[i] ?? '').trim();
    o[`副图${i + 1}`] = u;
    o[`other_image${i + 1}`] = u;
    o[`other_image_url${i + 1}`] = u;
  }
  return o;
}

/**
 * @param {string[]} bullets
 */
function templateBulletFields(bullets) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < 5; i++) {
    o[`商品特性${i + 1}`] = bullets[i] ? String(bullets[i]) : '';
  }
  return o;
}

/**
 * 将**平台数据** JSON 转为「亚马逊变体」扁平行：1 条 parent + N 条 child（N = getExportRowsForDataJson 行数）。
 * @param {{
 *   collectionId: number,
 *   parsed: object,
 *   manifest: object | null,
 *   imagesNobgStatus: string | null,
 *   baseUrl: string,
 *   amazonFeedProductType?: string,
 *   amazonItemType?: string,
 *   amazonClosureType?: string,
 *   amazonStyleName?: string,
 *   amazonItemTypeName?: string,
 *   amazonCoatChildOnlyRowFields?: Record<string, string>,
 *   imagesStorage?: unknown,
 *   parentSellerSku?: string | null,
 * }} opts
 * @returns {Record<string, string>[]}
 */
export function buildAmazonVariantTemplateRowObjects(opts) {
  const {
    collectionId,
    parsed,
    manifest,
    imagesNobgStatus,
    baseUrl,
    amazonFeedProductType,
    amazonItemType,
    amazonClosureType,
    amazonStyleName,
    amazonItemTypeName,
    amazonCoatChildOnlyRowFields,
    imagesStorage,
    parentSellerSku,
  } = opts;

  const itemTypeForRow = String(amazonItemType ?? '').trim();
  const closureTypeForRow = String(amazonClosureType ?? '').trim();
  const styleNameForRow = String(amazonStyleName ?? '').trim();
  const itemTypeNameForRow = String(amazonItemTypeName ?? '').trim();

  /** @type {Record<string, string>} */
  const coatChildOnlyParent = {};
  /** @type {Record<string, string>} */
  const coatChildOnlyValues = {};
  if (
    amazonCoatChildOnlyRowFields &&
    typeof amazonCoatChildOnlyRowFields === 'object' &&
    !Array.isArray(amazonCoatChildOnlyRowFields)
  ) {
    for (const [k, v] of Object.entries(amazonCoatChildOnlyRowFields)) {
      const key = String(k ?? '').trim();
      if (!key) continue;
      coatChildOnlyParent[key] = '';
      coatChildOnlyValues[key] = String(v ?? '').trim();
    }
  }

  const shared = getSharedRow(parsed);
  const listPriceCell = getListPriceForExport(shared);
  const title = getTitle(shared);
  const htmlDesc = readDetailHtml(shared);
  const plainDesc = String(shared['描述'] ?? '')
    .trim()
    .replace(/<[^>]+>/g, '')
    .trim();
  const description = (htmlDesc && htmlDesc.trim()) || plainDesc || '';
  const productKw = getAmazonSearchKeywordsFromShared(shared);
  const bullets = fiveBullets(shared);
  const bulletFields = templateBulletFields(bullets);
  const kwFields = { 搜索关键词: productKw, 搜索关键字: productKw };

  const rawForUrls = rawRowsFromStoredData(parsed);
  const { main: mainUrlList, gallery: galleryUrlListRaw } = extractImageUrlsFromRows(rawForUrls);
  const { galleryFiles } = pickManifestFileArrays({ manifest, imagesNobgStatus });
  const galleryLen = Math.max(galleryUrlListRaw.length, Array.isArray(galleryFiles) ? galleryFiles.length : 0);
  const galleryUrlListRawPadded = new Array(galleryLen).fill('').map((_, i) => {
    const u = String(galleryUrlListRaw[i] ?? '').trim();
    if (u) return u;
    const hasLocal = Array.isArray(galleryFiles) && Boolean(String(galleryFiles[i] ?? '').trim());
    return hasLocal ? `${LOCAL_GALLERY_SENTINEL_PREFIX}${i}` : '';
  });
  const galleryUrlList = filterGalleryByExportChecked(shared, galleryUrlListRawPadded, galleryLen);

  const filteredGallery = [];
  for (const u of galleryUrlList) {
    const s = String(u ?? '').trim();
    if (s) filteredGallery.push(s);
  }

  const firstMainRaw = String(mainUrlList[0] ?? '').trim();
  const parentMain = resolveMainPublicUrl({
    collectionId,
    baseUrl,
    manifest,
    imagesNobgStatus,
    mainUrlList,
    rowMainUrl: firstMainRaw,
    imagesStorage,
  });

  /** 「其他图片 URL」列只对应平台副图（含勾选过滤），不把主图数组里第 2 张起算进副图槽位，避免 6 张副图却占满 8 列。 */
  const restUrls = [];
  const nOther = AMAZON_VARIANT_TEMPLATE_OTHER_IMAGES;
  for (const u of filteredGallery) {
    if (restUrls.length >= nOther) break;
    restUrls.push(
      resolveGalleryPublicUrl({
        collectionId,
        baseUrl,
        manifest,
        imagesNobgStatus,
        galleryUrlList: galleryUrlListRawPadded,
        url: u,
        imagesStorage,
      })
    );
  }
  while (restUrls.length < nOther) restUrls.push('');

  const otherFields = otherImageFieldsForTemplate(restUrls);

  /**
   * 扁平行对象里长期混用「中文键」（与早期模板列 field 一致）与英文键。
   * 映射草稿统一用英文 field key 时，必须能直接从 row 上读到值（预览 / columnMapDraft 一致）。
   * @param {Record<string, unknown>} row
   */
  function applyStandardEnglishAliases(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const r = row;
    const pick = (cn, en) => {
      const a = r[cn];
      const b = r[en];
      const hasA = a != null && String(a).trim() !== '';
      const hasB = b != null && String(b).trim() !== '';
      if (hasA && !hasB) r[en] = typeof a === 'string' ? a : String(a);
    };
    pick('商品类型', 'feed_product_type');
    pick('卖家SKU', 'item_sku');
    pick('更新删除', 'update_delete');
    pick('标题', 'item_name');
    pick('父子关系', 'parent_child');
    if ((r.parent_child == null || String(r.parent_child).trim() === '') && r.parentage != null) {
      r.parent_child = String(r.parentage);
    }
    pick('父SKU', 'parent_sku');
    pick('服装尺码数值', 'apparel_size');
    pick('服装尺码数值', 'size_map');
    pick('搜索关键词', 'generic_keywords');
    pick('色表', 'color_map');
    pick('颜色', 'color_name');
    pick('服装尺寸', 'size_name');
    for (let i = 1; i <= 8; i++) {
      pick(`副图${i}`, `other_image_url${i}`);
    }
    for (let b = 1; b <= 5; b++) {
      pick(`商品特性${b}`, `bullet_point${b}`);
    }
  }

  /** @type {Record<string, string>[]} */
  const out = [];

  const resolvedParentSellerSku =
    String(parentSellerSku ?? '').trim() || generateAmazonParentSellerSku();
  const productType =
    String(amazonFeedProductType ?? '').trim() || String(shared['商品类型'] ?? '').trim() || '';

  const skuRows = getExportRowsForDataJson(parsed);

  const parentRow = {
    parentage: 'parent',
    item_name: title,
    标题: title,
    主图: parentMain,
    main_image: parentMain,
    main_image_url: parentMain,
    描述: description,
    product_description: description,
    关于此艺术品: description,
    颜色: '',
    色表: '',
    尺码: '',
    服装尺寸: '',
    服装尺码数值: '',
    父子关系: 'parent',
    卖家SKU: resolvedParentSellerSku,
    item_type: itemTypeForRow,
    style_name: '',
    item_type_name: '',
    model: resolvedParentSellerSku,
    model_name: resolvedParentSellerSku,
    closure_type: closureTypeForRow,
    父SKU: '',
    更新删除: '',
    商品类型: productType,
    brand_name: '',
    part_number: resolvedParentSellerSku,
    manufacturer: '',
    care_instructions: '',
    external_product_id: '',
    external_product_id_type: '',
    relationship_type: '',
    variation_theme: '',
    ...coatChildOnlyParent,
    ...bulletFields,
    ...kwFields,
    ...otherFields,
    list_price: '',
    [OFFER_PRICE_US_KEY]: '',
    [OFFER_PRICE_CA_KEY]: '',
    [OFFER_PRICE_MX_KEY]: '',
  };
  applyStandardEnglishAliases(parentRow);
  out.push(parentRow);

  for (const sku of skuRows) {
    const cnColor = String(sku['颜色'] ?? '').trim();
    const colorEn = translateColorToAmazonEnglish(cnColor);
    const sizeRaw = String(sku['尺码'] ?? sku['尺寸'] ?? '').trim();
    const { cellValue: sizeValueCell, skuPart: sizeSkuSeg } = exportSizeCellsFromPlatform(sizeRaw);
    const rowMain = String(sku['主图'] ?? '').trim() || firstMainRaw;
    const childMain = resolveMainPublicUrl({
      collectionId,
      baseUrl,
      manifest,
      imagesNobgStatus,
      mainUrlList,
      rowMainUrl: rowMain,
      imagesStorage,
    });
    const colorPart = sanitizeSkuPart(colorEn || 'C');
    const sizePart = sanitizeSkuPart(sizeSkuSeg || sizeRaw || 'S');
    const childSellerSku = `${resolvedParentSellerSku}-${colorPart}-${sizePart}`;

    out.push({
      parentage: 'child',
      item_name: title,
      标题: title,
      主图: childMain,
      main_image: childMain,
      main_image_url: childMain,
      描述: description,
      product_description: description,
      关于此艺术品: description,
      颜色: colorEn,
      色表: colorEn,
      尺码: sizeValueCell,
      服装尺寸: sizeValueCell,
      服装尺码数值: sizeValueCell,
      父子关系: 'child',
      卖家SKU: childSellerSku,
      item_type: itemTypeForRow,
      style_name: styleNameForRow,
      item_type_name: itemTypeNameForRow,
      model: childSellerSku,
      model_name: childSellerSku,
      closure_type: closureTypeForRow,
      父SKU: resolvedParentSellerSku,
      更新删除: '',
      商品类型: productType,
      brand_name: '',
      part_number: childSellerSku,
      manufacturer: '',
      care_instructions: '',
      external_product_id: '',
      external_product_id_type: '',
      relationship_type: '',
      variation_theme: '',
      ...coatChildOnlyValues,
      ...bulletFields,
      ...kwFields,
      ...otherFields,
      list_price: listPriceCell,
      // 价格按运营约定：基于 list_price 计算三站（仅当 list_price 可解析数字）
      [OFFER_PRICE_US_KEY]: String(listPriceCell ?? '').trim(),
      [OFFER_PRICE_CA_KEY]: formatOfferPriceFromListPrice(listPriceCell, 1.5),
      [OFFER_PRICE_MX_KEY]: formatOfferPriceFromListPrice(listPriceCell, 19),
    });
    applyStandardEnglishAliases(out[out.length - 1]);
  }

  return out;
}

/**
 * 扁平行上仅保留空串、须由「常量 / 表达式」写入的键（服务端不从采集数据填充）。
 * 与 `buildAmazonVariantTemplateRowObjects` 中写死的 `''` 占位一致。
 */
export const AMAZON_VARIANT_TEMPLATE_PLACEHOLDER_KEYS = new Set([
  'brand_name',
  'care_instructions',
  'external_product_id',
  'external_product_id_type',
  'manufacturer',
  'relationship_type',
  'update_delete',
  'variation_theme',
]);

/**
 * 管理端「字段」下拉：仅含扁平行对象上会出现、且非占位键的字段（与导出逻辑同源）。
 * 使用最小假数据跑一遍生成逻辑，得到父行+至少一条子行的键并集。
 */
export function getAmazonVariantTemplateFieldKeysForPicker() {
  const minimalParsed = {
    rows: [
      {
        标题: ' ',
        颜色: '红',
        尺码: 'M',
        主图: 'https://example.com/m.jpg',
        描述: 'line',
        商品类型: 'coat',
        list_price: '9.99',
        搜索关键词: 'a;b',
      },
    ],
  };
  const vrows = buildAmazonVariantTemplateRowObjects({
    collectionId: 1,
    parsed: minimalParsed,
    manifest: null,
    imagesNobgStatus: null,
    baseUrl: 'https://example.com',
    parentSellerSku: 'PARENTSKU',
    imagesStorage: 'local',
  });
  const keys = new Set();
  for (const row of vrows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const k of Object.keys(row)) {
      if (!AMAZON_VARIANT_TEMPLATE_PLACEHOLDER_KEYS.has(k)) keys.add(k);
    }
  }
  return Array.from(keys).sort((a, b) => String(a).localeCompare(String(b)));
}
