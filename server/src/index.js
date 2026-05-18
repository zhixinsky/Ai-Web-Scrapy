import './env.js';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import { db } from './db.js';
import {
  ensureExportPlatformCatalogAndMap,
  getExportPlatformCatalog,
} from './export/exportPlatformCatalog.js';
import path from 'path';
import { nowCstIso } from './timeCst.js';
import { extractImageUrlsFromRows, downloadCollectionImages } from './images/downloader.js';
import {
  absCollectionImagesRoot,
  relCollectionImagesDir,
} from './images/collectionImagePaths.js';
import {
  getExportRowsForDataJson,
  rawRowsFromStoredData,
  readColorExportIncluded,
} from './export/collectionExportRows.js';
import {
  AMAZON_VARIANT_TEMPLATE_PLACEHOLDER_KEYS,
  generateAmazonParentSellerSku,
  buildAmazonVariantTemplateRowObjects,
  getAmazonVariantTemplateFieldKeysForPicker,
  getExportBaseUrl,
} from './export/amazonFlatExport.js';
import { fillXlsxTemplateWithColumnMap } from './export/fillExportTemplate.js';
import fs from 'fs';
import fsp from 'fs/promises';
import archiver from 'archiver';
import { processCollectionRows } from './platforms/collectionPipeline.js';
import {
  applyPlatformDataOnSave,
  genericToAmazonPlatformData,
  genericToExportSecondaryPlatformData,
  genericToPlatformDataByEnrichKey,
} from './platform/genericToPlatform.js';
import { collectionDataHasSizeFieldArrays } from './sizeUsStandardize.js';
import {
  getAppSetting,
  getPlatformEnrichMap,
  resolveEnrichPlatformKeyFromCollectionRow,
  setAppSetting,
} from './platform/enrichPlatformResolve.js';
import {
  getPlatformJsonString,
  getGenericJsonString,
} from './collectionDataHelpers.js';
import { sanitizeCollectionDataPayload } from './sanitizeDetailFields.js';
import {
  removeBackgroundFromImageUrl,
  removeBackgroundFromBuffer,
  isPixianConfigured,
} from './pixian.js';
import {
  isMimoConfigured,
  mimoChatCompletion,
  extractMessageText,
  getAiModel,
  getAiProvider,
  getAiClient,
} from './ai/mimo.js';
import {
  collectionAiPromptsSettingKey,
  getCollectionAiPromptProfiles,
  getCollectionAiPromptSettings,
  normalizeCollectionAiPromptSettings,
} from './ai/prompts.js';
import {
  enrichCollectedRowsWithAi,
  translateCollectionColorsWithAi,
  translateCollectionDetailsWithAi,
  generateCollectionSearchKeywordsWithAi,
  isMimoAutoEnrichEnabled,
} from './ai/collectionAuto.js';
import {
  buildPublicCollectionImageUrl,
  verifyCollectionImageAccessFromRequest,
} from './collectionImagePublic.js';
import { readCollectionImageBuffer } from './collectionImageBuffer.js';
import { getAiEraseAvailability, isAiEraseProviderConfigured, normalizeAiEraseProvider, runImageErase } from './aiErase.js';
import { baiduInpaintRectangle, isBaiduInpaintingConfigured } from './baiduInpainting.js';
import { isTencentTranslateConfigured, tencentTranslate } from './tencentTranslate.js';
import {
  assertImagesStorageOssAllowed,
  assertOssConfigured,
  buildOssPublicUrl,
  collectionUsesOss,
  copyOssObjectsForCollection,
  deleteOssObjectsForCollection,
  getOssConfig,
  newOssClient,
  normalizeImagesStorageInput,
  ossKeyForCollectionImage,
} from './oss.js';
import multer from 'multer';
import { performance } from 'node:perf_hooks';
import STS from '@alicloud/sts-sdk';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import {
  detectSkuFromSources,
  matchSkuDetectRules,
  normalizeSkuDetectRule,
} from './skuDetectEngine.js';

/** app_settings 键：导出列映射草稿（与 GET /api/export/column-map-draft 一致） */
const EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX = 'export_column_map_draft:';

/** app_settings 键：每用户的「通用数据」预设（用于导出映射快速填充；全模板共享） */
const EXPORT_GENERIC_PRESET_KEY_PREFIX = 'export_generic_preset:v1:';

function exportGenericPresetUserKey(uid) {
  return `${EXPORT_GENERIC_PRESET_KEY_PREFIX}user:${uid}`;
}

function parseExportGenericPresetRows(raw) {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 读取用户级通用数据；若仅有旧版「按模板」key 则取行数最多的一份并迁移到用户级 */
function getExportGenericPresetRowsForUser(uid) {
  const userKey = exportGenericPresetUserKey(uid);
  const userRows = parseExportGenericPresetRows(getAppSetting(userKey));
  if (userRows.length > 0) return userRows;

  const legacyPrefix = `${EXPORT_GENERIC_PRESET_KEY_PREFIX}user:${uid}:exportType:`;
  const legacy = db.prepare('SELECT value FROM app_settings WHERE key LIKE ?').all(`${legacyPrefix}%`);
  let best = [];
  for (const r of legacy) {
    const arr = parseExportGenericPresetRows(r?.value);
    if (arr.length > best.length) best = arr;
  }
  if (best.length > 0) {
    setAppSetting(userKey, JSON.stringify(best));
  }
  return best;
}

function normalizeExportGenericPresetRows(rowsIn) {
  const rows = [];
  for (const r of rowsIn) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const excelHeader = String(r.excelHeader || '').trim();
    if (!excelHeader) continue;
    if (excelHeader.length > 600) {
      const err = new Error('模板列名过长（>600）');
      err.status = 400;
      throw err;
    }
    const source = r.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const t = String(source.type || '').trim();
    if (t !== 'field' && t !== 'const' && t !== 'expr') continue;
    if (t === 'field') {
      const key = String(source.key || '').trim();
      if (!key) continue;
      rows.push({ excelHeader, source: { type: 'field', key } });
      continue;
    }
    if (t === 'const') {
      const value = source.value == null ? '' : String(source.value);
      const applyTo = String(source.applyTo || '').trim();
      rows.push({
        excelHeader,
        source: { type: 'const', value, ...(applyTo ? { applyTo } : {}) },
      });
      continue;
    }
    if (t === 'expr') {
      const expr = String(source.expr || '').trim();
      if (!expr) continue;
      if (expr.length > 800) {
        const err = new Error('表达式过长（>800）');
        err.status = 400;
        throw err;
      }
      const applyTo = String(source.applyTo || '').trim();
      rows.push({
        excelHeader,
        source: { type: 'expr', expr, ...(applyTo ? { applyTo } : {}) },
      });
    }
  }
  return rows;
}

/** 上传的自定义空模板存放目录（服务器磁盘） */
const EXPORT_TEMPLATE_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'export-templates');

function normalizeHeaderCellText(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
}

function normalizePossiblyMojibakeFilenameText(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  // Some multipart clients/proxies expose UTF-8 filenames as Latin1-looking mojibake,
  // e.g. "è¡¬è¡«æ¨¡æ¿" instead of "衬衫模板". Decode only when it clearly improves to CJK.
  if (!/[ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(raw)) {
    return raw;
  }
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8').trim();
    const rawCjk = (raw.match(/[\u3400-\u9FFF]/g) || []).length;
    const decodedCjk = (decoded.match(/[\u3400-\u9FFF]/g) || []).length;
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
    if (decoded && replacementCount === 0 && decodedCjk > rawCjk) return decoded;
  } catch {
    // keep raw
  }
  return raw;
}

function safeExcelFilenameBase(name) {
  const base = normalizePossiblyMojibakeFilenameText(name) || 'template';
  // 保守过滤：避免路径穿越/奇怪字符
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'template';
}

function ensureExportTemplateUploadDir() {
  try {
    fs.mkdirSync(EXPORT_TEMPLATE_UPLOAD_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * 入库：将磁盘绝对路径存为相对 process.cwd() 的路径（换机拷目录 + 拷库时仍可解析）。
 * 若文件不在项目根之下则仍存绝对路径（兼容边缘部署）。
 */
function toStoredExportTemplatePath(absolutePath) {
  const abs = path.resolve(String(absolutePath || ''));
  const cwd = path.resolve(process.cwd());
  if (!abs) return '';
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return abs;
  }
  return rel.split(path.sep).join('/');
}

/** 出库：库内相对路径 → 当前进程可用的绝对路径；旧数据绝对路径原样规范化。 */
function resolveExportTemplateDiskPath(stored) {
  const s = String(stored ?? '').trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.normalize(path.join(process.cwd(), s));
}

/**
 * 生成类似内置 UUID 的导出类型 ID（固定前缀 + 随机 12 hex）。
 * 示例：00000000-0000-4000-8000-0f12ab34cd56
 */
function newLikeBuiltinExportTypeId() {
  const tail = crypto.randomBytes(6).toString('hex'); // 12 hex
  return `00000000-0000-4000-8000-${tail}`;
}

function getCustomExportTemplateByExportTypeId(exportTypeId) {
  const id = String(exportTypeId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, name,
              export_type_id AS exportTypeId,
              dest_platform_id AS destPlatformId,
              original_filename AS originalFilename,
              file_path AS filePath,
              sheet_name AS sheetName,
              header_row AS headerRow,
              data_start_row AS dataStartRow,
              headers_json AS headersJson
         FROM export_templates
        WHERE export_type_id = ?`
    )
    .get(id);
  if (!row) return null;
  let headers = [];
  try {
    headers = JSON.parse(row.headersJson || '[]');
  } catch {
    headers = [];
  }
  return {
    id: row.id,
    name: row.name,
    exportTypeId: row.exportTypeId,
    destPlatformId: row.destPlatformId,
    originalFilename: row.originalFilename,
    filePath: resolveExportTemplateDiskPath(row.filePath),
    sheetName: row.sheetName,
    headerRow: row.headerRow,
    dataStartRow: row.dataStartRow,
    headers,
  };
}

/**
 * 与上传空模板后缀一致：优先磁盘路径扩展名，其次 originalFilename（仅识别 .xlsx / .xlsm）。
 * @param {{ filePath?: string, originalFilename?: string } | null | undefined} tpl
 * @returns {'xlsx' | 'xlsm'}
 */
function exportTemplateWorkbookExtension(tpl) {
  if (!tpl) return 'xlsx';
  const fp = String(tpl.filePath || '').trim();
  const extFile = path.extname(path.basename(fp)).toLowerCase();
  if (extFile === '.xlsm') return 'xlsm';
  if (extFile === '.xlsx') return 'xlsx';
  const orig = String(tpl.originalFilename || '').trim();
  const extOrig = path.extname(orig).toLowerCase();
  if (extOrig === '.xlsm') return 'xlsm';
  if (extOrig === '.xlsx') return 'xlsx';
  return 'xlsx';
}

/** 按主键 id 读取上传模板（用于下载等场景） */
function getExportTemplateByPrimaryId(templateRowId) {
  const id = String(templateRowId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, name,
              export_type_id AS exportTypeId,
              dest_platform_id AS destPlatformId,
              original_filename AS originalFilename,
              file_path AS filePath,
              sheet_name AS sheetName,
              header_row AS headerRow,
              data_start_row AS dataStartRow,
              headers_json AS headersJson
         FROM export_templates
        WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  let headers = [];
  try {
    headers = JSON.parse(row.headersJson || '[]');
  } catch {
    headers = [];
  }
  return {
    id: row.id,
    name: row.name,
    exportTypeId: row.exportTypeId,
    destPlatformId: row.destPlatformId,
    originalFilename: row.originalFilename,
    filePath: resolveExportTemplateDiskPath(row.filePath),
    sheetName: row.sheetName,
    headerRow: row.headerRow,
    dataStartRow: row.dataStartRow,
    headers,
  };
}

/**
 * 磁盘上模板文件缺失时，根据 headers_json 等元数据重建空 xlsx，并写回 file_path（与「复制模板」缺文件时的逻辑一致）。
 * @returns {{ ok: true, filePath: string } | { ok: false, error: string }}
 */
function materializeExportTemplateFileIfMissing(customTpl) {
  const rowId = String(customTpl?.id || '').trim();
  if (!rowId) return { ok: false, error: '模板 id 缺失' };
  let fp = String(customTpl.filePath || '').trim();
  if (fp && fs.existsSync(fp)) return { ok: true, filePath: fp };

  ensureExportTemplateUploadDir();
  const destPath = path.join(EXPORT_TEMPLATE_UPLOAD_DIR, `rebuilt-${rowId}-${Date.now()}.xlsx`);
  const headers = Array.isArray(customTpl.headers) ? customTpl.headers : [];
  const sheetName = String(customTpl.sheetName || '').trim() || '模板';
  const headerRow = Math.max(1, Math.floor(Number(customTpl.headerRow) || 1));
  try {
    const headerArr = headers.length ? headers.map((x) => String(x ?? '').trim()) : [];
    const aoa = Array.from({ length: headerRow - 1 }, () => []);
    aoa.push(headerArr);
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, destPath, { bookType: 'xlsx' });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '重建模板失败' };
  }
  if (!fs.existsSync(destPath)) {
    return { ok: false, error: '重建模板文件失败' };
  }
  const now = nowCstIso();
  try {
    db.prepare(`UPDATE export_templates SET file_path = ?, updated_at = ? WHERE id = ?`).run(
      toStoredExportTemplatePath(destPath),
      now,
      rowId
    );
  } catch (e) {
    try {
      fs.existsSync(destPath) && fs.unlinkSync(destPath);
    } catch {
      // ignore
    }
    return { ok: false, error: e instanceof Error ? e.message : '更新模板路径失败' };
  }
  return { ok: true, filePath: destPath };
}

const uploadExportTemplate = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureExportTemplateUploadDir();
      cb(null, EXPORT_TEMPLATE_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const base = safeExcelFilenameBase(req.body?.name || file.originalname || 'template');
      const ext = path.extname(normalizePossiblyMojibakeFilenameText(file.originalname) || '').toLowerCase();
      const useExt = ext === '.xlsx' || ext === '.xlsm' ? ext : '.xlsx';
      const stamp = Date.now();
      cb(null, `${base}-${stamp}${useExt}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xlsm') {
      cb(new Error('仅支持 .xlsx / .xlsm'));
      return;
    }
    cb(null, true);
  },
});

/** @param {unknown} draftAny
 * @param {string} exportTypeId
 * @returns {{ ok: true } | { ok: false, error: string }} */
function validateExportColumnMapDraftForStorage(draftAny, exportTypeId) {
  const want = String(exportTypeId || '').trim();
  if (!want) return { ok: false, error: 'exportTypeId 不能为空' };
  if (!draftAny || typeof draftAny !== 'object' || Array.isArray(draftAny)) {
    return { ok: false, error: 'draft 必须是对象' };
  }
  const ver = Number(draftAny.version);
  if (ver !== 2) return { ok: false, error: 'draft.version 须为 2' };
  const id = String(draftAny.exportTypeId || '').trim();
  if (!id) return { ok: false, error: 'draft.exportTypeId 不能为空' };
  if (id !== want) return { ok: false, error: 'draft.exportTypeId 与 exportTypeId 不一致' };
  if (!Array.isArray(draftAny.columns)) return { ok: false, error: 'draft.columns 须为数组' };
  if (draftAny.columns.length > 2000) return { ok: false, error: '映射列数过多' };
  return { ok: true };
}

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const PORT = Number(process.env.PORT || 3780);
const DATA_DIR = path.dirname(process.env.DB_PATH || '');
ensureExportPlatformCatalogAndMap();

const uploadReplaceImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//i.test(String(file.mimetype || ''))) cb(null, true);
    else cb(new Error('仅支持图片文件（image/*）'));
  },
});

function extForReplacementMime(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('jpg')) return '.jpg';
  // e.g. image/bmp, image/tiff, image/svg+xml ...
  const mm = m.match(/^image\/([a-z0-9.+-]+)$/i);
  if (mm && mm[1]) {
    const ext = mm[1].replace('+xml', '');
    return `.${ext}`;
  }
  return '.jpg';
}

/** 拖拽上传时 mimetype 常为 octet-stream，优先用原始文件名的后缀 */
function extForUploadedImage(file) {
  const base = path.basename(String(file?.originalname || ''));
  const ext = path.extname(base).toLowerCase();
  // 任意扩展名：优先用用户上传文件名的后缀
  if (ext) return ext;
  return extForReplacementMime(file?.mimetype);
}

/** 替换图片时优先保持原文件扩展名（以磁盘/manifest 旧文件名为准） */
function extForExistingFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return '.png';
  if (ext === '.webp') return '.webp';
  if (ext === '.gif') return '.gif';
  if (ext === '.jpg' || ext === '.jpeg') return ext;
  return null;
}

// 简单的后台下载队列，避免并发过高
const imageJobs = [];
let imageWorkerRunning = false;

/** 下载失败后延迟自动重试（网络抖动等）；服务端重启后计数清零 */
const IMAGE_DOWNLOAD_RETRY_DELAY_MS = 30_000;
const IMAGE_DOWNLOAD_MAX_AUTO_RETRIES = 10;
const imageDownloadAutoRetryCounts = new Map();
const imageDownloadRetryTimers = new Map();

function clearImageDownloadRetryTimer(collectionId) {
  const id = Number(collectionId);
  const t = imageDownloadRetryTimers.get(id);
  if (t != null) clearTimeout(t);
  imageDownloadRetryTimers.delete(id);
}

function resetImageDownloadRetryState(collectionId) {
  const id = Number(collectionId);
  imageDownloadAutoRetryCounts.delete(id);
  clearImageDownloadRetryTimer(id);
}

function buildImageJobFromCollectionId(collectionId) {
  const id = Number(collectionId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = db
    .prepare(
      'SELECT platform, generic_data_json, platform_data_json, data_json, images_storage FROM collections WHERE id = ?'
    )
    .get(id);
  if (!row) return null;
  let rawRows = [];
  try {
    const data = JSON.parse(getGenericJsonString(row) || '{}');
    rawRows = rawRowsFromStoredData(data);
  } catch {
    return null;
  }
  if (!rawRows.length) {
    try {
      const plat = JSON.parse(getPlatformJsonString(row) || '{}');
      rawRows = rawRowsFromStoredData(plat);
    } catch {
      /* ignore */
    }
  }
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const rows = processCollectionRows(row.platform, rawRows);
  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const useOss = collectionUsesOss(row.images_storage);
  return { collectionId: id, dataDir, rows, useOss };
}

function scheduleImageDownloadRetry(collectionId) {
  const id = Number(collectionId);
  if (!Number.isFinite(id) || id <= 0) return;
  const n = imageDownloadAutoRetryCounts.get(id) || 0;
  if (n >= IMAGE_DOWNLOAD_MAX_AUTO_RETRIES) {
    console.warn('[images] auto-retry limit reached, collection', id);
    return;
  }
  clearImageDownloadRetryTimer(id);
  const t = setTimeout(() => {
    imageDownloadRetryTimers.delete(id);
    const job = buildImageJobFromCollectionId(id);
    if (!job) {
      console.warn(
        '[images] auto-retry skipped: cannot build job (no rows in generic/platform JSON?), collection',
        id
      );
      return;
    }
    imageDownloadAutoRetryCounts.set(id, n + 1);
    console.log('[images] auto-retry download enqueue', id, 'attempt', n + 1);
    enqueueImageJob(job);
  }, IMAGE_DOWNLOAD_RETRY_DELAY_MS);
  imageDownloadRetryTimers.set(id, t);
}

function enqueueImageJob(job) {
  imageJobs.push(job);
  if (!imageWorkerRunning) runImageWorker();
}

async function runImageWorker() {
  imageWorkerRunning = true;
  while (imageJobs.length) {
    const job = imageJobs.shift();
    try {
      const { main, gallery, detail } = extractImageUrlsFromRows(job.rows);
      db.prepare(
        "UPDATE collections SET images_status = 'pending', images_error = NULL WHERE id = ?"
      ).run(job.collectionId);
      notifyCollectionChangedById(job.collectionId, 'images-pending');
      const dl = await downloadCollectionImages({
        collectionId: job.collectionId,
        dataDir: job.dataDir,
        mainUrls: main,
        galleryUrls: gallery,
        detailUrls: detail,
        useOss: job.useOss !== undefined ? job.useOss : collectionUsesOss(null),
      });
      db.prepare(
        "UPDATE collections SET images_status = 'done', images_downloaded_at = ?, images_error = NULL, images_manifest_json = ? WHERE id = ?"
      ).run(
        nowCstIso(),
        JSON.stringify({
          mainFiles: dl.mainFiles || [],
          galleryFiles: dl.galleryFiles || [],
          detailFiles: dl.detailFiles || [],
        }),
        job.collectionId
      );
      resetImageDownloadRetryState(job.collectionId);
      notifyCollectionChangedById(job.collectionId, 'images-done');
      const ownerRow = db.prepare('SELECT user_id FROM collections WHERE id = ?').get(job.collectionId);
      const ownerId = Number(ownerRow?.user_id);
      if (
        isPixianConfigured() &&
        ((dl.mainFiles || []).length || (dl.galleryFiles || []).length) &&
        userWantsCollectionAutoNobg(ownerId)
      ) {
        enqueueNobgAfterDownload(job.collectionId, { onlyMain: false });
      }
    } catch (e) {
      db.prepare(
        "UPDATE collections SET images_status = 'failed', images_error = ?, images_manifest_json = NULL WHERE id = ?"
      ).run(String(e?.message || e), job.collectionId);
      notifyCollectionChangedById(job.collectionId, 'images-failed');
      scheduleImageDownloadRetry(job.collectionId);
    }
  }
  imageWorkerRunning = false;
}

/** MiMo 标题/描述/关键字富化与颜色翻译：先快速 INSERT，再串行 UPDATE，避免上报接口长时间阻塞 */
const collectionAiJobs = [];
let collectionAiWorkerRunning = false;
let collectionAiSkipWarned = false;

function enqueueCollectionAiPostProcess(collectionId) {
  const id = Number(collectionId);
  if (!Number.isFinite(id) || id <= 0) {
    console.error('[collections] AI post-process: invalid collection id', collectionId);
    return;
  }
  collectionAiJobs.push({ collectionId: id });
  if (!collectionAiWorkerRunning) {
    void runCollectionAiWorker().catch((e) => {
      console.error('[collections] AI worker crashed', e);
      collectionAiWorkerRunning = false;
    });
  }
}

/**
 * 确保 collections.amazon_parent_sku 已生成（全库唯一）。
 * 触发时机：采集入库后的 AI 自动处理（amazon enrichKey）。
 */
function ensureAmazonParentSkuForCollectionId(collectionId) {
  const id = Number(collectionId);
  if (!Number.isFinite(id) || id <= 0) return '';
  try {
    const got = db.prepare('SELECT amazon_parent_sku AS s FROM collections WHERE id = ?').get(id);
    const existing = String(got?.s ?? '').trim();
    if (existing) return existing;
  } catch {
    // ignore
  }
  // 生成并写入（最多 20 次）
  try {
    const existsStmt = db.prepare('SELECT 1 AS ok FROM collections WHERE amazon_parent_sku = ? LIMIT 1');
    const writeStmt = db.prepare('UPDATE collections SET amazon_parent_sku = ? WHERE id = ?');
    for (let i = 0; i < 20; i++) {
      const candidate = generateAmazonParentSellerSku();
      const exists = existsStmt.get(candidate);
      if (exists) continue;
      writeStmt.run(candidate, id);
      return candidate;
    }
  } catch (e) {
    console.error('[collections] ensure amazon_parent_sku failed', id, e?.message || e);
  }
  // 兜底再读一次
  try {
    const got = db.prepare('SELECT amazon_parent_sku AS s FROM collections WHERE id = ?').get(id);
    return String(got?.s ?? '').trim();
  } catch {
    return '';
  }
}

async function runCollectionAiWorker() {
  collectionAiWorkerRunning = true;
  try {
    while (collectionAiJobs.length) {
      const job = collectionAiJobs.shift();
      const cid = job?.collectionId;
      if (cid == null || !Number.isFinite(cid)) continue;
      const setAiStatus = (st) => {
        try {
          db.prepare('UPDATE collections SET ai_post_status = ? WHERE id = ?').run(st, cid);
          notifyCollectionChangedById(cid, 'ai-status');
        } catch (err) {
          console.error('[collections] ai_post_status update failed', cid, err);
        }
      };
      try {
        if (!isMimoConfigured() || !isMimoAutoEnrichEnabled()) {
          if (!collectionAiSkipWarned) {
            collectionAiSkipWarned = true;
            console.warn(
              '[collections] AI 后处理已跳过：请在本机 server/.env 配置当前 AI_PROVIDER 对应的 API Key，并勿将 MIMO_AUTO_ENRICH 设为 0（本条仅提示一次）'
            );
          }
          setAiStatus('skipped');
          continue;
        }
        const row = db
          .prepare(
            'SELECT user_id, generic_data_json, platform_data_json, data_json, export_dest_platform_id FROM collections WHERE id = ?'
          )
          .get(cid);
        if (!row) {
          console.warn('[collections] AI post-process: collection not found, id=', cid);
          setAiStatus('failed');
          continue;
        }
        let data;
        try {
          data = JSON.parse(getGenericJsonString(row) || '{}');
        } catch (e) {
          console.error('[collections] AI post-process: invalid generic_data_json', cid, e);
          setAiStatus('failed');
          continue;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          setAiStatus('failed');
          continue;
        }

        /** 通用数据：仅含插件上报 + 服务端清洗（processCollectionRows），不得写入 MiMo 翻译/标题描述富化 */
        const genericJsonFrozen = JSON.stringify(data);
        const work = JSON.parse(genericJsonFrozen);
        const enrichKey = resolveEnrichPlatformKeyFromCollectionRow(row);

        // 非 amazon：当前不定义专属平台规则时，平台数据应与插件通用数据一致（不做任何转化/AI 写回）。
        if (enrichKey !== 'amazon') {
          try {
            db.prepare(
              `UPDATE collections
                  SET generic_data_json = ?,
                      platform_data_json = ?,
                      data_json = ?,
                      ai_post_status = ?,
                      ai_prompt_platform_key = ?,
                      ai_prompt_profile_id = '',
                      ai_prompt_profile_name = '',
                      ai_prompt_profile_set_at = datetime('now','+8 hours')
                WHERE id = ?`
            ).run(genericJsonFrozen, genericJsonFrozen, genericJsonFrozen, 'done', String(enrichKey || ''), cid);
            notifyCollectionChangedById(cid, 'ai-done');
          } catch (e) {
            console.error('[collections] non-amazon platform snapshot failed', cid, e);
            setAiStatus('failed');
          }
          continue;
        }

        try {
          const prof = getCollectionAiPromptProfiles(enrichKey, row.user_id);
          db.prepare(
            `UPDATE collections
                SET ai_prompt_profile_id = ?,
                    ai_prompt_profile_name = ?,
                    ai_prompt_platform_key = ?,
                    ai_prompt_profile_set_at = datetime('now','+8 hours')
              WHERE id = ?`
          ).run(
            String(prof.activeProfileId || ''),
            String(prof.activeProfileName || ''),
            String(prof.platformKey || ''),
            cid
          );
        } catch (e) {
          console.error('[collections] ai prompt profile snapshot failed', cid, e);
        }

        if (Array.isArray(work.rows) && work.rows.length) {
          try {
            work.rows = await enrichCollectedRowsWithAi(work.rows, {
              enrichPlatformKey: enrichKey,
              userId: row.user_id,
            });
          } catch (e) {
            console.error('[collections] MiMo auto enrich failed (post-insert)', cid, e);
          }
        }
        const colorDetailResults = await Promise.allSettled([
          translateCollectionColorsWithAi(work, { enrichPlatformKey: enrichKey }),
        ]);
        colorDetailResults.forEach((r, i) => {
          if (r.status === 'rejected') {
            console.error('[collections] color translate failed (post-insert)', cid, r.reason);
          }
        });
        const platformAfter = genericToPlatformDataByEnrichKey(work, enrichKey);
        try {
          await translateCollectionDetailsWithAi(platformAfter, { enrichPlatformKey: enrichKey });
        } catch (e) {
          console.error('[collections] detail translate failed (post-insert)', cid, e);
        }
        try {
          await generateCollectionSearchKeywordsWithAi(platformAfter, {
            enrichPlatformKey: enrichKey,
            userId: row.user_id,
          });
        } catch (e) {
          console.error('[collections] search keywords enrich failed (post-insert)', cid, e);
        }
        const pStr = JSON.stringify(platformAfter);
        // 父 SKU：在 AI 后处理阶段生成并落库（方便后续列表展示/查询）
        ensureAmazonParentSkuForCollectionId(cid);
        db.prepare(
          'UPDATE collections SET generic_data_json = ?, platform_data_json = ?, data_json = ?, ai_post_status = ? WHERE id = ?'
        ).run(genericJsonFrozen, pStr, pStr, 'done', cid);
        notifyCollectionChangedById(cid, 'ai-done');
        console.log('[collections] AI post-process done, id=', cid);
      } catch (e) {
        console.error('[collections] AI post-process failed', cid, e);
        setAiStatus('failed');
      }
    }
  } finally {
    collectionAiWorkerRunning = false;
    if (collectionAiJobs.length) {
      void runCollectionAiWorker().catch((err) => {
        console.error('[collections] AI worker crashed (re-run)', err);
        collectionAiWorkerRunning = false;
      });
    }
  }
}

/** 进程启动：恢复未完成的 AI 后处理；若未配置 MiMo 则将 pending 标为 skipped，避免前台永久「处理中」 */
function resumePendingCollectionAiJobs() {
  const wants = isMimoConfigured() && isMimoAutoEnrichEnabled();
  if (!wants) {
    try {
      db.prepare(`UPDATE collections SET ai_post_status = 'skipped' WHERE ai_post_status = 'pending'`).run();
    } catch (e) {
      console.error('[collections] flush pending ai_post_status failed', e);
    }
    return;
  }
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id FROM collections WHERE ai_post_status = 'pending' ORDER BY id ASC LIMIT 500`
      )
      .all();
  } catch (e) {
    console.error('[collections] resume pending AI query failed', e);
    return;
  }
  for (const r of rows) enqueueCollectionAiPostProcess(Number(r.id));
}

/** 采集主副图下载完成后是否自动去背景（个人信息默认开启，可关闭） */
function userWantsCollectionAutoNobg(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return true;
  const row = db
    .prepare('SELECT COALESCE(collection_auto_nobg, 1) AS v FROM users WHERE id = ?')
    .get(uid);
  return Number(row?.v) !== 0;
}

/** 下载完成后自动去背景：主图+副图（onlyMain=false）；未配置 Pixian 或无图片则不入队 */
const nobgJobs = [];
let nobgWorkerRunning = false;

function enqueueNobgAfterDownload(collectionId, opts = { onlyMain: false }) {
  nobgJobs.push({ collectionId, onlyMain: opts.onlyMain !== false });
  if (!nobgWorkerRunning) void runNobgWorker();
}

async function runNobgWorker() {
  nobgWorkerRunning = true;
  while (nobgJobs.length) {
    const job = nobgJobs.shift();
    try {
      await runNobgSerialized(job.collectionId, () =>
        processRemoveBackgroundForCollection(job.collectionId, {
          onlyMain: job.onlyMain !== false,
        })
      );
    } catch (e) {
      console.error('[remove-background:auto]', job.collectionId, e?.message || e);
    }
  }
  nobgWorkerRunning = false;
}

/**
 * 同一采集记录若并发去背景：各请求在开始时读到的 manifest 相同，Pixian 耗时段内彼此覆盖写回 DB，
 * 后完成的会抹掉先完成的槽位（表现为「快速连点只成功一张」）。按 collectionId 将去背景串行化。
 */
const nobgSerializedTail = new Map();
function runNobgSerialized(collectionId, fn) {
  const key = String(collectionId);
  const prev = nobgSerializedTail.get(key) || Promise.resolve();
  const next = prev.then(() => fn());
  nobgSerializedTail.set(key, next.catch(() => {}));
  return next;
}

/**
 * 对指定采集记录执行去背景（需已 images_status=done 且 manifest 有文件；成功/失败均写回 DB）
 * @param {{ onlyMain?: boolean }} [options] onlyMain=true 时只处理主图（用于下载后自动任务）；默认 false 处理主图+副图（手动接口）
 * @returns {{ mainCount: number, galleryCount: number }}
 */
async function processRemoveBackgroundForCollection(id, options = {}) {
  const onlyMain = Boolean(options.onlyMain);
  const row = db
    .prepare(
      'SELECT user_id, images_manifest_json, data_json, generic_data_json, platform_data_json, images_storage FROM collections WHERE id = ?'
    )
    .get(id);
  if (!row) throw new Error('记录不存在');
  if (!isPixianConfigured()) throw new Error('未配置 Pixian 密钥');

  let manifest = {};
  try {
    manifest = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
  } catch {
    manifest = {};
  }
  let parsedForUrls = {};
  try {
    parsedForUrls = JSON.parse(getPlatformJsonString(row) || '{}');
  } catch {
    parsedForUrls = {};
  }
  const rawForUrls = rawRowsFromStoredData(parsedForUrls);
  const { main: mainUrlList, gallery: galleryUrlList } =
    extractImageUrlsFromRows(rawForUrls);

  const mainFiles = Array.isArray(manifest.mainFiles) ? manifest.mainFiles : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? manifest.galleryFiles : [];
  if (onlyMain) {
    if (!mainFiles.length) throw new Error('无主图可处理');
  } else if (!mainFiles.length && !galleryFiles.length) {
    throw new Error('没有可处理的本地图片');
  }

  const ownerUserId = Number(row.user_id);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) throw new Error('记录用户无效');
  const needCredits =
    mainFiles.map((x) => String(x || '').trim()).filter(Boolean).length +
    (onlyMain ? 0 : galleryFiles.map((x) => String(x || '').trim()).filter(Boolean).length);
  if (needCredits > 0) {
    const credits = getUserCredits(ownerUserId).nobgCredits;
    if (credits < needCredits) throw new Error('去背景次数不足');
  }

  const oc = getOssConfig();
  const useOss = collectionUsesOss(row.images_storage) && oc.enabled;
  const ossClient = useOss ? newOssClient() : null;

  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const collectionDir = absCollectionImagesRoot(dataDir, id);
  const mainDir = path.join(collectionDir, 'main');
  const galleryDir = path.join(collectionDir, 'gallery');
  const mainNobgDir = path.join(collectionDir, 'main_nobg');
  const galleryNobgDir = path.join(collectionDir, 'gallery_nobg');

  db.prepare(
    "UPDATE collections SET images_nobg_status = 'pending', images_nobg_error = NULL WHERE id = ?"
  ).run(id);

  try {
    const mainFilesNobg = [];
    const galleryFilesNobg = [];

    if (!useOss) {
      await fsp.rm(mainNobgDir, { recursive: true }).catch(() => {});
      if (!onlyMain) {
        await fsp.rm(galleryNobgDir, { recursive: true }).catch(() => {});
      }
    }

    if (mainFiles.length) {
      if (!useOss) await fsp.mkdir(mainNobgDir, { recursive: true });
      for (let i = 0; i < mainFiles.length; i++) {
        const fn = mainFiles[i];
        const name = String(fn || '').trim();
        if (!name) continue;
        const c = consumeUserCredits(ownerUserId, 'nobg_credits', 1);
        if (!c.ok) throw new Error('去背景次数不足');
        let pngBuf;
        const sourceUrl = String(mainUrlList[i] || '').trim();
        const ossFallbackUrl = useOss ? buildOssPublicUrl(id, 'main', name) : '';
        if (!onlyMain) {
          // 手动去背景：必须使用当前存储的图片（支持用户替换后重跑），避免回退到采集时的原始 URL
          if (useOss) {
            if (ossFallbackUrl) {
              pngBuf = await removeBackgroundFromImageUrl(ossFallbackUrl);
            } else {
              const key = ossKeyForCollectionImage(id, 'main', name);
              const got = await ossClient.get(key);
              const buf = Buffer.isBuffer(got?.content) ? got.content : Buffer.from(got?.content || '');
              pngBuf = await removeBackgroundFromBuffer(buf, name);
            }
          } else {
            const absIn = path.join(mainDir, name);
            if (!fs.existsSync(absIn)) throw new Error(`缺少文件 main/${name}`);
            const buf = await fsp.readFile(absIn);
            pngBuf = await removeBackgroundFromBuffer(buf, name);
          }
        } else if (sourceUrl || ossFallbackUrl) {
          // 自动任务：优先使用原始 URL（速度更快）
          pngBuf = await removeBackgroundFromImageUrl(sourceUrl || ossFallbackUrl);
        } else {
          const absIn = path.join(mainDir, name);
          if (!fs.existsSync(absIn)) throw new Error(`缺少文件 main/${name}`);
          const buf = await fsp.readFile(absIn);
          pngBuf = await removeBackgroundFromBuffer(buf, name);
        }
        const outName = `${path.parse(name).name}.jpeg`;
        if (useOss) {
          const key = ossKeyForCollectionImage(id, 'main_nobg', outName);
          await ossClient.put(key, pngBuf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
            ossClient.put(key, pngBuf)
          );
        } else {
          await fsp.writeFile(path.join(mainNobgDir, outName), pngBuf);
        }
        mainFilesNobg.push(outName);
      }
    }

    if (!onlyMain && galleryFiles.length) {
      if (!useOss) await fsp.mkdir(galleryNobgDir, { recursive: true });
      for (let i = 0; i < galleryFiles.length; i++) {
        const fn = galleryFiles[i];
        const name = String(fn || '').trim();
        if (!name) continue;
        const c = consumeUserCredits(ownerUserId, 'nobg_credits', 1);
        if (!c.ok) throw new Error('去背景次数不足');
        let pngBuf;
        const sourceUrl = String(galleryUrlList[i] || '').trim();
        const ossFallbackUrl = useOss ? buildOssPublicUrl(id, 'gallery', name) : '';
        // 手动去背景（onlyMain=false）：同上，使用当前存储图片
        if (useOss) {
          if (ossFallbackUrl) {
            pngBuf = await removeBackgroundFromImageUrl(ossFallbackUrl);
          } else {
            const key = ossKeyForCollectionImage(id, 'gallery', name);
            const got = await ossClient.get(key);
            const buf = Buffer.isBuffer(got?.content) ? got.content : Buffer.from(got?.content || '');
            pngBuf = await removeBackgroundFromBuffer(buf, name);
          }
        } else {
          const absIn = path.join(galleryDir, name);
          if (!fs.existsSync(absIn)) throw new Error(`缺少文件 gallery/${name}`);
          const buf = await fsp.readFile(absIn);
          pngBuf = await removeBackgroundFromBuffer(buf, name);
        }
        const outName = `${path.parse(name).name}.jpeg`;
        if (useOss) {
          const key = ossKeyForCollectionImage(id, 'gallery_nobg', outName);
          await ossClient.put(key, pngBuf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
            ossClient.put(key, pngBuf)
          );
        } else {
          await fsp.writeFile(path.join(galleryNobgDir, outName), pngBuf);
        }
        galleryFilesNobg.push(outName);
      }
    }

    const nextManifest = {
      ...manifest,
      mainFilesNobg,
    };
    if (!onlyMain) {
      nextManifest.galleryFilesNobg = galleryFilesNobg;
    }

    db.prepare(
      `UPDATE collections SET
        images_manifest_json = ?,
        images_nobg_status = 'done',
        images_nobg_at = ?,
        images_nobg_error = NULL
       WHERE id = ?`
    ).run(JSON.stringify(nextManifest), nowCstIso(), id);

    return {
      mainCount: mainFilesNobg.length,
      galleryCount: onlyMain ? 0 : galleryFilesNobg.length,
    };
  } catch (e) {
    const errMsg = String(e?.message || e);
    let prev = {};
    try {
      prev = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
    } catch {
      prev = {};
    }
    delete prev.mainFilesNobg;
    if (!onlyMain) delete prev.galleryFilesNobg;
    db.prepare(
      `UPDATE collections SET
        images_manifest_json = ?,
        images_nobg_status = 'failed',
        images_nobg_error = ?
       WHERE id = ?`
    ).run(JSON.stringify(prev), errMsg, id);
    if (!useOss) {
      await fsp.rm(mainNobgDir, { recursive: true }).catch(() => {});
      if (!onlyMain) await fsp.rm(galleryNobgDir, { recursive: true }).catch(() => {});
    }
    throw new Error(errMsg);
  }
}

/**
 * 单张去背景：用于用户手动替换某张图片后，仅重跑对应槽位（不影响其它槽位）。
 * - role: main | gallery
 * - index: 槽位下标
 * @returns {{ outFilename: string }}
 */
async function processRemoveBackgroundForOneSlot(id, role, index) {
  const cid = Number(id);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('无效的 id');
  const r = String(role || '').trim();
  if (r !== 'main' && r !== 'gallery') throw new Error('role 须为 main 或 gallery');
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) throw new Error('无效的 index');

  const row = db
    .prepare(
      'SELECT user_id, images_manifest_json, data_json, generic_data_json, platform_data_json, images_storage FROM collections WHERE id = ?'
    )
    .get(cid);
  if (!row) throw new Error('记录不存在');
  if (!isPixianConfigured()) throw new Error('未配置 Pixian 密钥');

  let manifest = {};
  try {
    manifest = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
  } catch {
    manifest = {};
  }

  const mainFiles = Array.isArray(manifest.mainFiles) ? manifest.mainFiles : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? manifest.galleryFiles : [];
  const srcFiles = r === 'main' ? mainFiles : galleryFiles;
  if (idx >= srcFiles.length) throw new Error('索引超出范围');
  const srcName = String(srcFiles[idx] || '').trim();
  if (!srcName) throw new Error('该位置无文件名');

  const ownerUserId = Number(row.user_id);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) throw new Error('记录用户无效');
  const c = consumeUserCredits(ownerUserId, 'nobg_credits', 1);
  if (!c.ok) throw new Error('去背景次数不足');

  let parsedForUrls = {};
  try {
    parsedForUrls = JSON.parse(getPlatformJsonString(row) || '{}');
  } catch {
    parsedForUrls = {};
  }
  const rawForUrls = rawRowsFromStoredData(parsedForUrls);
  const { main: mainUrlList, gallery: galleryUrlList } = extractImageUrlsFromRows(rawForUrls);
  const urlList = r === 'main' ? mainUrlList : galleryUrlList;
  const sourceUrl = String(urlList[idx] || '').trim();

  const oc = getOssConfig();
  const useOss = collectionUsesOss(row.images_storage) && oc.enabled;
  const ossClient = useOss ? newOssClient() : null;

  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const collectionDir = absCollectionImagesRoot(dataDir, cid);
  const localSrcDir = path.join(collectionDir, r);
  const localNobgDir = path.join(collectionDir, `${r}_nobg`);

  // 单张手动去背景：只使用当前存储图片，避免回退到采集时的原始 URL
  const ossFallbackUrl = useOss ? buildOssPublicUrl(cid, r, srcName) : '';
  let outBuf;
  if (useOss) {
    if (ossFallbackUrl) {
      outBuf = await removeBackgroundFromImageUrl(ossFallbackUrl);
    } else {
      const key = ossKeyForCollectionImage(cid, r, srcName);
      const got = await ossClient.get(key);
      const buf = Buffer.isBuffer(got?.content) ? got.content : Buffer.from(got?.content || '');
      outBuf = await removeBackgroundFromBuffer(buf, srcName);
    }
  } else {
    const absIn = path.join(localSrcDir, srcName);
    if (!fs.existsSync(absIn)) throw new Error(`缺少文件 ${r}/${srcName}`);
    const buf = await fsp.readFile(absIn);
    outBuf = await removeBackgroundFromBuffer(buf, srcName);
  }

  const outName = `${path.parse(srcName).name}.jpeg`;
  if (useOss) {
    const key = ossKeyForCollectionImage(cid, `${r}_nobg`, outName);
    await ossClient.put(key, outBuf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
      ossClient.put(key, outBuf)
    );
  } else {
    await fsp.mkdir(localNobgDir, { recursive: true });
    await fsp.writeFile(path.join(localNobgDir, outName), outBuf);
  }

  const mainFilesNobg = Array.isArray(manifest.mainFilesNobg) ? [...manifest.mainFilesNobg] : [];
  const galleryFilesNobg = Array.isArray(manifest.galleryFilesNobg) ? [...manifest.galleryFilesNobg] : [];
  const target = r === 'main' ? mainFilesNobg : galleryFilesNobg;
  while (target.length < srcFiles.length) target.push('');
  target[idx] = outName;
  if (r === 'main') manifest.mainFilesNobg = target;
  else manifest.galleryFilesNobg = target;

  db.prepare(
    `UPDATE collections SET
      images_manifest_json = ?,
      images_nobg_status = 'done',
      images_nobg_at = ?,
      images_nobg_error = NULL
     WHERE id = ?`
  ).run(JSON.stringify(manifest), nowCstIso(), cid);

  return { outFilename: outName };
}

/**
 * 含图片 zip 导出：用单元格内原始 URL 在「全记录 URL 列表」中的下标对应 manifest 文件名。
 * 修复：此前凡含「主图」的列一律写 mainFiles[0]，导致多 SKU/多主图列文件名相同。
 * 表格中写相对路径：images/{采集记录ID}/main|gallery/文件名，与 zip 内目录一致。
 * 若该记录已去背景（images_nobg_status=done 且 manifest 含 *FilesNobg），则优先导出为：
 * images/{采集记录ID}/main-nobg|gallery-nobg/文件名
 */
function replaceImageFieldsForExport(
  obj,
  manifest,
  mainUrlList,
  galleryUrlList,
  collectionId,
  opts = {}
) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const cid = String(collectionId);
  const mFiles = opts.mainFiles || manifest?.mainFiles;
  const gFiles = opts.galleryFiles || manifest?.galleryFiles;
  const mainFolder = String(opts.mainFolder || 'main');
  const galleryFolder = String(opts.galleryFolder || 'gallery');

  const base = relCollectionImagesDir(cid);
  const pathMain = (fn) => (fn ? `${base}/${mainFolder}/${fn}` : '');
  const pathGallery = (fn) => (fn ? `${base}/${galleryFolder}/${fn}` : '');

  const mainFileFor = (key, rawVal) => {
    const u = String(rawVal ?? '').trim();
    if (!mFiles?.length) return '';
    if (u) {
      const ix = mainUrlList.indexOf(u);
      if (ix >= 0 && ix < mFiles.length) return pathMain(mFiles[ix] || '');
    }
    const m = String(key).match(/^主图(\d+)$/);
    if (m) {
      const ix = Number(m[1]) - 1;
      if (ix >= 0 && ix < mFiles.length) return pathMain(mFiles[ix] || '');
    }
    if (String(key) === '主图') {
      return pathMain(mFiles[0] || '');
    }
    return '';
  };

  const galleryFileFor = (key, rawVal) => {
    const u = String(rawVal ?? '').trim();
    if (!gFiles?.length) return '';
    if (u) {
      const ix = galleryUrlList.indexOf(u);
      if (ix >= 0 && ix < gFiles.length) return pathGallery(gFiles[ix] || '');
    }
    const m = String(key).match(/^副图(\d+)$/);
    if (m) {
      const ix = Number(m[1]) - 1;
      if (ix >= 0 && ix < gFiles.length) return pathGallery(gFiles[ix] || '');
    }
    return '';
  };

  for (const k of Object.keys(obj)) {
    const key = String(k);
    if (key.includes('主图') && !key.includes('副图')) {
      obj[k] = mainFileFor(key, obj[k]);
    } else if (/^副图(\d+)$/.test(key)) {
      obj[k] = galleryFileFor(key, obj[k]);
    }
  }
  if (Array.isArray(obj['副图'])) {
    delete obj['副图'];
  }
}

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '20mb' }));

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/** 非 admin 用户可被授予的功能模块（由管理员在「用户权限管理」中勾选） */
const MODULE_IDS = ['collections', 'images', 'data-export', 'rules', 'export-mapping'];

function normalizeAllowedModules(role, json) {
  if (role === 'admin') return [...MODULE_IDS];
  try {
    const arr = JSON.parse(json || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x).trim()).filter((id) => MODULE_IDS.includes(id));
  } catch {
    return [];
  }
}

function sanitizeAllowedModulesInput(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const x of raw) {
    const id = String(x).trim();
    if (MODULE_IDS.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function mapUserRowForAdminApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
    allowedModules: normalizeAllowedModules(row.role, row.allowed_modules_json),
    nobgCredits: Number(row.nobg_credits ?? 0),
    aiEraseCredits: Number(row.ai_erase_credits ?? 0),
    imageGenCredits: Number(row.image_gen_credits ?? 0),
    planId: String(row.plan_id || 'trial'),
  };
}

function clampNonnegInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (!Number.isInteger(n)) return Math.max(0, Math.floor(n));
  return Math.max(0, n);
}

const MEMBERSHIP_PLANS = {
  trial: { id: 'trial', name: '体验版（免费）', priceCny: 0, perMonth: { nobg: 20, erase: 5, imageGen: 3 } },
  lite: { id: 'lite', name: '轻享版（入门）', priceCny: 89, perMonth: { nobg: 100, erase: 50, imageGen: 20 } },
  pro: { id: 'pro', name: '专业版（主推）', priceCny: 189, perMonth: { nobg: 500, erase: 200, imageGen: 120 } },
  studio: { id: 'studio', name: '工作室版（高端）', priceCny: 489, perMonth: { nobg: 3000, erase: 1000, imageGen: 500 } },
};

function currentCstYearMonth() {
  // nowCstIso(): YYYY-MM-DDTHH:mm:ss+08:00（项目内统一）
  return String(nowCstIso() || '').slice(0, 7); // YYYY-MM
}

/** 每月首次访问时按套餐发放本月配额（覆盖当前剩余次数） */
function ensureMonthlyQuotaForUser(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  const ym = currentCstYearMonth();
  if (!ym || ym.length !== 7) return;
  const row = db
    .prepare('SELECT role, plan_id AS planId, quota_ym AS quotaYm FROM users WHERE id = ?')
    .get(uid);
  if (!row) return;
  if (String(row.role || '') === 'admin') return; // 管理员不走会员配额
  const planId = String(row.planId || 'trial').trim() || 'trial';
  const plan = MEMBERSHIP_PLANS[planId] || MEMBERSHIP_PLANS.trial;
  if (String(row.quotaYm || '') === ym) return;

  db.prepare(
    `UPDATE users
        SET quota_ym = ?,
            nobg_credits = ?,
            ai_erase_credits = ?,
            image_gen_credits = ?
      WHERE id = ?`
  ).run(
    ym,
    clampNonnegInt(plan.perMonth.nobg, 0),
    clampNonnegInt(plan.perMonth.erase, 0),
    clampNonnegInt(plan.perMonth.imageGen ?? plan.perMonth.erase, 0),
    uid
  );
}

function getUserCredits(userId) {
  const roleRow = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (roleRow && String(roleRow.role || '') === 'admin') {
    return { nobgCredits: 999999, aiEraseCredits: 999999, imageGenCredits: 999999 };
  }
  const u = db
    .prepare(
      'SELECT nobg_credits AS nobgCredits, ai_erase_credits AS aiEraseCredits, image_gen_credits AS imageGenCredits FROM users WHERE id = ?'
    )
    .get(userId);
  return {
    nobgCredits: clampNonnegInt(u?.nobgCredits ?? 0),
    aiEraseCredits: clampNonnegInt(u?.aiEraseCredits ?? 0),
    imageGenCredits: clampNonnegInt(u?.imageGenCredits ?? 0),
  };
}

/** 原子扣减额度（失败=次数不足） */
function consumeUserCredits(userId, field, amount) {
  const amt = clampNonnegInt(amount, 0);
  if (amt <= 0) return { ok: true, remaining: null };
  const roleRow = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (roleRow && String(roleRow.role || '') === 'admin') return { ok: true, remaining: null };
  if (field !== 'nobg_credits' && field !== 'ai_erase_credits' && field !== 'image_gen_credits')
    return { ok: false, error: '无效的额度字段' };
  const stmt = db.prepare(
    `UPDATE users
        SET ${field} = ${field} - ?
      WHERE id = ? AND ${field} >= ?`
  );
  const info = stmt.run(amt, userId, amt);
  if (info.changes !== 1) return { ok: false, error: '次数不足' };
  const row = db.prepare(`SELECT ${field} AS n FROM users WHERE id = ?`).get(userId);
  return { ok: true, remaining: clampNonnegInt(row?.n ?? 0) };
}

function refundUserCredits(userId, field, amount) {
  const amt = clampNonnegInt(amount, 0);
  if (amt <= 0) return;
  if (field !== 'nobg_credits' && field !== 'ai_erase_credits' && field !== 'image_gen_credits') return;
  db.prepare(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`).run(amt, userId);
}

function userFromAuthToken(token) {
  const rawToken = String(token || '').trim();
  if (!rawToken) {
    const err = new Error('未登录');
    err.status = 401;
    throw err;
  }
  try {
    const decoded = jwt.verify(rawToken, JWT_SECRET);
    const sub = decoded.sub ?? decoded.id;
    if (sub == null || !Number.isFinite(Number(sub))) {
      const err = new Error('登录已失效');
      err.status = 401;
      throw err;
    }
    const row = db
      .prepare(
        'SELECT id, username, role, valid_from, valid_to, allowed_modules_json, plan_id FROM users WHERE id = ?'
      )
      .get(Number(sub));
    if (!row) {
      const err = new Error('用户不存在');
      err.status = 401;
      throw err;
    }
    if (!isUserValid(row)) {
      const err = new Error('账号不在有效授权期内');
      err.status = 403;
      throw err;
    }
    // 会员月度配额：每月首次访问发放
    ensureMonthlyQuotaForUser(row.id);
    return {
      sub: row.id,
      username: row.username,
      role: row.role,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      allowedModules: normalizeAllowedModules(row.role, row.allowed_modules_json),
      planId: String(row.role || '') === 'admin' ? 'admin' : String(row.plan_id || 'trial'),
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    const err = new Error('登录已失效');
    err.status = 401;
    throw err;
  }
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  try {
    req.user = userFromAuthToken(m[1]);
    next();
  } catch (e) {
    res.status(e?.status || 401).json({ error: e?.message || '登录已失效' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

function requireModule(mod) {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      next();
      return;
    }
    if (!req.user.allowedModules || !req.user.allowedModules.includes(mod)) {
      res.status(403).json({ error: '无权访问该功能模块' });
      return;
    }
    next();
  };
}

const collectionEventClients = new Set();

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function notifyCollectionsChanged(payload = {}) {
  const userId =
    payload.userId != null && Number.isFinite(Number(payload.userId)) ? Number(payload.userId) : null;
  const data = {
    type: payload.type || 'changed',
    collectionId: payload.collectionId ?? null,
    collectionIds: Array.isArray(payload.collectionIds) ? payload.collectionIds : undefined,
    userId,
    at: nowCstIso(),
  };
  for (const client of collectionEventClients) {
    if (!client?.res || client.res.destroyed) continue;
    const isAdmin = client.user?.role === 'admin';
    const sameUser = userId == null || Number(client.user?.sub) === userId;
    if (!isAdmin && !sameUser) continue;
    try {
      writeSseEvent(client.res, 'collections-changed', data);
    } catch {
      collectionEventClients.delete(client);
    }
  }
}

function notifyCollectionChangedById(collectionId, type = 'changed') {
  const id = Number(collectionId);
  if (!Number.isFinite(id) || id <= 0) return;
  let userId = null;
  try {
    const row = db.prepare('SELECT user_id AS userId FROM collections WHERE id = ?').get(id);
    userId = row?.userId ?? null;
  } catch {
    userId = null;
  }
  notifyCollectionsChanged({ type, collectionId: id, userId });
}

app.get('/api/collections/events', (req, res) => {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  let user;
  try {
    user = userFromAuthToken(m?.[1] || queryToken);
  } catch (e) {
    res.status(e?.status || 401).json({ error: e?.message || '登录已失效' });
    return;
  }
  if (user.role !== 'admin' && (!user.allowedModules || !user.allowedModules.includes('collections'))) {
    res.status(403).json({ error: '无权访问该功能模块' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  const client = { user, res };
  collectionEventClients.add(client);
  writeSseEvent(res, 'ready', { ok: true, at: nowCstIso() });

  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    collectionEventClients.delete(client);
  });
});

function requireAdminOrModule(mod) {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      next();
      return;
    }
    return requireModule(mod)(req, res, next);
  };
}

/** ---------- 导出映射：用户上传的空模板（自定义表头） ---------- */
app.post(
  '/api/admin/export-templates',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  uploadExportTemplate.single('file'),
  (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = String(body.name || '').trim();
      const destPlatformId = String(body.destPlatformId || '').trim();
      const sheetName = String(body.sheetName || '').trim();
      const headerRow = Number(body.headerRow);
      const dataStartRow = Number(body.dataStartRow);
      const isPublicRaw = String(body.isPublic ?? '').trim().toLowerCase();
      const isPublic = isPublicRaw === '1' || isPublicRaw === 'true' || isPublicRaw === 'yes' || isPublicRaw === 'on';

      if (!req.file) {
        res.status(400).json({ error: '未收到文件（字段名应为 file）' });
        return;
      }
      if (!name) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '空模板名称 name 不能为空' });
        return;
      }
      if (!destPlatformId) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '绑定平台 destPlatformId 不能为空' });
        return;
      }
      if (!sheetName) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '子表名称 sheetName 不能为空' });
        return;
      }
      if (!Number.isFinite(headerRow) || headerRow < 1 || headerRow > 5000) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '表头行 headerRow 无效（需为 >=1 的数字）' });
        return;
      }
      if (!Number.isFinite(dataStartRow) || dataStartRow < 1 || dataStartRow > 5000) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '数据填充起始行 dataStartRow 无效（需为 >=1 的数字）' });
        return;
      }
      if (dataStartRow <= headerRow) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'dataStartRow 必须大于 headerRow' });
        return;
      }

      const id = randomUUID();
      // 新建导出类型 ID（类似内置固定前缀 UUID）
      let exportTypeId = newLikeBuiltinExportTypeId();
      // 极低概率冲突：最多尝试 5 次
      for (let i = 0; i < 5; i++) {
        const hit = db
          .prepare('SELECT 1 AS x FROM export_templates WHERE export_type_id = ? LIMIT 1')
          .get(exportTypeId);
        if (!hit) break;
        exportTypeId = newLikeBuiltinExportTypeId();
      }
      let wb = null;
      try {
        wb = XLSX.readFile(req.file.path, { cellDates: false });
      } catch (e) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: e instanceof Error ? e.message : '读取 Excel 失败' });
        return;
      }
      const sheet = wb.Sheets && wb.Sheets[sheetName];
      if (!sheet) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: `未找到工作表「${sheetName}」，请检查子表名称` });
        return;
      }

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        range: Math.max(0, Math.floor(headerRow) - 1),
        blankrows: false,
        defval: '',
      });
      const headerArr = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
      const headers = headerArr.map((v) => normalizeHeaderCellText(v));
      const nonEmptyCount = headers.filter((x) => String(x).trim() !== '').length;
      if (headers.length === 0 || nonEmptyCount === 0) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res
          .status(400)
          .json({ error: `在第 ${Math.floor(headerRow)} 行未解析到任何列名，请核对表头行` });
        return;
      }
      if (headers.length > 5000) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        res.status(400).json({ error: '列数过多（>5000），请检查模板是否正确' });
        return;
      }

      const now = nowCstIso();
      try {
        db.prepare(
          `INSERT INTO export_templates
            (id, name, export_type_id, dest_platform_id, original_filename, file_path, sheet_name, header_row, data_start_row, headers_json, created_by_user_id, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          name,
          exportTypeId,
          destPlatformId,
          normalizePossiblyMojibakeFilenameText(req.file.originalname || ''),
          toStoredExportTemplatePath(req.file.path),
          sheetName,
          Math.floor(headerRow),
          Math.floor(dataStartRow),
          JSON.stringify(headers),
          req.user?.sub ?? null,
          isPublic ? 1 : 0,
          now,
          now
        );
      } catch (e) {
        fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path);
        const msg = e instanceof Error ? e.message : String(e);
        if (/idx_export_templates_user_name/i.test(msg) || /(created_by_user_id|name)/i.test(msg) && /unique/i.test(msg)) {
          res.status(400).json({ error: '空模板名称已存在，请换一个名称' });
          return;
        }
        res.status(500).json({ error: msg || '保存模板失败' });
        return;
      }

      res.json({
        ok: true,
        template: {
          id,
          name,
          exportTypeId,
          destPlatformId,
          sheetName,
          headerRow: Math.floor(headerRow),
          dataStartRow: Math.floor(dataStartRow),
          headers,
          originalFilename: normalizePossiblyMojibakeFilenameText(req.file.originalname || ''),
          createdByUserId: req.user?.sub ?? null,
          isPublic: isPublic ? 1 : 0,
          createdAt: now,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '上传模板失败' });
    }
  }
);

app.get(
  '/api/admin/export-templates',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const hidePublic = String(req.query.hidePublic || '').trim() === '1' || String(req.query.hidePublic || '').trim().toLowerCase() === 'true';
      const isAdmin = req.user?.role === 'admin';
      const userId = req.user?.sub ?? null;
      // hidePublic=1 的真实含义：隐藏「共享模板」（其它用户的公开模板），只保留自己创建的模板
      const where = hidePublic
        ? 'WHERE created_by_user_id = ?'
        : isAdmin
          ? ''
          : 'WHERE (created_by_user_id = ? OR is_public = 1)';
      const params = hidePublic ? [userId] : isAdmin ? [] : [userId];
      const rows = db
        .prepare(
          `SELECT id, name, original_filename AS originalFilename,
                  export_type_id AS exportTypeId,
                  dest_platform_id AS destPlatformId,
                  sheet_name AS sheetName, header_row AS headerRow, data_start_row AS dataStartRow,
                  created_by_user_id AS createdByUserId,
                  is_public AS isPublic,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM export_templates
             ${where}
            ORDER BY created_at DESC`
        )
        .all(...params);
      res.json({ templates: rows || [] });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '列出模板失败' });
    }
  }
);

app.get(
  '/api/admin/export-templates/:id',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ error: 'id 不能为空' });
        return;
      }
      const row = db
        .prepare(
          `SELECT id, name, original_filename AS originalFilename,
                  file_path AS filePath,
                  export_type_id AS exportTypeId,
                  dest_platform_id AS destPlatformId,
                  sheet_name AS sheetName, header_row AS headerRow, data_start_row AS dataStartRow,
                  headers_json AS headersJson,
                  created_by_user_id AS createdByUserId,
                  is_public AS isPublic,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM export_templates
            WHERE id = ?`
        )
        .get(id);
      if (!row) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const isAdmin = req.user?.role === 'admin';
      const uid = req.user?.sub ?? null;
      const ownerId = row.createdByUserId ?? null;
      const isPublic = Number(row.isPublic) === 1;
      if (!isAdmin && !(uid != null && ownerId != null && Number(uid) === Number(ownerId)) && !isPublic) {
        res.status(403).json({ error: '无权访问该模板' });
        return;
      }
      let headers = [];
      try {
        headers = JSON.parse(row.headersJson || '[]');
      } catch {
        headers = [];
      }
      res.json({
        template: {
          id: row.id,
          name: row.name,
          exportTypeId: row.exportTypeId,
          destPlatformId: row.destPlatformId,
          originalFilename: row.originalFilename,
          sheetName: row.sheetName,
          headerRow: row.headerRow,
          dataStartRow: row.dataStartRow,
          headers,
          createdByUserId: row.createdByUserId ?? null,
          isPublic: Number(row.isPublic) === 1 ? 1 : 0,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '读取模板失败' });
    }
  }
);

app.post(
  '/api/admin/export-templates/:id/copy',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ error: 'id 不能为空' });
        return;
      }
      const row = db
        .prepare(
          `SELECT id, name, original_filename AS originalFilename,
                  file_path AS filePath,
                  export_type_id AS exportTypeId,
                  dest_platform_id AS destPlatformId,
                  sheet_name AS sheetName, header_row AS headerRow, data_start_row AS dataStartRow,
                  headers_json AS headersJson,
                  created_by_user_id AS createdByUserId,
                  is_public AS isPublic
             FROM export_templates
            WHERE id = ?`
        )
        .get(id);
      if (!row) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const isAdmin = req.user?.role === 'admin';
      const uid = req.user?.sub ?? null;
      const ownerId = row.createdByUserId ?? null;
      const isPublic = Number(row.isPublic) === 1;
      // 允许：管理员 / 自己的模板 / 公开模板
      if (!isAdmin && !(uid != null && ownerId != null && Number(uid) === Number(ownerId)) && !isPublic) {
        res.status(403).json({ error: '无权复制该模板' });
        return;
      }
      let headers = [];
      try {
        headers = JSON.parse(row.headersJson || '[]');
      } catch {
        headers = [];
      }

      ensureExportTemplateUploadDir();
      const newId = randomUUID();
      const newExportTypeId = newLikeBuiltinExportTypeId();
      const now = nowCstIso();
      const srcName = String(row.name || '').trim() || '未命名模板';
      const baseName = `${srcName} 复制`;
      const name = `${baseName} ${Date.now()}`;
      const safeBase = safeExcelFilenameBase(baseName);
      const srcPath = resolveExportTemplateDiskPath(String(row.filePath || '').trim());
      const srcExt =
        srcPath && fs.existsSync(srcPath) ? path.extname(path.basename(srcPath)) || '.xlsx' : '.xlsx';
      const destPath = path.join(EXPORT_TEMPLATE_UPLOAD_DIR, `${safeBase}-${Date.now()}${srcExt}`);

      try {
        if (srcPath && fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        } else {
          // 兼容历史数据：模板文件已丢失，但 headers_json 仍在。此时直接生成一个新空模板文件。
          const sheetName = String(row.sheetName || '').trim() || '模板';
          const headerRow = Math.max(1, Math.floor(Number(row.headerRow) || 1));
          const headerArr = Array.isArray(headers) && headers.length ? headers.map((x) => String(x ?? '').trim()) : [];
          const aoa = Array.from({ length: headerRow - 1 }, () => []);
          aoa.push(headerArr);
          const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, sheetName);
          XLSX.writeFile(wb, destPath, { bookType: 'xlsx' });
        }
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : '复制文件失败' });
        return;
      }

      // 同步复制该模板的「导出映射草稿」（若存在）
      try {
        const oldExportTypeId = String(row.exportTypeId || '').trim();
        if (oldExportTypeId) {
          const rawDraft = getAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${oldExportTypeId}`);
          if (rawDraft != null && String(rawDraft).trim() !== '') {
            const parsed = JSON.parse(String(rawDraft));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Number(parsed.version) === 2) {
              parsed.exportTypeId = newExportTypeId;
              const validated = validateExportColumnMapDraftForStorage(parsed, newExportTypeId);
              if (validated.ok) {
                setAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${newExportTypeId}`, JSON.stringify(parsed));
              }
            }
          }
        }
      } catch {
        // ignore：复制模板本身成功即可
      }

      try {
        db.prepare(
          `INSERT INTO export_templates
            (id, name, export_type_id, dest_platform_id, original_filename, file_path, sheet_name, header_row, data_start_row, headers_json, created_by_user_id, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId,
          name,
          newExportTypeId,
          String(row.destPlatformId || ''),
          String(row.originalFilename || ''),
          toStoredExportTemplatePath(destPath),
          String(row.sheetName || ''),
          Math.floor(Number(row.headerRow) || 1),
          Math.floor(Number(row.dataStartRow) || 2),
          JSON.stringify(headers),
          req.user?.sub ?? null,
          0,
          now,
          now
        );
      } catch (e) {
        // 回滚复制出来的文件
        try {
          fs.existsSync(destPath) && fs.unlinkSync(destPath);
        } catch {
          // ignore
        }
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg || '复制模板失败' });
        return;
      }

      res.json({
        ok: true,
        template: {
          id: newId,
          name,
          exportTypeId: newExportTypeId,
          destPlatformId: String(row.destPlatformId || ''),
          sheetName: String(row.sheetName || ''),
          headerRow: Math.floor(Number(row.headerRow) || 1),
          dataStartRow: Math.floor(Number(row.dataStartRow) || 2),
          headers,
          originalFilename: String(row.originalFilename || ''),
          createdByUserId: req.user?.sub ?? null,
          isPublic: 0,
          createdAt: now,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '复制模板失败' });
    }
  }
);

app.get(
  '/api/admin/export-templates/:id/file',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const row = db
        .prepare(
          `SELECT name, original_filename AS originalFilename, file_path AS filePath,
                  created_by_user_id AS createdByUserId, is_public AS isPublic
             FROM export_templates
            WHERE id = ?`
        )
        .get(id);
      if (!row) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const isAdmin = req.user?.role === 'admin';
      const uid = req.user?.sub ?? null;
      const ownerId = row.createdByUserId ?? null;
      const isPublic = Number(row.isPublic) === 1;
      if (!isAdmin && !(uid != null && ownerId != null && Number(uid) === Number(ownerId)) && !isPublic) {
        res.status(403).json({ error: '无权下载该模板' });
        return;
      }
      const full = getExportTemplateByPrimaryId(id);
      if (!full) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const mat = materializeExportTemplateFileIfMissing(full);
      if (!mat.ok) {
        res.status(404).json({ error: mat.error || '模板文件缺失（服务器未找到文件）' });
        return;
      }
      const wantName = String(row.originalFilename || '').trim() || `${safeExcelFilenameBase(row.name)}.xlsx`;
      res.download(mat.filePath, wantName);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '下载模板失败' });
    }
  }
);

app.delete(
  '/api/admin/export-templates/:id',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ error: 'id 不能为空' });
        return;
      }
      const row = db
        .prepare(`SELECT file_path AS filePath, created_by_user_id AS createdByUserId FROM export_templates WHERE id = ?`)
        .get(id);
      if (!row) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const isAdmin = req.user?.role === 'admin';
      const uid = req.user?.sub ?? null;
      const ownerId = row.createdByUserId ?? null;
      if (!isAdmin && !(uid != null && ownerId != null && Number(uid) === Number(ownerId))) {
        res.status(403).json({ error: '无权删除该模板' });
        return;
      }
      db.prepare(`DELETE FROM export_templates WHERE id = ?`).run(id);
      const filePath = resolveExportTemplateDiskPath(String(row.filePath || '').trim());
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '删除模板失败' });
    }
  }
);

app.patch(
  '/api/admin/export-templates/:id',
  authMiddleware,
  requireAdminOrModule('export-mapping'),
  (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ error: 'id 不能为空' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const nameRaw = body.name;
      const name = nameRaw == null ? '' : String(nameRaw).trim();
      const hasSheetName = Object.prototype.hasOwnProperty.call(body, 'sheetName');
      const hasHeaderRow = Object.prototype.hasOwnProperty.call(body, 'headerRow');
      const hasDataStartRow = Object.prototype.hasOwnProperty.call(body, 'dataStartRow');
      const isPublicRaw = body.isPublic;
      const isPublic =
        String(isPublicRaw ?? '')
          .trim()
          .toLowerCase() === '1' ||
        String(isPublicRaw ?? '')
          .trim()
          .toLowerCase() === 'true';

      const row = db
        .prepare(
          `SELECT file_path AS filePath,
                  created_by_user_id AS createdByUserId,
                  headers_json AS headersJson,
                  sheet_name AS sheetName,
                  header_row AS headerRow,
                  data_start_row AS dataStartRow
             FROM export_templates
            WHERE id = ?`
        )
        .get(id);
      if (!row) {
        res.status(404).json({ error: '模板不存在' });
        return;
      }
      const isAdmin = req.user?.role === 'admin';
      const uid = req.user?.sub ?? null;
      const ownerId = row.createdByUserId ?? null;
      if (!isAdmin && !(uid != null && ownerId != null && Number(uid) === Number(ownerId))) {
        res.status(403).json({ error: '无权修改该模板' });
        return;
      }

      const now = nowCstIso();
      if (name) {
        try {
          db.prepare(`UPDATE export_templates SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/idx_export_templates_user_name/i.test(msg) || /(created_by_user_id|name)/i.test(msg) && /unique/i.test(msg)) {
            res.status(400).json({ error: '模板名称已存在，请换一个名称' });
            return;
          }
          res.status(500).json({ error: msg || '重命名失败' });
          return;
        }
      }
      // isPublic 允许单独 PATCH；没传则保持现状（body 中缺失 isPublic 时，不做变更）
      if (isPublicRaw !== undefined) {
        db.prepare(`UPDATE export_templates SET is_public = ?, updated_at = ? WHERE id = ?`).run(
          isPublic ? 1 : 0,
          now,
          id
        );
      }
      let templateMeta = null;
      if (hasSheetName || hasHeaderRow || hasDataStartRow) {
        const sheetName = hasSheetName ? String(body.sheetName || '').trim() : String(row.sheetName || '').trim();
        const headerRow = Math.floor(Number(hasHeaderRow ? body.headerRow : row.headerRow));
        const dataStartRow = Math.floor(Number(hasDataStartRow ? body.dataStartRow : row.dataStartRow));
        if (!sheetName) {
          res.status(400).json({ error: 'sheetName 不能为空' });
          return;
        }
        if (!Number.isFinite(headerRow) || headerRow < 1 || headerRow > 5000) {
          res.status(400).json({ error: '表头行 headerRow 无效（需为 >=1 的数字）' });
          return;
        }
        if (!Number.isFinite(dataStartRow) || dataStartRow < 1 || dataStartRow > 5000) {
          res.status(400).json({ error: '数据填充起始行 dataStartRow 无效（需为 >=1 的数字）' });
          return;
        }
        if (dataStartRow <= headerRow) {
          res.status(400).json({ error: 'dataStartRow 必须大于 headerRow' });
          return;
        }

        const full = getExportTemplateByPrimaryId(id);
        if (!full) {
          res.status(404).json({ error: '模板不存在' });
          return;
        }
        const mat = materializeExportTemplateFileIfMissing(full);
        if (!mat.ok) {
          res.status(404).json({ error: mat.error || '模板文件缺失（服务器未找到文件）' });
          return;
        }
        let wb = null;
        try {
          wb = XLSX.readFile(mat.filePath, { cellDates: false });
        } catch (e) {
          res.status(400).json({ error: e instanceof Error ? e.message : '读取 Excel 失败' });
          return;
        }
        const sheet = wb.Sheets && wb.Sheets[sheetName];
        if (!sheet) {
          res.status(400).json({ error: `未找到工作表「${sheetName}」，请检查 sheetName` });
          return;
        }
        const rows = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          range: Math.max(0, headerRow - 1),
          blankrows: false,
          defval: '',
        });
        const headerArr = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
        const headers = headerArr.map((v) => normalizeHeaderCellText(v));
        const nonEmptyCount = headers.filter((x) => String(x).trim() !== '').length;
        if (headers.length === 0 || nonEmptyCount === 0) {
          res.status(400).json({ error: `在第 ${headerRow} 行未解析到任何列名，请核对表头行` });
          return;
        }
        if (headers.length > 5000) {
          res.status(400).json({ error: '列数过多（>5000），请检查模板是否正确' });
          return;
        }
        db.prepare(
          `UPDATE export_templates
              SET sheet_name = ?, header_row = ?, data_start_row = ?, headers_json = ?, updated_at = ?
            WHERE id = ?`
        ).run(sheetName, headerRow, dataStartRow, JSON.stringify(headers), now, id);
        templateMeta = { id, sheetName, headerRow, dataStartRow, headers };
      }
      res.json({ ok: true, isPublic: isPublic ? 1 : 0, updatedAt: now, ...(templateMeta ? { template: templateMeta } : {}) });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '更新模板失败' });
    }
  }
);

function requireModuleAny(mods) {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      next();
      return;
    }
    const allowed = req.user.allowedModules || [];
    if (mods.some((m) => allowed.includes(m))) {
      next();
      return;
    }
    res.status(403).json({ error: '无权访问该功能模块' });
  };
}

function assertOssStsConfigured() {
  const c = assertOssConfigured();
  if (!String(c.roleArn || '').trim()) {
    throw new Error('缺少 OSS_STS_ROLE_ARN（用于发放 STS 临时凭证）');
  }
  return c;
}

async function issueOssStsForPrefix(prefix) {
  const c = assertOssStsConfigured();
  const sts = new STS({
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    endpoint: 'sts.aliyuncs.com',
    apiVersion: '2015-04-01',
  });

  const safePrefix = String(prefix || '').replace(/^\/+/, '');
  const resource = `acs:oss:*:*:${c.bucket}/${safePrefix}*`;
  const policy = {
    Version: '1',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'oss:PutObject',
          'oss:AbortMultipartUpload',
          'oss:ListParts',
          'oss:ListMultipartUploads',
        ],
        Resource: [resource],
      },
    ],
  };

  const roleSessionName = `admin-ui-${Date.now()}`;
  const resp = await sts.assumeRole(c.roleArn, JSON.stringify(policy), 3600, roleSessionName);
  // sts-sdk 返回结构在不同版本/运行时可能存在差异：Credentials 可能在顶层或 body 内
  const cred =
    resp?.Credentials ||
    resp?.credentials ||
    resp?.Body?.Credentials ||
    resp?.Body?.credentials ||
    resp?.body?.Credentials ||
    resp?.body?.credentials;
  if (!cred) {
    const keys =
      resp && typeof resp === 'object'
        ? Object.keys(resp)
        : resp == null
          ? String(resp)
          : typeof resp;
    throw new Error(
      `STS assumeRole 未返回 Credentials（roleArn=${String(c.roleArn).slice(0, 64)}…；resp keys=${JSON.stringify(keys)}）`
    );
  }

  return {
    accessKeyId: cred.AccessKeyId || cred.accessKeyId,
    accessKeySecret: cred.AccessKeySecret || cred.accessKeySecret,
    securityToken: cred.SecurityToken || cred.securityToken,
    expiration: cred.Expiration || cred.expiration,
    region: c.region,
    endpoint: c.endpoint,
    bucket: c.bucket,
    prefix: safePrefix,
    publicOrigin: c.publicOrigin,
  };
}

function isUserValid(u) {
  if (!u) return false;
  const now = nowCstIso().slice(0, 10);
  if (u.valid_from && u.valid_from > now) return false;
  if (u.valid_to && u.valid_to < now) return false;
  return true;
}

/** 上报 /api/collections 性能日志；设置 COLLECTIONS_UPLOAD_LOG=0 可关闭 */
function logCollectionsUpload(msg, extra = {}) {
  if (String(process.env.COLLECTIONS_UPLOAD_LOG || '1').trim() === '0') return;
  const base = typeof msg === 'string' ? msg : '';
  if (Object.keys(extra).length) {
    console.log('[collections upload]', base, extra);
  } else {
    console.log('[collections upload]', base);
  }
}

/** ---------- 登录 ---------- */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: '请输入用户名和密码' });
    return;
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  if (!isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内，无法登录' });
    return;
  }
  const token = signToken({
    sub: u.id,
    username: u.username,
    role: u.role,
  });
  const allowedModules = normalizeAllowedModules(u.role, u.allowed_modules_json);
  res.json({
    token,
    user: {
      id: u.id,
      username: u.username,
      role: u.role,
      validFrom: u.valid_from,
      validTo: u.valid_to,
      allowedModules,
    },
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const u = db
    .prepare('SELECT default_export_platform_id, COALESCE(collection_auto_nobg, 1) AS collection_auto_nobg FROM users WHERE id = ?')
    .get(req.user.sub);
  res.json({
    id: req.user.sub,
    username: req.user.username,
    role: req.user.role,
    validFrom: req.user.validFrom,
    validTo: req.user.validTo,
    allowedModules: req.user.allowedModules,
    planId: req.user.planId,
    defaultExportPlatformId: String(u?.default_export_platform_id || '').trim(),
    collectionAutoNobg: Number(u?.collection_auto_nobg) !== 0,
  });
});

/** ---------- 个人中心：个人信息 / 授权 / 模板 / 次数 ---------- */
app.get('/api/account/overview', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }

  const rules = db
    .prepare(
      `SELECT r.id, r.name, r.platform, r.description, r.updated_at AS updatedAt
         FROM scrape_rules r
         INNER JOIN user_rule_access a ON a.rule_id = r.id
        WHERE a.user_id = ?
        ORDER BY r.id DESC`
    )
    .all(req.user.sub);

  const templates = db
    .prepare(
      `SELECT id, name, export_type_id AS exportTypeId, dest_platform_id AS destPlatformId,
              original_filename AS originalFilename, created_by_user_id AS createdByUserId,
              is_public AS isPublic, created_at AS createdAt, updated_at AS updatedAt
         FROM export_templates
        WHERE created_by_user_id = ?
        ORDER BY updated_at DESC, created_at DESC`
    )
    .all(req.user.sub);

  const credits = getUserCredits(req.user.sub);
  res.json({
    user: {
      id: req.user.sub,
      username: req.user.username,
      role: req.user.role,
      validFrom: req.user.validFrom,
      validTo: req.user.validTo,
      allowedModules: req.user.allowedModules,
      planId: req.user.planId,
      defaultExportPlatformId: String(u?.default_export_platform_id || '').trim(),
      collectionAutoNobg: Number(u?.collection_auto_nobg ?? 1) !== 0,
    },
    credits,
    planCatalog: Object.values(MEMBERSHIP_PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      priceCny: p.priceCny,
      perMonth: p.perMonth,
    })),
    authorizedRules: rules || [],
    myExportTemplates: templates || [],
  });
});

/** ---------- 个人中心：设置默认导出平台（用于采集入库时自动选择 export_dest_platform_id） ---------- */
app.put('/api/account/default-export-platform', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = body.defaultExportPlatformId;
  const next = raw == null ? '' : String(raw).trim();
  // 允许清空；非空时做一个基本格式校验（内部 id 多为 UUID，但也兼容自定义）
  if (next && next.length > 200) {
    res.status(400).json({ error: 'defaultExportPlatformId 过长' });
    return;
  }
  db.prepare('UPDATE users SET default_export_platform_id = ? WHERE id = ?').run(next, req.user.sub);
  res.json({ ok: true, defaultExportPlatformId: next });
});

/** 个人中心：采集入库后是否自动去背景（关闭则仅保留原图，可之后在图片资源里手动去背景） */
app.put('/api/account/collection-auto-nobg', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const enabled = body.enabled === true || String(body.enabled || '').trim() === '1';
  const val = enabled ? 1 : 0;
  db.prepare('UPDATE users SET collection_auto_nobg = ? WHERE id = ?').run(val, req.user.sub);
  res.json({ ok: true, collectionAutoNobg: enabled });
});

app.post('/api/account/change-password', authMiddleware, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: '请输入旧密码与新密码' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' });
    return;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !bcrypt.compareSync(oldPassword, u.password_hash)) {
    res.status(401).json({ error: '旧密码不正确' });
    return;
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.sub);
  res.json({ ok: true });
});

/** ---------- 文本 AI 大模型（MiMo / OpenAI；旧 /api/ai/mimo 路径保留兼容） ---------- */
app.get('/api/ai/mimo/status', authMiddleware, requireModule('collections'), (_req, res) => {
  const provider = getAiProvider();
  res.json({
    configured: isMimoConfigured(),
    provider,
    model: getAiModel(provider),
  });
});

app.get('/api/ai/prompts', authMiddleware, requireModule('collections'), (req, res) => {
  const platformKey = String(req.query.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
  res.json(getCollectionAiPromptSettings(platformKey, req.user?.sub));
});

app.put('/api/ai/prompts', authMiddleware, requireModule('collections'), (req, res) => {
  try {
    const platformKey = String(req.body?.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
    const prompts = normalizeCollectionAiPromptSettings(req.body?.prompts);
    for (const [name, value] of Object.entries(prompts)) {
      if (!String(value || '').trim()) {
        res.status(400).json({ error: `提示词不能为空：${name}` });
        return;
      }
    }

    // If prompt profiles exist for this user/platform, update the active profile as well.
    const profilesKey = `collection_ai_prompt_profiles:user:${req.user?.sub}:${platformKey}`;
    const rawProfiles = getAppSetting(profilesKey) || '';
    let parsedProfiles = null;
    try {
      parsedProfiles = JSON.parse(rawProfiles);
    } catch {
      parsedProfiles = null;
    }

    const src = parsedProfiles && typeof parsedProfiles === 'object' && !Array.isArray(parsedProfiles) ? parsedProfiles : null;
    const profiles0 = src && Array.isArray(src.profiles) ? src.profiles : null;
    if (profiles0 && profiles0.length) {
      const activeId0 = String(src.activeProfileId || '').trim();
      const normalized = profiles0
        .map((p) => {
          const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
          const id = String(o.id || '').trim();
          const nm = String(o.name || '').trim();
          const pr = normalizeCollectionAiPromptSettings(o.prompts);
          if (!id || !nm) return null;
          return { id, name: nm, prompts: pr };
        })
        .filter(Boolean);

      const activeId = normalized.some((p) => p.id === activeId0)
        ? activeId0
        : normalized.some((p) => p.id === 'default')
          ? 'default'
          : normalized[0]?.id || 'default';

      const idx = normalized.findIndex((p) => p.id === activeId);
      if (idx >= 0) normalized[idx] = { ...normalized[idx], prompts };
      setAppSetting(profilesKey, JSON.stringify({ version: 1, activeProfileId: activeId, profiles: normalized }));
    }

    // Always keep legacy key in sync so existing code paths keep working.
    setAppSetting(collectionAiPromptsSettingKey(platformKey, req.user?.sub), JSON.stringify(prompts));
    res.json({ ok: true, ...getCollectionAiPromptSettings(platformKey, req.user?.sub) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/ai/prompt-profiles', authMiddleware, requireModule('collections'), (req, res) => {
  const platformKey = String(req.query.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
  res.json(getCollectionAiPromptProfiles(platformKey, req.user?.sub));
});

app.put('/api/ai/prompt-profiles/active', authMiddleware, requireModule('collections'), (req, res) => {
  try {
    const platformKey = String(req.body?.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
    const activeProfileId = String(req.body?.activeProfileId || '').trim();
    if (!activeProfileId) {
      res.status(400).json({ error: '请选择提示词类别' });
      return;
    }

    const current = getCollectionAiPromptProfiles(platformKey, req.user?.sub);
    if (!current.profiles.some((p) => p.id === activeProfileId)) {
      res.status(400).json({ error: '提示词类别不存在' });
      return;
    }

    // Persist full profile list + active id (avoid "activeId only" states that can't resolve non-default profiles).
    const key = `collection_ai_prompt_profiles:user:${req.user?.sub}:${platformKey}`;
    setAppSetting(key, JSON.stringify({ version: 1, activeProfileId, profiles: current.profiles }));

    // Keep legacy key aligned with active profile for old code paths.
    const active = current.profiles.find((p) => p.id === activeProfileId);
    if (active?.prompts) {
      setAppSetting(collectionAiPromptsSettingKey(platformKey, req.user?.sub), JSON.stringify(active.prompts));
    }
    res.json({ ok: true, ...getCollectionAiPromptProfiles(platformKey, req.user?.sub) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.put('/api/ai/prompt-profile', authMiddleware, requireModule('collections'), (req, res) => {
  try {
    const platformKey = String(req.body?.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
    const profileIdRaw = String(req.body?.profileId || '').trim();
    const name = String(req.body?.name || '').trim();
    const setActive = Boolean(req.body?.setActive);
    if (!name) {
      res.status(400).json({ error: '请填写提示词类别名称' });
      return;
    }

    const prompts = normalizeCollectionAiPromptSettings(req.body?.prompts);
    for (const [k, v] of Object.entries(prompts)) {
      if (!String(v || '').trim()) {
        res.status(400).json({ error: `提示词不能为空：${k}` });
        return;
      }
    }

    const key = `collection_ai_prompt_profiles:user:${req.user?.sub}:${platformKey}`;
    const raw = getAppSetting(key) || '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const profiles0 = Array.isArray(src.profiles) ? src.profiles : [];

    const profiles = profiles0
      .map((p) => {
        const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
        const id = String(o.id || '').trim();
        const nm = String(o.name || '').trim();
        const pr = normalizeCollectionAiPromptSettings(o.prompts);
        if (!id || !nm) return null;
        return { id, name: nm, prompts: pr };
      })
      .filter(Boolean);

    const nextId =
      profileIdRaw ||
      `p_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;

    const existsIdx = profiles.findIndex((p) => p.id === nextId);
    if (existsIdx >= 0) {
      profiles[existsIdx] = { id: nextId, name, prompts };
    } else {
      profiles.push({ id: nextId, name, prompts });
    }

    const activeProfileId = setActive ? nextId : String(src.activeProfileId || '').trim();
    setAppSetting(key, JSON.stringify({ version: 1, activeProfileId, profiles }));

    // Keep legacy key in sync: make active profile the one used by old code paths.
    if (setActive) {
      setAppSetting(collectionAiPromptsSettingKey(platformKey, req.user?.sub), JSON.stringify(prompts));
    }

    res.json({ ok: true, profileId: nextId, ...getCollectionAiPromptProfiles(platformKey, req.user?.sub) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.delete('/api/ai/prompt-profile', authMiddleware, requireModule('collections'), (req, res) => {
  try {
    const platformKey = String(req.body?.platformKey || 'amazon').trim().toLowerCase() || 'amazon';
    const profileId = String(req.body?.profileId || '').trim();
    if (!profileId) {
      res.status(400).json({ error: '请选择要删除的提示词类别' });
      return;
    }
    if (profileId === 'default') {
      res.status(400).json({ error: '默认提示词类别不能删除' });
      return;
    }

    const current = getCollectionAiPromptProfiles(platformKey, req.user?.sub);
    const exists = current.profiles.some((p) => p.id === profileId);
    if (!exists) {
      res.status(400).json({ error: '提示词类别不存在' });
      return;
    }

    const profiles = current.profiles.filter((p) => p.id !== profileId);
    const activeProfileId = current.activeProfileId === profileId ? 'default' : current.activeProfileId;
    const key = `collection_ai_prompt_profiles:user:${req.user?.sub}:${platformKey}`;
    setAppSetting(key, JSON.stringify({ version: 1, activeProfileId, profiles }));

    if (activeProfileId === 'default') {
      const fallback = profiles.find((p) => p.id === 'default');
      if (fallback?.prompts) {
        setAppSetting(collectionAiPromptsSettingKey(platformKey, req.user?.sub), JSON.stringify(fallback.prompts));
      }
    }

    res.json({ ok: true, ...getCollectionAiPromptProfiles(platformKey, req.user?.sub) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/ai/mimo/chat', authMiddleware, requireModule('collections'), async (req, res) => {
  if (!isMimoConfigured()) {
    res.status(503).json({
      error: getAiProvider() === 'openai' ? '未配置 OPENAI_API_KEY' : '未配置 MIMO_API_KEY',
    });
    return;
  }
  const body = req.body || {};
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: '请提供 messages 数组' });
    return;
  }
  if (messages.length > 30) {
    res.status(400).json({ error: 'messages 过多' });
    return;
  }
  try {
    const completion = await mimoChatCompletion({
      messages,
      model: body.model,
      max_completion_tokens: body.max_completion_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
    });
    const text = extractMessageText(completion);
    res.json({
      text,
      model: completion.model,
      provider: getAiProvider(),
      usage: completion.usage,
      id: completion.id,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    res.status(500).json({ error: msg });
  }
});

/** ---------- 图片生成（千问图像编辑/生成 qwen-image-edit） ---------- */
app.post('/api/ai/image/generate', authMiddleware, requireModule('collections'), async (req, res) => {
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  const collectionId = Number(body.collectionId);
  const storageRole = String(body.storageRole || '').trim();
  const index = Number(body.index);
  if (!prompt) {
    res.status(400).json({ error: '请提供 prompt' });
    return;
  }
  if (prompt.length > 2000) {
    res.status(400).json({ error: 'prompt 过长（最多 2000 字符）' });
    return;
  }
  let chargedUserId = null;
  try {
    const dashKey = String(process.env.DASHSCOPE_API_KEY || '').trim();
    if (!dashKey) {
      res.status(503).json({ error: '未配置 DASHSCOPE_API_KEY（千问图像编辑/生成）' });
      return;
    }
    const model = String(process.env.QWEN_IMAGE_MODEL || 'qwen-image-edit').trim() || 'qwen-image-edit';

    if (!Number.isInteger(collectionId) || collectionId <= 0) {
      res.status(400).json({ error: '请提供 collectionId（用于图像编辑输入图）' });
      return;
    }
    if (!['main', 'gallery', 'main_nobg', 'gallery_nobg', 'detail'].includes(storageRole)) {
      res.status(400).json({ error: '请提供 storageRole（main/gallery/main_nobg/gallery_nobg/detail）' });
      return;
    }
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: '请提供 index（>=0）' });
      return;
    }

    const crow = db
      .prepare('SELECT user_id, images_manifest_json, images_storage FROM collections WHERE id = ?')
      .get(collectionId);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权访问该图片' });
      return;
    }

    // 读取当前槽位图片，作为 qwen-image-edit 的输入图
    let imageBuf;
    try {
      imageBuf = await readCollectionImageBuffer({
        collectionId,
        role: storageRole,
        filename: String(body.filename || '').trim() || (() => {
          let manifest = {};
          try {
            if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
          } catch {
            manifest = {};
          }
          const arr =
            storageRole === 'main'
              ? Array.isArray(manifest.mainFiles) ? manifest.mainFiles : []
              : storageRole === 'gallery'
                ? Array.isArray(manifest.galleryFiles) ? manifest.galleryFiles : []
                : storageRole === 'main_nobg'
                  ? Array.isArray(manifest.mainFilesNobg) ? manifest.mainFilesNobg : []
                  : storageRole === 'gallery_nobg'
                    ? Array.isArray(manifest.galleryFilesNobg) ? manifest.galleryFilesNobg : []
                    : Array.isArray(manifest.detailFiles) ? manifest.detailFiles : [];
          return String(arr[index] || '').trim();
        })(),
        imagesStorage: crow.images_storage,
      });
    } catch (e) {
      res.status(400).json({ error: e?.message || '读取输入图失败' });
      return;
    }
    if (!imageBuf || !Buffer.isBuffer(imageBuf) || imageBuf.length === 0) {
      res.status(400).json({ error: '读取输入图失败：空数据' });
      return;
    }
    if (imageBuf.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: '输入图过大（>10MB），请先裁剪或压缩' });
      return;
    }

    const ownerUserId = Number(crow.user_id);
    const hold = consumeUserCredits(ownerUserId, 'image_gen_credits', 1);
    if (!hold.ok) {
      res.status(403).json({ error: '图片生成次数不足' });
      return;
    }
    chargedUserId = ownerUserId;

    const imageMime = mimeForCollectionImage(String(body.filename || '') || 'image.png') || 'image/png';
    const imageDataUrl = `data:${imageMime};base64,${imageBuf.toString('base64')}`;

    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dashKey}`,
      },
      body: JSON.stringify({
        model,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ image: imageDataUrl }, { text: prompt }],
            },
          ],
        },
        parameters: {
          n: 1,
          negative_prompt: ' ',
          prompt_extend: true,
          watermark: false,
        },
      }),
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!resp.ok) {
      refundUserCredits(ownerUserId, 'image_gen_credits', 1);
      const msg = data?.message ? String(data.message) : resp.statusText || '千问图片生成失败';
      res.status(resp.status >= 400 && resp.status < 600 ? resp.status : 500).json({ error: msg });
      return;
    }
    const imageUrl =
      data?.output?.choices?.[0]?.message?.content?.find?.((x) => x && typeof x === 'object' && typeof x.image === 'string')
        ?.image || '';
    if (!imageUrl) {
      refundUserCredits(ownerUserId, 'image_gen_credits', 1);
      res.status(500).json({ error: '千问图片生成失败：未返回 image URL' });
      return;
    }
    // 下载图片并转为 base64 返给前端（避免跨域/过期 URL）
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      refundUserCredits(ownerUserId, 'image_gen_credits', 1);
      res.status(500).json({ error: '下载千问生成图片失败' });
      return;
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const b64 = buf.toString('base64');
    res.json({ ok: true, b64, contentType: 'image/png', model, imageUrl, provider: 'dashscope' });
  } catch (e) {
    if (chargedUserId != null) refundUserCredits(chargedUserId, 'image_gen_credits', 1);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * 图片生成（局部编辑版）：用于 Stability Inpaint 传入显式 mask（解决 JPEG 无 alpha + 避免全图重绘导致“不搭边”）。
 * @body multipart/form-data:
 * - prompt（required）
 * - collectionId（required）
 * - storageRole（required）
 * - index（required）
 * - filename（optional）
 * - mask（required, PNG）
 */
// 注：之前为 Stability Inpaint 增加过带 mask 的图片生成接口（/api/ai/image/generate-inpaint）。
// 当前版本图片生成仅保留千问（DashScope qwen-image-edit），因此移除该接口。

/** 腾讯翻译：英文转中文（临时预览，不做保存） */
app.post('/api/translate/tencent', authMiddleware, requireModule('collections'), async (req, res) => {
  if (!isTencentTranslateConfigured()) {
    res.status(503).json({ error: '未配置腾讯云翻译密钥（TENCENT_SECRET_ID / TENCENT_SECRET_KEY）' });
    return;
  }
  const body = req.body || {};
  const text = String(body.text || '').trim();
  if (!text) {
    res.status(400).json({ error: '请提供待翻译的 text' });
    return;
  }
  if (text.length > 6000) {
    res.status(400).json({ error: '单次翻译文本不能超过6000字符' });
    return;
  }
  try {
    const translated = await tencentTranslate(text, body.source || 'en', body.target || 'zh');
    res.json({ text: translated });
  } catch (e) {
    const msg = e?.message || String(e);
    res.status(500).json({ error: msg });
  }
});

/** 腾讯翻译状态检查 */
app.get('/api/translate/tencent/status', authMiddleware, requireModule('collections'), (_req, res) => {
  res.json({ configured: isTencentTranslateConfigured() });
});

/** ---------- 插件：可用规则列表与详情 ---------- */
app.get('/api/plugin/rules', authMiddleware, requireModule('collections'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.platform, r.description
       FROM scrape_rules r
       INNER JOIN user_rule_access a ON a.rule_id = r.id
       WHERE a.user_id = ?
       ORDER BY r.id DESC`
    )
    .all(req.user.sub);
  res.json(rows);
});

app.get('/api/plugin/rules/:id', authMiddleware, requireModule('collections'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const ruleId = Number(req.params.id);
  const ok = db
    .prepare('SELECT 1 FROM user_rule_access WHERE user_id = ? AND rule_id = ?')
    .get(req.user.sub, ruleId);
  if (!ok) {
    res.status(403).json({ error: '无权使用该采集规则' });
    return;
  }
  const r = db.prepare('SELECT * FROM scrape_rules WHERE id = ?').get(ruleId);
  if (!r) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }
  let config;
  try {
    config = JSON.parse(r.config_json);
  } catch {
    res.status(500).json({ error: '规则数据损坏' });
    return;
  }
  res.json({
    id: r.id,
    name: r.name,
    platform: r.platform,
    description: r.description,
    config,
  });
});

/** 返回首个存在的插件源码目录，或 null（Docker/本机/仅部署 server 时路径不同，需多候选） */
function resolveChromeExtensionSourceDir() {
  const fromEnv = process.env.COLLECTION_PLUGIN_SOURCE_DIR;
  if (fromEnv && String(fromEnv).trim()) {
    const abs = path.resolve(String(fromEnv).trim());
    if (fs.existsSync(abs)) return abs;
  }
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(srcDir, '..', 'chrome-extension'), // server/chrome-extension（Docker WORKDIR=/workspace/server 时）
    path.join(srcDir, '..', '..', 'chrome-extension'), // 仓库根目录（本地 monorepo）
    path.join(process.cwd(), 'chrome-extension'),
    path.join(process.cwd(), '..', 'chrome-extension'),
  ];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** 打包 chrome-extension 目录为 ZIP，供管理端「下载采集插件」 */
app.get('/api/plugin/extension-zip', authMiddleware, requireModule('collections'), async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const extDir = resolveChromeExtensionSourceDir();
  if (!extDir) {
    res.status(404).json({ error: '服务器未找到采集插件目录（chrome-extension）' });
    return;
  }
  const manifestPath = path.join(extDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    res.status(400).json({ error: '采集插件目录缺少 manifest.json' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="ai-collection-extension.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    try {
      if (!res.headersSent) res.status(500).end(String(err?.message || err));
    } catch {
      // ignore
    }
  });
  archive.pipe(res);
  // 不再额外包一层目录：ZIP 根目录直接是插件文件（manifest.json 等）
  archive.directory(extDir, false);
  await archive.finalize();
});

/** ---------- 插件：上报采集结果（一次采集一条记录，data 内为 rows 数组） ---------- */
app.post('/api/collections', authMiddleware, requireModule('collections'), async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!u || !isUserValid(u)) {
    res.status(403).json({ error: '账号不在有效授权期内' });
    return;
  }
  const body = req.body || {};
  const ins = db.prepare(
    `INSERT INTO collections (user_id, collected_at, platform, url, data_json, generic_data_json, platform_data_json, ai_post_status, export_dest_platform_id, images_storage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const userDefaultExportDestPlatformId =
    u && typeof u.default_export_platform_id === 'string' ? u.default_export_platform_id.trim() : '';
  const systemDefaultExportDestPlatformId = String(getAppSetting('default_export_platform_id') || '').trim();
  const resolveExportDestPlatformId = (inputId) => {
    const inId = typeof inputId === 'string' ? inputId.trim() : '';
    return inId || userDefaultExportDestPlatformId || systemDefaultExportDestPlatformId || null;
  };

  if (Array.isArray(body.rows)) {
    const t0 = performance.now();
    const contentLengthIn = req.headers['content-length'];
    const platform = String(body.platform || '');
    const url = String(body.url || '');
    const collectedAt = body.collectedAt || nowCstIso();
    const rowsProcessed = processCollectionRows(platform, body.rows);
    const t1 = performance.now();
    const data = { rows: rowsProcessed };
    if (body.sku_axes && typeof body.sku_axes === 'object') {
      data.sku_axes = body.sku_axes;
    }
    const t2 = performance.now();
    let genericJson;
    let platformJson;
    try {
      genericJson = JSON.stringify(data);
      platformJson = JSON.stringify(genericToAmazonPlatformData(data));
    } catch (e) {
      res.status(500).json({ error: 'data 序列化失败' });
      return;
    }
    const t3 = performance.now();
    const wantsAiPost = isMimoConfigured() && isMimoAutoEnrichEnabled();
    const aiIni = wantsAiPost ? 'pending' : 'skipped';
    const exportDestPlatformId = resolveExportDestPlatformId(body.exportDestPlatformId);
    const imagesStorageNorm = normalizeImagesStorageInput(body.imagesStorage ?? body.imageStorage);
    try {
      if (imagesStorageNorm === 'oss') assertImagesStorageOssAllowed();
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
      return;
    }
    const useOssForJob = collectionUsesOss(imagesStorageNorm);
    try {
      const info = ins.run(
        req.user.sub,
        collectedAt,
        platform,
        url,
        platformJson,
        genericJson,
        platformJson,
        aiIni,
        exportDestPlatformId,
        imagesStorageNorm
      );
      const t4 = performance.now();
      if (wantsAiPost) enqueueCollectionAiPostProcess(info.lastInsertRowid);
      notifyCollectionsChanged({
        type: 'created',
        collectionId: info.lastInsertRowid,
        userId: req.user.sub,
      });
      // 异步下载主图/副图（不阻塞接口响应）
      try {
        // 本机无 DB_PATH 时，默认落到当前工作目录（通常为 server/）
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        db.prepare(
          "UPDATE collections SET images_status = 'pending', images_error = NULL WHERE id = ?"
        ).run(info.lastInsertRowid);
        notifyCollectionChangedById(info.lastInsertRowid, 'images-pending');
        enqueueImageJob({
          collectionId: info.lastInsertRowid,
          dataDir,
          rows: rowsProcessed,
          useOss: useOssForJob,
        });
      } catch {
        // ignore
      }
      const t5 = performance.now();
      const bytes = Buffer.byteLength(platformJson, 'utf8');
      logCollectionsUpload('rows 上报完成', {
        id: info.lastInsertRowid,
        userId: req.user.sub,
        rowCount: body.rows.length,
        bytesOut: bytes,
        contentLengthIn: contentLengthIn != null ? Number(contentLengthIn) : null,
        ms: {
          processCollectionRows: +(t1 - t0).toFixed(2),
          skuAxesAndData: +(t2 - t1).toFixed(2),
          jsonStringify: +(t3 - t2).toFixed(2),
          dbInsert: +(t4 - t3).toFixed(2),
          enqueueImageAndPending: +(t5 - t4).toFixed(2),
          totalHandler: +(t5 - t0).toFixed(2),
        },
      });
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
    return;
  }

  const { items } = body;
  if (Array.isArray(items) && items.length) {
    const prepared = [];
    for (const it of items) {
      let data = it.data != null ? it.data : {};
      data = sanitizeCollectionDataPayload(data);
      prepared.push({ ...it, data });
    }
    for (const it of prepared) {
      const sn = normalizeImagesStorageInput(it.imagesStorage ?? it.imageStorage);
      if (sn === 'oss') {
        try {
          assertImagesStorageOssAllowed();
        } catch (e) {
          res.status(400).json({ error: e?.message || String(e) });
          return;
        }
      }
    }
    const wantsAiPost = isMimoConfigured() && isMimoAutoEnrichEnabled();
    const aiIni = wantsAiPost ? 'pending' : 'skipped';
    const tLeg0 = performance.now();
    const tx = db.transaction((rows) => {
      const ids = [];
      for (const it of rows) {
        const platform = String(it.platform || '');
        const url = String(it.url || '');
        const collectedAt = it.collectedAt || nowCstIso();
        const data = it.data != null ? it.data : {};
        const platformObj = genericToAmazonPlatformData(data);
        const gJson = JSON.stringify(data);
        const pJson = JSON.stringify(platformObj);
        const exportDestPlatformId = resolveExportDestPlatformId(it.exportDestPlatformId);
        const imgSn = normalizeImagesStorageInput(it.imagesStorage ?? it.imageStorage);
        const info = ins.run(
          req.user.sub,
          collectedAt,
          platform,
          url,
          pJson,
          gJson,
          pJson,
          aiIni,
          exportDestPlatformId,
          imgSn
        );
        ids.push(info.lastInsertRowid);
      }
      return ids;
    });
    try {
      const ids = tx(prepared);
      const tLeg1 = performance.now();
      if (wantsAiPost) for (const id of ids) enqueueCollectionAiPostProcess(id);
      notifyCollectionsChanged({ type: 'created', collectionIds: ids, userId: req.user.sub });
      // 与 { rows } 上报一致：异步拉主图/副图（OSS 或本地）
      const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
      for (let i = 0; i < ids.length; i++) {
        const it = prepared[i];
        const platform = String(it.platform || '');
        const rawRows = Array.isArray(it.data?.rows) ? it.data.rows : [];
        const rowsProcessed = processCollectionRows(platform, rawRows);
        try {
          db.prepare(
            "UPDATE collections SET images_status = 'pending', images_error = NULL WHERE id = ?"
          ).run(ids[i]);
          notifyCollectionChangedById(ids[i], 'images-pending');
          enqueueImageJob({
            collectionId: ids[i],
            dataDir,
            rows: rowsProcessed,
            useOss: collectionUsesOss(
              normalizeImagesStorageInput(it.imagesStorage ?? it.imageStorage)
            ),
          });
        } catch {
          // ignore
        }
      }
      logCollectionsUpload('legacy items 上报完成', {
        count: ids.length,
        userId: req.user.sub,
        ms: { transaction: +(tLeg1 - tLeg0).toFixed(2) },
      });
      res.json({ ok: true, ids, legacy: true });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
    return;
  }

  res.status(400).json({ error: '请使用 { rows: [...] } 上报一次采集，或旧版 items 数组' });
});

/** ---------- 采集数据管理（列表/详情/删除/导出） ---------- */
function listCollectionsQuery(req) {
  const isAdmin = req.user.role === 'admin';
  /** 非管理员传 -1，EXISTS 恒为假，避免无意义子查询匹配 */
  const copyLogAdminId = isAdmin ? Number(req.user.sub) : -1;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const filterUserId = req.query.userId != null && isAdmin ? Number(req.query.userId) : null;
  const archived = String(req.query.archived || '').trim() === '1';
  const markRaw = String(req.query.mark || '')
    .trim()
    .toLowerCase();
  const platformRaw = String(req.query.platform || '').trim();
  const searchRaw = String(req.query.q || '').trim();

  let where = '1=1';
  const params = [];
  where += ' AND COALESCE(c.is_archived, 0) = ?';
  params.push(archived ? 1 : 0);
  if (!isAdmin) {
    where += ' AND c.user_id = ?';
    params.push(req.user.sub);
  } else if (filterUserId) {
    where += ' AND c.user_id = ?';
    params.push(filterUserId);
  }
  if (markRaw === 'export' || markRaw === 'pending' || markRaw === 'discard') {
    where += ' AND c.user_mark = ?';
    params.push(markRaw);
  } else if (markRaw === 'unmarked') {
    where += " AND (c.user_mark IS NULL OR TRIM(COALESCE(c.user_mark,'')) = '')";
  }
  if (searchRaw) {
    const like = `%${searchRaw.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where +=
      " AND (CAST(c.id AS TEXT) LIKE ? ESCAPE '\\' OR TRIM(COALESCE(c.amazon_parent_sku,'')) LIKE ? ESCAPE '\\' OR TRIM(COALESCE(c.platform,'')) LIKE ? ESCAPE '\\' OR TRIM(COALESCE(c.url,'')) LIKE ? ESCAPE '\\' OR TRIM(COALESCE(u.username,'')) LIKE ? ESCAPE '\\' OR CAST(c.user_id AS TEXT) LIKE ? ESCAPE '\\')";
    params.push(like, like, like, like, like, like);
  }

  const paramsForDistinct = [...params];
  const whereForDistinct = where;

  if (platformRaw) {
    where += " AND TRIM(COALESCE(c.platform,'')) = ?";
    params.push(platformRaw);
  }

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM collections c
         LEFT JOIN users u ON u.id = c.user_id
        WHERE ${where}`
    )
    .get(...params).n;

  const rows = db
    .prepare(
      `SELECT c.id, c.collected_at AS collectedAt, c.platform, c.url, c.user_id AS userId,
              c.amazon_parent_sku AS amazonParentSku,
              c.exported_at AS exportedAt,
              c.archived_at AS archivedAt,
              COALESCE(c.is_archived, 0) AS isArchived,
              c.export_dest_platform_id AS exportDestPlatformId,
              COALESCE(c.images_status,'pending') AS imagesStatus,
              c.images_downloaded_at AS imagesDownloadedAt,
              c.images_error AS imagesError,
              c.images_nobg_status AS imagesNobgStatus,
              c.images_nobg_at AS imagesNobgAt,
              c.images_nobg_error AS imagesNobgError,
              c.ai_post_status AS aiPostStatus,
              c.ai_prompt_profile_id AS aiPromptProfileId,
              c.ai_prompt_profile_name AS aiPromptProfileName,
              c.ai_prompt_platform_key AS aiPromptPlatformKey,
              c.ai_prompt_profile_set_at AS aiPromptProfileSetAt,
              c.user_mark AS userMark,
              c.images_storage AS imagesStorage,
              u.username,
              EXISTS (
                SELECT 1 FROM collections p
                WHERE p.user_id = c.user_id
                  AND TRIM(COALESCE(p.url, '')) = TRIM(COALESCE(c.url, ''))
                  AND TRIM(COALESCE(c.url, '')) != ''
                  AND (
                    p.collected_at < c.collected_at
                    OR (p.collected_at = c.collected_at AND p.id < c.id)
                  )
              ) AS urlDuplicate,
              EXISTS (
                SELECT 1 FROM admin_archive_copy_log l
                WHERE l.source_collection_id = c.id AND l.admin_user_id = ?
              ) AS alreadyCopiedByMe
       FROM collections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE ${where}
       ORDER BY c.collected_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(copyLogAdminId, ...params, limit, offset);

  // 兼容旧数据：历史已导出但未持久化父 SKU 的记录，按需补齐（写回 DB，方便展示与后续搜索）。
  // 仅对本页且 exportedAt 非空的行进行，避免列表浏览时产生大量写入。
  try {
    for (const r of rows) {
      const has = String(r.amazonParentSku ?? '').trim();
      const exported = r.exportedAt != null && String(r.exportedAt).trim() !== '';
      if (!has && exported) {
        const sku = ensureAmazonParentSkuForCollectionId(r.id);
        if (sku) r.amazonParentSku = sku;
      }
    }
  } catch {
    // ignore
  }

  const rowsOut = rows.map((r) => ({
    ...r,
    isArchived: Boolean(r.isArchived),
    urlDuplicate: Boolean(r.urlDuplicate),
    alreadyCopiedByMe: Boolean(r.alreadyCopiedByMe),
  }));

  const distinctRows = db
    .prepare(
      `SELECT DISTINCT TRIM(COALESCE(c.platform,'')) AS p
       FROM collections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE ${whereForDistinct} AND TRIM(COALESCE(c.platform,'')) != ''
       ORDER BY p`
    )
    .all(...paramsForDistinct);
  const platforms = distinctRows.map((r) => r.p).filter(Boolean);

  return { page, limit, total, rows: rowsOut, platforms };
}

function normalizeCollectionIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return Array.from(
    new Set(
      rawIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
}

function getAccessibleCollectionsForIds(req, ids) {
  const idList = normalizeCollectionIds(ids);
  if (!idList.length) return [];
  const placeholders = idList.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, user_id AS userId, exported_at AS exportedAt, COALESCE(is_archived, 0) AS isArchived
         FROM collections
        WHERE id IN (${placeholders})`
    )
    .all(...idList);
  if (req.user.role !== 'admin') {
    return rows.filter((row) => Number(row.userId) === Number(req.user.sub));
  }
  return rows;
}

/** 登录用户：导出目标平台列表（服务端维护，与 platform_enrich_map 同源 id） */
app.get(
  '/api/export/types',
  authMiddleware,
  requireModuleAny(['collections', 'data-export', 'export-mapping']),
  (req, res) => {
  try {
    const hidePublic = String(req.query.hidePublic || '').trim() === '1' || String(req.query.hidePublic || '').trim().toLowerCase() === 'true';
    const platforms = getExportPlatformCatalog();
    const isAdmin = req.user?.role === 'admin';
    const uid = req.user?.sub ?? null;
    const customRows = db
      .prepare(
        `SELECT name,
                export_type_id AS id,
                dest_platform_id AS destPlatformId,
                headers_json AS headersJson,
                created_by_user_id AS createdByUserId,
                is_public AS isPublic,
                original_filename AS originalFilename,
                file_path AS filePath
           FROM export_templates
          WHERE TRIM(COALESCE(export_type_id,'')) != ''`
      )
      .all();

    const platformById = new Map(
      (Array.isArray(platforms) ? platforms : []).map((p) => [String(p.id), p])
    );

    const custom = (Array.isArray(customRows) ? customRows : [])
      .filter((r) => {
        // hidePublic=1 的真实含义：隐藏「共享模板」（其它用户的公开模板），只保留自己创建的模板
        if (hidePublic) {
          const ownerId = r.createdByUserId ?? null;
          return uid != null && ownerId != null && Number(uid) === Number(ownerId);
        }
        if (isAdmin) return true;
        const ownerId = r.createdByUserId ?? null;
        const isPublic = Number(r.isPublic) === 1;
        return (uid != null && ownerId != null && Number(uid) === Number(ownerId)) || isPublic;
      })
      .map((r) => {
        let headers = [];
        try {
          headers = JSON.parse(r.headersJson || '[]');
        } catch {
          headers = [];
        }
        const destPlatformId = String(r.destPlatformId || '').trim();
        const plat = destPlatformId ? platformById.get(destPlatformId) : null;
        const enrichKey = String(plat?.enrichKey || '').trim().toLowerCase();
        const mode = enrichKey === 'amazon' ? 'amazon' : 'generic';
        const templateWorkbookExt = exportTemplateWorkbookExtension({
          filePath: String(r.filePath || '').trim(),
          originalFilename: String(r.originalFilename || '').trim(),
        });
        return {
          id: String(r.id),
          name: String(r.name || '').trim() || String(r.id),
          mode,
          destPlatformId,
          hasBuiltinHeaderRow: false,
          columnCount: 0,
          headerColumnCount: Array.isArray(headers) ? headers.length : 0,
          templateWorkbookExt,
        };
      })
      .filter((x) => x.id && x.destPlatformId);

    custom.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    res.json({ types: custom });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '列出导出类型失败' });
  }
});

app.get(
  '/api/export/platforms',
  authMiddleware,
  requireModuleAny(['collections', 'data-export', 'export-mapping']),
  (_req, res) => {
  try {
    res.json({ platforms: getExportPlatformCatalog() });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** 登录用户可读：用于导出弹窗拉取服务端草稿；管理员或「导出映射」模块可 PUT 写入 */
app.get(
  '/api/export/column-map-draft',
  authMiddleware,
  requireModuleAny(['collections', 'data-export', 'export-mapping']),
  (req, res) => {
  try {
    const exportTypeId = String(req.query.exportTypeId || '').trim();
    if (!exportTypeId) {
      res.status(400).json({ error: 'exportTypeId 不能为空' });
      return;
    }
    // 非管理员：仅能读取「自己创建」或「公开」模板的草稿；避免取消公开后仍能读到映射配置
    if (req.user?.role !== 'admin') {
      const t = db
        .prepare(
          `SELECT created_by_user_id AS createdByUserId, is_public AS isPublic
             FROM export_templates
            WHERE export_type_id = ?
            LIMIT 1`
        )
        .get(exportTypeId);
      if (!t) {
        res.status(404).json({ error: '导出类型不存在' });
        return;
      }
      const uid = req.user?.sub ?? null;
      const ownerId = t.createdByUserId ?? null;
      const isPublic = Number(t.isPublic) === 1;
      if (!((uid != null && ownerId != null && Number(uid) === Number(ownerId)) || isPublic)) {
        res.status(403).json({ error: '无权访问该导出类型草稿' });
        return;
      }
    }
    const raw = getAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${exportTypeId}`);
    if (raw == null || raw === '') {
      res.json({ draft: null });
      return;
    }
    try {
      const draft = JSON.parse(raw);
      res.json({ draft });
    } catch {
      res.status(500).json({ error: '服务器草稿 JSON 损坏' });
    }
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '读取失败' });
  }
});

app.put('/api/export/column-map-draft', authMiddleware, (req, res) => {
  try {
    if (
      req.user.role !== 'admin' &&
      !(req.user.allowedModules && req.user.allowedModules.includes('export-mapping'))
    ) {
      res.status(403).json({ error: '需要管理员权限或「导出映射配置」模块授权' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const exportTypeId = String(body.exportTypeId || '').trim();
    const draft = body.draft;
    if (!exportTypeId) {
      res.status(400).json({ error: 'exportTypeId 不能为空' });
      return;
    }
    // 非管理员：仅能写入「自己创建」或「公开」模板的草稿
    if (req.user?.role !== 'admin') {
      const t = db
        .prepare(
          `SELECT created_by_user_id AS createdByUserId, is_public AS isPublic
             FROM export_templates
            WHERE export_type_id = ?
            LIMIT 1`
        )
        .get(exportTypeId);
      if (!t) {
        res.status(404).json({ error: '导出类型不存在' });
        return;
      }
      const uid = req.user?.sub ?? null;
      const ownerId = t.createdByUserId ?? null;
      const isPublic = Number(t.isPublic) === 1;
      if (!((uid != null && ownerId != null && Number(uid) === Number(ownerId)) || isPublic)) {
        res.status(403).json({ error: '无权写入该导出类型草稿' });
        return;
      }
    }
    const validated = validateExportColumnMapDraftForStorage(draft, exportTypeId);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const jsonStr = JSON.stringify(draft);
    if (jsonStr.length > 1.5 * 1024 * 1024) {
      res.status(400).json({ error: '草稿过大（>1.5MB），请精简映射后再保存' });
      return;
    }
    setAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${exportTypeId}`, jsonStr);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/**
 * 通用数据预设（每用户一份，全导出模板共享，存 app_settings）。
 * - GET: 任意登录用户可读（仅自己的）；query.exportTypeId 已弃用，仅兼容旧客户端。
 * - PUT: 任意登录用户可写（仅自己的）；body.exportTypeId 已弃用。
 */
app.get(
  '/api/export/generic-presets',
  authMiddleware,
  requireModuleAny(['collections', 'data-export', 'export-mapping']),
  (req, res) => {
  try {
    const uid = req.user?.sub ?? null;
    if (uid == null) {
      res.status(401).json({ error: '未登录' });
      return;
    }
    res.json({ rows: getExportGenericPresetRowsForUser(uid) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '读取失败' });
  }
});

app.put(
  '/api/export/generic-presets',
  authMiddleware,
  requireModuleAny(['collections', 'data-export', 'export-mapping']),
  (req, res) => {
  try {
    const uid = req.user?.sub ?? null;
    if (uid == null) {
      res.status(401).json({ error: '未登录' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rowsIn = Array.isArray(body.rows) ? body.rows : [];
    if (rowsIn.length > 2000) {
      res.status(400).json({ error: '通用数据行数过多（>2000）' });
      return;
    }

    let rows;
    try {
      rows = normalizeExportGenericPresetRows(rowsIn);
    } catch (e) {
      const status = e && typeof e === 'object' && e.status === 400 ? 400 : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : '校验失败' });
      return;
    }

    const jsonStr = JSON.stringify(rows);
    if (jsonStr.length > 1.5 * 1024 * 1024) {
      res.status(400).json({ error: '通用数据过大（>1.5MB），请精简后再保存' });
      return;
    }
    setAppSetting(exportGenericPresetUserKey(uid), jsonStr);
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/**
 * 导出映射预览：返回一条父行与一条子行（若存在）样例，用于前端配置列映射时实时预览。
 * query:
 * - collectionId: number
 * - exportTypeId: string（与 GET /api/export/types 一致）
 */
app.get('/api/export/preview', authMiddleware, requireModule('export-mapping'), (req, res) => {
  try {
    const collectionId = Number(req.query.collectionId);
    const exportTypeId = String(req.query.exportTypeId || '').trim();
    if (!Number.isFinite(collectionId) || collectionId <= 0) {
      res.status(400).json({ error: 'collectionId 无效' });
      return;
    }
    if (!exportTypeId) {
      res.status(400).json({ error: 'exportTypeId 不能为空' });
      return;
    }
    const customTpl = getCustomExportTemplateByExportTypeId(exportTypeId);
    if (!customTpl) {
      res.status(400).json({ error: '仅支持用户上传模板的预览，请检查 exportTypeId' });
      return;
    }
    // 绑定平台必须是 amazon 才允许走亚马逊扁平行预览
    const plat = getExportPlatformCatalog().find((p) => String(p.id) === String(customTpl.destPlatformId));
    const ek = String(plat?.enrichKey || '').trim().toLowerCase();
    if (ek !== 'amazon') {
      res.status(400).json({ error: '仅支持 amazon 平台的导出类型预览，请检查绑定平台' });
      return;
    }

    // 预览时可读取同 exportTypeId 的服务端草稿，用于可选的 amazon 参数覆盖
    // （历史上这些字段来自 mapCfg；这里缺失会导致 ReferenceError: mapCfg is not defined）
    let mapCfg = null;
    try {
      const raw = getAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${exportTypeId}`);
      if (raw != null && raw !== '') {
        const parsedDraft = JSON.parse(raw);
        if (parsedDraft && typeof parsedDraft === 'object' && !Array.isArray(parsedDraft)) {
          mapCfg = parsedDraft;
        }
      }
    } catch {
      mapCfg = null;
    }

    const r = db
      .prepare(
        `SELECT c.id, COALESCE(c.platform_data_json, c.data_json) AS data_json,
                c.images_manifest_json, COALESCE(c.images_nobg_status,'') AS images_nobg_status,
                c.images_storage AS images_storage
           FROM collections c
          WHERE c.id = ?`
      )
      .get(collectionId);
    if (!r) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(r.data_json);
    } catch {
      parsed = {};
    }
    if (collectionDataHasSizeFieldArrays(parsed)) {
      parsed = applyPlatformDataOnSave(parsed);
    }

    let manifest = null;
    try {
      if (r.images_manifest_json) manifest = JSON.parse(r.images_manifest_json);
    } catch {
      manifest = null;
    }

    const baseUrl = getExportBaseUrl(req);
    const vrows = buildAmazonVariantTemplateRowObjects({
      collectionId: r.id,
      parsed,
      manifest,
      imagesNobgStatus: r.images_nobg_status ?? null,
      baseUrl,
      imagesStorage: r.images_storage,
      parentSellerSku: null,
      ...(mapCfg && String(mapCfg.amazonFeedProductType || '').trim()
        ? { amazonFeedProductType: String(mapCfg.amazonFeedProductType).trim() }
        : {}),
      ...(mapCfg && String(mapCfg.amazonItemType || '').trim()
        ? { amazonItemType: String(mapCfg.amazonItemType).trim() }
        : {}),
      ...(mapCfg && String(mapCfg.amazonClosureType || '').trim()
        ? { amazonClosureType: String(mapCfg.amazonClosureType).trim() }
        : {}),
      ...(mapCfg && String(mapCfg.amazonStyleName || '').trim()
        ? { amazonStyleName: String(mapCfg.amazonStyleName).trim() }
        : {}),
      ...(mapCfg && String(mapCfg.amazonItemTypeName || '').trim()
        ? { amazonItemTypeName: String(mapCfg.amazonItemTypeName).trim() }
        : {}),
      ...(mapCfg && mapCfg.amazonCoatChildOnlyRowFields
        ? { amazonCoatChildOnlyRowFields: mapCfg.amazonCoatChildOnlyRowFields }
        : {}),
    });

    const parentRow =
      vrows.find((x) => x && typeof x === 'object' && x.parentage === 'parent') || vrows[0] || null;
    const childRow =
      vrows.find((x) => x && typeof x === 'object' && x.parentage === 'child') || null;

    const keys = new Set();
    const pushKeys = (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      for (const k of Object.keys(o)) keys.add(k);
    };
    pushKeys(parentRow);
    pushKeys(childRow);

    const availableKeys = Array.from(keys).sort((a, b) => String(a).localeCompare(String(b)));
    const schemaKeys = getAmazonVariantTemplateFieldKeysForPicker();
    const union = new Set([...schemaKeys, ...availableKeys]);
    const fieldSelectableKeys = Array.from(union)
      .filter((k) => !AMAZON_VARIANT_TEMPLATE_PLACEHOLDER_KEYS.has(k))
      .sort((a, b) => String(a).localeCompare(String(b)));

    res.json({
      ok: true,
      exportTypeId,
      collectionId,
      parentRow,
      childRow,
      availableKeys,
      fieldSelectableKeys,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '预览失败' });
  }
});

/**
 * 亚马逊扁平行「字段」下拉可选 key（与 buildAmazonVariantTemplateRowObjects 同源，不含仅占位空串的列）。
 */
app.get('/api/export/amazon-variant-field-keys', authMiddleware, requireModule('export-mapping'), (req, res) => {
  try {
    res.json({ ok: true, keys: getAmazonVariantTemplateFieldKeysForPicker() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  }
});

app.get('/api/collections', authMiddleware, requireModule('collections'), (req, res) => {
  res.json(listCollectionsQuery(req));
});

/**
 * 切换「数据格式」（导出目标平台内部 id），并触发重新转化 + AI 后处理。
 * - 更新 collections.export_dest_platform_id
 * - 置 ai_post_status=pending 并入队 enqueueCollectionAiPostProcess
 * - 不改 generic_data_json（通用数据冻结），平台数据由 worker 基于当前平台重新生成
 */
app.put('/api/collections/:id/export-dest-platform', authMiddleware, requireModule('collections'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const row = db.prepare('SELECT user_id, ai_post_status FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && Number(row.user_id) !== Number(req.user.sub)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = body.exportDestPlatformId;
  const next = raw == null ? null : String(raw).trim();
  if (next && next.length > 200) {
    res.status(400).json({ error: 'exportDestPlatformId 过长' });
    return;
  }

  // 先更新 export_dest_platform_id，再根据解析出的 enrichKey 决定是否需要入队 AI。
  try {
    db.prepare(`UPDATE collections SET export_dest_platform_id = ? WHERE id = ?`).run(next || null, id);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
    return;
  }

  let enrichKey = 'amazon';
  try {
    const row2 = db.prepare('SELECT export_dest_platform_id FROM collections WHERE id = ?').get(id);
    enrichKey = resolveEnrichPlatformKeyFromCollectionRow(row2);
  } catch {
    enrichKey = 'amazon';
  }

  const wantsAiPost = isMimoConfigured() && isMimoAutoEnrichEnabled() && enrichKey === 'amazon';
  try {
    db.prepare('UPDATE collections SET ai_post_status = ? WHERE id = ?').run(wantsAiPost ? 'pending' : 'done', id);
  } catch {
    // ignore
  }

  notifyCollectionChangedById(id, 'export-dest-platform');

  // 非 amazon：立即将平台数据回退为通用数据（与插件数据一致），避免编辑页仍显示旧亚马逊结构。
  if (!wantsAiPost) {
    try {
      const r3 = db
        .prepare('SELECT generic_data_json FROM collections WHERE id = ?')
        .get(id);
      const g = String(r3?.generic_data_json || '').trim();
      if (g) {
        db.prepare(
          `UPDATE collections
              SET platform_data_json = ?,
                  data_json = ?,
                  ai_prompt_platform_key = ?,
                  ai_prompt_profile_id = '',
                  ai_prompt_profile_name = '',
                  ai_prompt_profile_set_at = datetime('now','+8 hours')
            WHERE id = ?`
        ).run(g, g, String(enrichKey || ''), id);
        notifyCollectionChangedById(id, 'ai-done');
      }
    } catch (e) {
      console.error('[collections] export dest platform: generic snapshot failed', id, e);
    }
  }

  if (wantsAiPost) enqueueCollectionAiPostProcess(id);

  res.json({ ok: true, id, exportDestPlatformId: next || '' });
});

/**
 * 手动重跑单条采集记录的 AI 后处理（与入库 worker 相同：标题/描述/颜色/详情/搜索关键字）。
 * 用于排查/修复因模型截断导致的详情未翻译等情况。
 */
app.post('/api/collections/:id/ai/rerun', authMiddleware, requireModule('collections'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const row = db.prepare('SELECT user_id FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && Number(row.user_id) !== Number(req.user.sub)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const wantsAiPost = isMimoConfigured() && isMimoAutoEnrichEnabled();
  if (!wantsAiPost) {
    res.status(503).json({ error: '当前未配置 AI（请检查 AI Provider 的 API Key 或 MIMO_AUTO_ENRICH）' });
    return;
  }
  try {
    db.prepare("UPDATE collections SET ai_post_status = 'pending' WHERE id = ?").run(id);
  } catch {
    // ignore
  }
  enqueueCollectionAiPostProcess(id);
  notifyCollectionChangedById(id, 'ai-status');
  res.json({ ok: true, id });
});

/** 图片资源管理：下载单条记录的图片 zip（仅图片，不含表格；目录与服务器落盘一致） */
app.get('/api/collections/:id/images-zip', authMiddleware, requireModule('collections'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const nobg = String(req.query.nobg || '').trim() === '1';

  const row = db
    .prepare(
      `SELECT user_id, images_status, images_nobg_status, images_manifest_json, images_storage
       FROM collections WHERE id = ?`
    )
    .get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权下载' });
    return;
  }
  if (String(row.images_status || '') !== 'done') {
    res.status(400).json({ error: '图片尚未下载完成' });
    return;
  }
  if (nobg && String(row.images_nobg_status || '') !== 'done') {
    res.status(400).json({ error: '去背景尚未完成' });
    return;
  }

  let manifest = {};
  try {
    manifest = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
  } catch {
    manifest = {};
  }

  const mainFiles = nobg ? manifest.mainFilesNobg : manifest.mainFiles;
  const galleryFiles = nobg ? manifest.galleryFilesNobg : manifest.galleryFiles;
  const mainFolder = nobg ? 'main_nobg' : 'main';
  const galleryFolder = nobg ? 'gallery_nobg' : 'gallery';
  const zipMainFolder = nobg ? 'main-nobg' : 'main';
  const zipGalleryFolder = nobg ? 'gallery-nobg' : 'gallery';

  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const baseDir = absCollectionImagesRoot(dataDir, id);

  const oc = getOssConfig();
  const useOss = collectionUsesOss(row.images_storage) && oc.enabled;
  const ossClient = useOss ? newOssClient() : null;

  const imagesToAdd = new Map(); // zipName -> absPath | ossKey
  const addFiles = (dirOrRole, files, subfolder) => {
    if (!Array.isArray(files)) return;
    for (const fn of files) {
      const name = String(fn || '').trim();
      if (!name) continue;
      const zipName = `${relCollectionImagesDir(id)}/${subfolder}/${name}`.replace(/\\/g, '/');
      if (imagesToAdd.has(zipName)) continue;
      if (useOss) {
        const key = ossKeyForCollectionImage(id, String(dirOrRole), name);
        imagesToAdd.set(zipName, key);
      } else {
        const abs = path.join(String(dirOrRole), name);
        if (!fs.existsSync(abs)) continue;
        imagesToAdd.set(zipName, abs);
      }
    }
  };
  if (useOss) {
    addFiles(mainFolder, mainFiles, zipMainFolder);
    addFiles(galleryFolder, galleryFiles, zipGalleryFolder);
  } else {
    addFiles(path.join(baseDir, mainFolder), mainFiles, zipMainFolder);
    addFiles(path.join(baseDir, galleryFolder), galleryFiles, zipGalleryFolder);
  }

  if (imagesToAdd.size === 0) {
    res.status(400).json({ error: '该记录没有可打包的图片文件' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="collection_${id}_images.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    try {
      res.status(500).end(String(err?.message || err));
    } catch {
      // ignore
    }
  });
  archive.pipe(res);
  for (const [name, v] of imagesToAdd.entries()) {
    if (useOss) {
      const key = String(v);
      try {
        const r = await ossClient.getStream(key);
        archive.append(r.stream, { name });
      } catch {
        // missing object: skip
      }
    } else {
      const abs = String(v);
      archive.file(abs, { name });
    }
  }
  await archive.finalize();
});

/**
 * 手动将图片下载重新入队（pending/失败/卡住后使用；成功后会重置自动重试计数）。
 * 与初次上报 enqueue 使用相同的 buildImageJobFromCollectionId（含 platform 回退）。
 */
app.post(
  '/api/collections/:id/images/retry-download',
  authMiddleware,
  requireModule('collections'),
  (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const row = db.prepare('SELECT user_id FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const job = buildImageJobFromCollectionId(id);
  if (!job) {
    res.status(400).json({
      error:
        '无法从该记录的通用/平台数据中解析出商品行（rows），无法下载图片。请检查采集数据是否包含主图/副图字段。',
    });
    return;
  }
  resetImageDownloadRetryState(id);
  db.prepare("UPDATE collections SET images_status = 'pending', images_error = NULL WHERE id = ?").run(
    id
  );
  enqueueImageJob(job);
  res.json({ ok: true });
});

/** 图片管理：按采集记录分页，返回每条已下载图片的 role/filename；前端用 /api/collections/:id/image/... 展示本站地址（非原始外链） */
app.get('/api/images', authMiddleware, requireModule('images'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const filterUserId = req.query.userId != null && isAdmin ? Number(req.query.userId) : null;

  let where = '1=1';
  const params = [];
  where += ' AND COALESCE(c.is_archived, 0) = 0';
  if (!isAdmin) {
    where += ' AND c.user_id = ?';
    params.push(req.user.sub);
  } else if (filterUserId) {
    where += ' AND c.user_id = ?';
    params.push(filterUserId);
  }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM collections c WHERE ${where}`).get(...params).n;

  const rows = db
    .prepare(
      `SELECT c.id, c.collected_at AS collectedAt, c.platform, c.url, COALESCE(c.platform_data_json, c.data_json) AS dataJson,
              c.user_mark AS userMark,
              COALESCE(c.images_status,'pending') AS imagesStatus,
              c.images_error AS imagesError,
              c.images_manifest_json AS imagesManifestJson,
              COALESCE(c.images_nobg_status,'') AS imagesNobgStatus,
              c.ai_post_status AS aiPostStatus,
              c.images_storage AS imagesStorage,
              u.username
       FROM collections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE ${where}
       ORDER BY c.collected_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const baseUrl = getExportBaseUrl(req);

  const out = rows.map((r) => {
    let manifest = null;
    try {
      if (r.imagesManifestJson) manifest = JSON.parse(r.imagesManifestJson);
    } catch {
      manifest = null;
    }
    let title = '';
    /** @type {string[]} */
    let detailImageUrls = [];
    let colorExportChecked = null;
    try {
      const parsed = JSON.parse(r.dataJson || '{}');
      const raw = rawRowsFromStoredData(parsed);
      for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const t = row['标题'] ?? row['商品标题'];
        if (typeof t === 'string' && t.trim()) {
          title = t.trim();
          break;
        }
      }
      // 颜色勾选：与采集编辑窗口一致（按颜色下标控制主图/导出）。
      // 规则：优先 sku_axes.colors；否则从汇总行「颜色」按换行拆分；无法判定颜色数则不返回该字段。
      const splitAxis = (v) => {
        if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
        const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
        if (!s) return [];
        return s.split('\n').map((x) => x.trim()).filter(Boolean);
      };
      const colorsFromAxes =
        parsed && parsed.sku_axes && typeof parsed.sku_axes === 'object' && !Array.isArray(parsed.sku_axes)
          ? splitAxis(parsed.sku_axes.colors)
          : [];
      const shared = raw.find((x) => x && typeof x === 'object' && x['父子关系'] === 'parent') || raw[0];
      const colorsFromRow =
        shared && typeof shared === 'object' ? splitAxis(shared['颜色']) : [];
      const colorCount = (colorsFromAxes.length ? colorsFromAxes : colorsFromRow).length;
      if (colorCount > 0) {
        colorExportChecked = readColorExportIncluded(parsed, colorCount);
      }
      // 详情图（仅展示）：优先取汇总行字段「详情图」，数组为主；字符串按换行/分隔符拆分
      if (shared && typeof shared === 'object') {
        const v = shared['详情图'];
        if (Array.isArray(v)) {
          detailImageUrls = v.map((x) => String(x ?? '').trim()).filter(Boolean);
        } else if (typeof v === 'string') {
          const s = v.trim();
          if (s) {
            const parts = s.includes('\n')
              ? s.split(/\r?\n/)
              : s.split(/[,，\s|]+/);
            detailImageUrls = parts.map((x) => x.trim()).filter(Boolean);
          }
        }
      }
    } catch {
      title = '';
      detailImageUrls = [];
      colorExportChecked = null;
    }
    const images = [];
    const nobgDone = String(r.imagesNobgStatus || '') === 'done';
    const mainNobg = nobgDone && manifest ? manifest.mainFilesNobg || [] : [];
    const galNobg = nobgDone && manifest ? manifest.galleryFilesNobg || [] : [];
    if (r.imagesStatus === 'done' && manifest) {
      const mains = manifest.mainFiles || [];
      const gals = manifest.galleryFiles || [];
      const dets = manifest.detailFiles || [];
      mains.forEach((fn, index) => {
        if (!fn) return;
        const useNobg = mainNobg[index];
        const storageRole = useNobg ? 'main_nobg' : 'main';
        const filename = String(useNobg || fn);
        images.push({
          role: 'main',
          index,
          filename,
          storageRole,
          publicUrl: buildPublicCollectionImageUrl(
            baseUrl,
            r.id,
            storageRole,
            filename,
            r.imagesStorage
          ),
        });
      });
      gals.forEach((fn, index) => {
        if (!fn) return;
        const useNobg = galNobg[index];
        const storageRole = useNobg ? 'gallery_nobg' : 'gallery';
        const filename = String(useNobg || fn);
        images.push({
          role: 'gallery',
          index,
          filename,
          storageRole,
          publicUrl: buildPublicCollectionImageUrl(
            baseUrl,
            r.id,
            storageRole,
            filename,
            r.imagesStorage
          ),
        });
      });
      dets.forEach((fn, index) => {
        if (!fn) return;
        const storageRole = 'detail';
        const filename = String(fn);
        images.push({
          role: 'detail',
          index,
          filename,
          storageRole,
          publicUrl: buildPublicCollectionImageUrl(
            baseUrl,
            r.id,
            storageRole,
            filename,
            r.imagesStorage
          ),
        });
      });
    }
    return {
      collectionId: r.id,
      collectedAt: r.collectedAt,
      platform: r.platform,
      url: r.url,
      username: r.username,
      title: title || `采集 #${r.id}`,
      userMark: r.userMark ?? null,
      imagesStatus: r.imagesStatus,
      imagesError: r.imagesError,
      imagesNobgStatus: r.imagesNobgStatus || null,
      aiPostStatus: r.aiPostStatus ?? null,
      imagesStorage: r.imagesStorage ?? null,
      colorExportChecked,
      images,
      detailImages: detailImageUrls,
    };
  });

  res.json({ page, limit, total, rows: out });
});

/**
 * 导出「非亚马逊」时从 DB 行解析**用于写入表格**的 JSON：与列表 `dataJson` 一致，
 * 优先 `platform_data_json`（用户二次处理 / 手动保存后的平台数据）；无则回退 `data_json`。
 * 不再优先 `generic_data_json`（插件通用数据），以免覆盖已保存的平台编辑结果。
 */
function parseGenericForExport(r) {
  try {
    return JSON.parse(getPlatformJsonString(r) || '{}');
  } catch {
    return {};
  }
}

/** GET：query；POST：JSON body。生产环境导出模板仅来自“用户上传空模板”。 */
function parseCollectionsExportRequest(req, res) {
  const isAdmin = req.user.role === 'admin';
  let format;
  let exportTarget;
  let includeImages;
  let filterUserId;
  let idList;
  let templateBuffer = null;
  /** 是否由服务器磁盘亚马逊模板读入 xlsx（PATH 或 INDEX 映射） */
  let templateFromServerFile = false;
  /** @type {string | null} */
  let exportTypeId = null;
  /** @type {unknown | null} */
  let columnMapDraft = null;
  /** POST 是否携带非空的 templateWorkbookBase64 字段（亚马逊导出下禁止） */
  let requestedClientTemplateBase64 = false;

  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    const b = req.body;
    format = String(b.format ?? 'csv').toLowerCase();
    exportTarget = String(b.target ?? '').trim().toLowerCase();
    includeImages = b.includeImages === true || String(b.includeImages ?? '').trim() === '1';
    filterUserId =
      b.userId != null && isAdmin && Number.isFinite(Number(b.userId)) ? Number(b.userId) : null;
    if (!Array.isArray(b.ids) || b.ids.length === 0) {
      res.status(400).json({ error: '请勾选要导出的记录（body.ids 数组）' });
      return null;
    }
    idList = b.ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (!idList.length) {
      res.status(400).json({ error: '请至少勾选一条记录' });
      return null;
    }
    if (typeof b.templateWorkbookBase64 === 'string' && b.templateWorkbookBase64.trim()) {
      requestedClientTemplateBase64 = true;
      try {
        templateBuffer = Buffer.from(b.templateWorkbookBase64.trim(), 'base64');
        if (!templateBuffer.length) templateBuffer = null;
      } catch {
        res.status(400).json({ error: '模板 Base64 无效' });
        return null;
      }
    }
    if (typeof b.exportTypeId === 'string' && b.exportTypeId.trim()) {
      exportTypeId = b.exportTypeId.trim();
    }
    if (b.columnMapDraft != null) {
      columnMapDraft = b.columnMapDraft;
    }
  } else {
    format = String(req.query.format || 'csv').toLowerCase();
    exportTarget = String(req.query.target || '')
      .trim()
      .toLowerCase();
    includeImages =
      String(req.query.includeImages || '')
        .trim()
        .toLowerCase() === '1';
    filterUserId = req.query.userId != null && isAdmin ? Number(req.query.userId) : null;
    const idsParam = req.query.ids;
    if (idsParam == null || String(idsParam).trim() === '') {
      res.status(400).json({ error: '请勾选要导出的记录（参数 ids）' });
      return null;
    }
    idList = String(idsParam)
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!idList.length) {
      res.status(400).json({ error: '请至少勾选一条记录' });
      return null;
    }
    if (typeof req.query.exportTypeId === 'string' && req.query.exportTypeId.trim()) {
      exportTypeId = req.query.exportTypeId.trim();
    }
  }

  // 生产环境仅支持“用户上传模板”：若未显式指定 target，则由模板绑定的平台推断
  if (!String(exportTarget || '').trim() && exportTypeId) {
    const customTpl = getCustomExportTemplateByExportTypeId(exportTypeId);
    if (customTpl) {
      const plat = getExportPlatformCatalog().find((p) => String(p.id) === String(customTpl.destPlatformId));
      const ek = String(plat?.enrichKey || '').trim().toLowerCase();
      exportTarget = ek === 'amazon' ? 'amazon' : 'generic';
    }
  }

  const isAmazonExport = String(exportTarget || '').trim().toLowerCase() === 'amazon';

  if (isAmazonExport) {
    if (requestedClientTemplateBase64) {
      res.status(400).json({ error: '亚马逊导出不支持客户端模板，请先上传空模板并使用其 exportTypeId' });
      return null;
    }
    templateBuffer = null;
    templateFromServerFile = false;
    const customTpl = getCustomExportTemplateByExportTypeId(exportTypeId);
    if (!exportTypeId || !customTpl) {
      res.status(400).json({
        error:
          '亚马逊导出须传有效 exportTypeId（来自你上传模板生成的导出类型）。请在请求中传 exportTypeId（与 GET /api/export/types 一致）。',
      });
      return null;
    }
    let fp = String(customTpl.filePath || '').trim();
    if (!fp || !fs.existsSync(fp)) {
      const mat = materializeExportTemplateFileIfMissing(customTpl);
      if (!mat.ok) {
        res.status(400).json({ error: mat.error || '自定义模板文件缺失（服务器未找到文件）' });
        return null;
      }
      fp = mat.filePath;
    }
    const buf = fs.readFileSync(fp);
    if (!buf.length) {
      res.status(400).json({ error: '自定义模板文件为空' });
      return null;
    }
    templateBuffer = buf;
    templateFromServerFile = true;
  } else if (!templateBuffer && exportTypeId) {
    const customTpl = getCustomExportTemplateByExportTypeId(exportTypeId);
    if (customTpl) {
      let fp = String(customTpl.filePath || '').trim();
      if (!fp || !fs.existsSync(fp)) {
        const mat = materializeExportTemplateFileIfMissing(customTpl);
        if (!mat.ok) {
          res.status(400).json({ error: mat.error || '自定义模板文件缺失（服务器未找到文件）' });
          return null;
        }
        fp = mat.filePath;
      }
      const buf = fs.readFileSync(fp);
      if (!buf.length) {
        res.status(400).json({ error: '自定义模板文件为空' });
        return null;
      }
      templateBuffer = buf;
      templateFromServerFile = true;
    }
  }

  const hasCustomTemplate = Boolean(exportTypeId && getCustomExportTemplateByExportTypeId(exportTypeId));
  if (exportTypeId && hasCustomTemplate && !templateBuffer) {
    res.status(400).json({
      error: '已指定 exportTypeId，但未找到 Excel 模板文件（请检查上传文件是否仍在服务器磁盘）',
    });
    return null;
  }

  if (templateBuffer && format === 'csv') {
    res.status(400).json({ error: '使用自定义 Excel 模板时请选择 xlsx 格式导出' });
    return null;
  }

  if (templateBuffer) {
    if (!exportTypeId) {
      res.status(400).json({
        error:
          '使用自定义或内置表头模板时请在 body 中携带 exportTypeId（GET 导出可传 query exportTypeId），须与 GET /api/export/types 返回的 id 一致',
      });
      return null;
    }
    if (!getCustomExportTemplateByExportTypeId(exportTypeId)) {
      res.status(400).json({ error: 'exportTypeId 无效，请从 /api/export/types 选择' });
      return null;
    }
  }

  if (columnMapDraft == null && exportTypeId) {
    const raw = getAppSetting(`${EXPORT_COLUMN_MAP_DRAFT_KEY_PREFIX}${String(exportTypeId).trim()}`);
    if (raw && String(raw).trim()) {
      try {
        columnMapDraft = JSON.parse(raw);
      } catch {
        columnMapDraft = null;
      }
    }
  }

  return {
    format,
    exportTarget,
    includeImages,
    filterUserId,
    idList,
    templateBuffer,
    exportTypeId,
    isAdmin,
    templateFromServerFile,
    columnMapDraft,
  };
}

async function handleCollectionsExportData(req, res) {
  const parsed = parseCollectionsExportRequest(req, res);
  if (!parsed) return;
  const {
    format,
    exportTarget,
    includeImages,
    filterUserId,
    idList,
    templateBuffer,
    exportTypeId,
    isAdmin,
    templateFromServerFile,
    columnMapDraft,
  } = parsed;

  const customTplForWorkbookExt =
    templateBuffer && exportTypeId ? getCustomExportTemplateByExportTypeId(exportTypeId) : null;
  const workbookExt = exportTemplateWorkbookExtension(customTplForWorkbookExt);
  const workbookMime =
    workbookExt === 'xlsm'
      ? 'application/vnd.ms-excel.sheet.macroEnabled.12'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  let exportColumnMapMode = 'builtin';
  let exportColumnMapVersion = '';
  let exportColumnMapHeaderRow = '';
  let exportColumnMapDataStartRow = '';
  let exportColumnMapSheetName = '';

  function normalizeHeaderTextForLookup(s) {
    return String(s ?? '').trim().replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function normalizeDraftFieldKey(rawKey) {
    const k = String(rawKey ?? '').trim();
    if (!k) return '';
    // 兼容历史/误用中文字段 key：统一转回英文“真名”
    if (k === '商品类型') return 'feed_product_type';
    if (k === '卖家SKU') return 'item_sku';
    if (k === '更新删除') return 'update_delete';
    if (k === '标题') return 'item_name';
    if (k === '服装尺码数值') return 'apparel_size';
    if (k === '主图') return 'main_image_url';
    if (k === '父子关系') return 'parent_child';
    if (k === '父SKU') return 'parent_sku';
    if (k === '搜索关键词') return 'generic_keywords';
    if (k === '色表') return 'color_map';
    if (k === '颜色') return 'color_name';
    if (k === '服装尺寸') return 'size_name';
    const mImg = k.match(/^副图(\d+)$/);
    if (mImg) return `other_image_url${mImg[1]}`;
    const mBp = k.match(/^商品特性(\d+)$/);
    if (mBp) return `bullet_point${mBp[1]}`;
    return k;
  }

  function getByPath(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    let cur = obj;
    const parts = String(path || '')
      .split('.')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const p of parts) {
      const m = p.match(/^([^\[\]]+)(?:\[(\d+)\])?$/);
      if (!m) return undefined;
      const k = m[1];
      if (cur == null) return undefined;
      cur = cur[k];
      if (m[2] != null) {
        const idx = Number(m[2]);
        if (!Array.isArray(cur)) return undefined;
        cur = cur[idx];
      }
    }
    return cur;
  }

  function evalSafeExpr(exprRaw, ctx) {
    const expr = String(exprRaw || '').trim();
    if (!expr || !ctx) return '';
    const body = expr.replace(/^\{\{|\}\}$/g, '').trim();
    const mDefault = body.match(/^default\((.+?),\s*'([^']*)'\)$/);
    if (mDefault) {
      const v = getByPath(ctx, mDefault[1].trim());
      const s = v == null || String(v).trim() === '' ? mDefault[2] : String(v);
      return s;
    }
    const mJoin = body.match(/^join\((.+?),\s*'([^']*)'\)$/);
    if (mJoin) {
      const v = getByPath(ctx, mJoin[1].trim());
      if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join(mJoin[2]);
      return String(v ?? '');
    }
    const mSlice = body.match(/^slice\((.+?),\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (mSlice) {
      const v = getByPath(ctx, mSlice[1].trim());
      const a = Number(mSlice[2]);
      const b = Number(mSlice[3]);
      if (Array.isArray(v)) return v.slice(a, b).map((x) => String(x ?? '')).join(' ');
      const s = String(v ?? '');
      return s.slice(a, b);
    }
    const v = getByPath(ctx, body);
    return v == null ? '' : String(v);
  }

  function rowAmazonParentChildKind(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
    const p = String(row.parentage ?? row['父子关系'] ?? '')
      .trim()
      .toLowerCase();
    if (p === 'parent') return 'parent';
    if (p === 'child') return 'child';
    return '';
  }

  function rowSetHasAmazonParentChildMarkers(rowObjects) {
    const list = Array.isArray(rowObjects) ? rowObjects : [];
    return list.some((row) => {
      const k = rowAmazonParentChildKind(row);
      return k === 'parent' || k === 'child';
    });
  }

  function normalizeConstExprApplyTo(raw) {
    const s = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (s === 'parent' || s === 'child' || s === 'both') return s;
    return 'both';
  }

  function isAmazonChildOnlyFieldKey(raw) {
    const key = normalizeDraftFieldKey(raw);
    return key === 'model' || key === 'model_name' || key === 'part_number';
  }

  /**
   * 将前端 columnMapDraft 转成 fillXlsxTemplateWithColumnMap 可用的 columns（excelHeader -> field）。
   * 支持 source.type:
   * - field: row[key]
   * - const: 写死字符串（可选 source.applyTo: both | parent | child，仅当扁平行含 parent/child 时生效）
   * - expr: 极简表达式（同前端；applyTo 同上）
   */
  function compileColumnMapDraft(draftAny, rowObjects) {
    if (!draftAny || typeof draftAny !== 'object' || Array.isArray(draftAny)) return null;
    const draft = draftAny;
    const ver = Number(draft.version);
    if (ver !== 2) return null;
    const colsIn = Array.isArray(draft.columns) ? draft.columns : [];
    if (colsIn.length > 2000) throw new Error('映射列数过多');

    const hasParentChildMarkers = rowSetHasAmazonParentChildMarkers(rowObjects);
    const columns = [];
    /** 对 const/expr 生成临时字段并回填到 rowObjects */
    let synthId = 0;
    for (const entry of colsIn) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const ehRaw = entry.excelHeader;
      const excelHeader = normalizeHeaderTextForLookup(ehRaw);
      if (!excelHeader) continue;
      const colNum = Number(entry.col);
      const hasCol = Number.isFinite(colNum) && colNum >= 0;
      const src = entry.source;
      // 兼容极简写法：entry.field
      if (!src && typeof entry.field === 'string' && entry.field.trim()) {
        columns.push({
          excelHeader,
          field: normalizeDraftFieldKey(entry.field),
          ...(hasCol ? { col: colNum } : {}),
        });
        continue;
      }
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const t = String(src.type || '').trim();
      if (t === 'field') {
        const key = normalizeDraftFieldKey(src.key);
        if (!key) continue;
        if (hasParentChildMarkers && isAmazonChildOnlyFieldKey(key)) {
          const synthKey = `__map_field_${synthId++}`;
          for (const row of rowObjects) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
            const kind = rowAmazonParentChildKind(row);
            row[synthKey] = kind === 'child' ? row[key] : '';
          }
          columns.push({ excelHeader, field: synthKey, ...(hasCol ? { col: colNum } : {}) });
          continue;
        }
        columns.push({ excelHeader, field: key, ...(hasCol ? { col: colNum } : {}) });
        continue;
      }
      if (t === 'const') {
        const val = src.value == null ? '' : String(src.value);
        let applyTo = normalizeConstExprApplyTo(src.applyTo);
        if (!hasParentChildMarkers && (applyTo === 'parent' || applyTo === 'child')) {
          applyTo = 'both';
        }
        const synthKey = `__map_const_${synthId++}`;
        for (const row of rowObjects) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          const kind = rowAmazonParentChildKind(row);
          let use = true;
          if (hasParentChildMarkers) {
            if (applyTo === 'parent') use = kind === 'parent';
            else if (applyTo === 'child') use = kind === 'child';
          }
          row[synthKey] = use ? val : '';
        }
        columns.push({ excelHeader, field: synthKey, ...(hasCol ? { col: colNum } : {}) });
        continue;
      }
      if (t === 'expr') {
        const expr = String(src.expr || '').trim();
        if (!expr) continue;
        if (expr.length > 500) throw new Error('表达式过长');
        let applyTo = normalizeConstExprApplyTo(src.applyTo);
        if (!hasParentChildMarkers && (applyTo === 'parent' || applyTo === 'child')) {
          applyTo = 'both';
        }
        const synthKey = `__map_expr_${synthId++}`;
        for (const row of rowObjects) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          const kind = rowAmazonParentChildKind(row);
          let use = true;
          if (hasParentChildMarkers) {
            if (applyTo === 'parent') use = kind === 'parent';
            else if (applyTo === 'child') use = kind === 'child';
          }
          row[synthKey] = use ? evalSafeExpr(expr, row) : '';
        }
        columns.push({ excelHeader, field: synthKey, ...(hasCol ? { col: colNum } : {}) });
        continue;
      }
    }

    const sheetName =
      typeof draft.sheetName === 'string' && String(draft.sheetName).trim()
        ? String(draft.sheetName).trim()
        : undefined;
    const headerRow = Number(draft.headerRow);
    const dataStartRow = Number(draft.dataStartRow);
    return {
      columns,
      sheetName,
      headerRow: Number.isFinite(headerRow) && headerRow >= 1 ? Math.floor(headerRow) : undefined,
      dataStartRow:
        Number.isFinite(dataStartRow) && dataStartRow >= 1 ? Math.floor(dataStartRow) : undefined,
    };
  }

  async function applyCustomTemplate(buf, rowObjects) {
    const customTpl = exportTypeId ? getCustomExportTemplateByExportTypeId(exportTypeId) : null;
    if (!customTpl) {
      throw new Error('导出类型无效');
    }
    let columns = [];
    let compiled = null;
    if (columnMapDraft) {
      try {
        compiled = compileColumnMapDraft(columnMapDraft, rowObjects);
      } catch (e) {
        // 映射草稿非法：直接 400 给前端（更清晰）
        const msg = e instanceof Error ? e.message : '映射草稿编译失败';
        const err = new Error(`columnMapDraft 无效：${msg}`);
        err.statusCode = 400;
        throw err;
      }
    }
    // 只要存在草稿（哪怕 columns 为空 = 显式“不要填充”），就以草稿为准，不回退到内置 columns。
    if (compiled) {
      columns = compiled.columns;
      exportColumnMapMode = 'draft';
      exportColumnMapVersion = String(columnMapDraft?.version ?? '');
    }
    if (!compiled && (!columns || columns.length === 0)) {
      throw new Error('该导出类型尚未配置列映射：请先在「导出映射配置」里保存映射草稿');
    }

    const headerRowBase = Number(customTpl.headerRow);
    const dataStartRowBase = Number(customTpl.dataStartRow);
    const sheetNameBase = String(customTpl.sheetName || '').trim();

    const headerRow = Number.isFinite(headerRowBase) && headerRowBase >= 1 ? Math.floor(headerRowBase) : (compiled?.headerRow ?? 1);
    const dataStartRow =
      Number.isFinite(dataStartRowBase) && dataStartRowBase >= 1 ? Math.floor(dataStartRowBase) : (compiled?.dataStartRow ?? 4);
    const sheetName = sheetNameBase ? String(sheetNameBase) : compiled?.sheetName;
    exportColumnMapHeaderRow = headerRow ? String(headerRow) : '';
    exportColumnMapDataStartRow = dataStartRow ? String(dataStartRow) : '';
    exportColumnMapSheetName = sheetName ? String(sheetName) : '';
    const strictOpts = {};
    return await fillXlsxTemplateWithColumnMap(buf, rowObjects, {
      dataStartRow,
      headerRow,
      sheetName,
      columns,
      ...strictOpts,
    });
  }

  const placeholders = idList.map(() => '?').join(',');
  let sql = `SELECT c.id, c.collected_at, c.platform, c.url, COALESCE(c.platform_data_json, c.data_json) AS data_json,
              c.generic_data_json,
              c.export_dest_platform_id AS exportDestPlatformId,
              c.images_manifest_json,
              COALESCE(c.images_nobg_status,'') AS images_nobg_status,
              c.images_storage AS images_storage,
              c.amazon_parent_sku AS amazon_parent_sku,
              u.username
     FROM collections c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id IN (${placeholders})`;
  const params = [...idList];

  if (!isAdmin) {
    sql += ' AND c.user_id = ?';
    params.push(req.user.sub);
  } else if (filterUserId) {
    sql += ' AND c.user_id = ?';
    params.push(filterUserId);
  }

  const rows = db.prepare(sql).all(...params);

  if (rows.length !== idList.length) {
    res.status(400).json({ error: '部分记录不存在或无权导出' });
    return;
  }

  // 若指定 exportTypeId（即绑定了导出平台模板），则强制校验：采集记录的数据格式必须与模板绑定平台一致。
  if (exportTypeId) {
    const tpl = getCustomExportTemplateByExportTypeId(exportTypeId);
    const expectedDestPlatformId = String(tpl?.destPlatformId || '').trim();
    if (expectedDestPlatformId) {
      const mismatched = rows
        // 允许采集记录未设置数据格式（空）时导出：视为“跟随模板平台”
        .filter((r) => {
          const cur = String(r.exportDestPlatformId || '').trim();
          if (!cur) return false;
          return cur !== expectedDestPlatformId;
        })
        .map((r) => Number(r.id))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (mismatched.length) {
        const preview = mismatched.slice(0, 8).join(', ');
        res.status(400).json({
          error:
            `导出失败：所选导出模板绑定的平台与采集记录「数据格式」不一致。` +
            `请先在「数据采集管理」把这些记录的数据格式切换为当前模板平台后再导出。` +
            `不一致记录 id：${preview}${mismatched.length > 8 ? ` 等共 ${mismatched.length} 条` : ''}`,
        });
        return;
      }
    }
  }

  const flat = [];
  if (exportTarget !== 'amazon') {
    for (const r of rows) {
      const parsed = genericToExportSecondaryPlatformData(parseGenericForExport(r));
      const base = {
        采集时间: r.collected_at,
        采集平台: r.platform,
        采集地址: r.url,
        用户名: r.username || '',
      };
      const skuRows = getExportRowsForDataJson(parsed);
      if (skuRows.length) {
        for (const sku of skuRows) {
          flat.push({ ...base, ...sku });
        }
      } else {
        flat.push({ ...base });
      }
    }
  }

  const updPlaceholders = idList.map(() => '?').join(',');
  const updateExported = db.prepare(
    `UPDATE collections SET exported_at = ? WHERE id IN (${updPlaceholders})`
  );

  async function buildWorkbookBuffer() {
    if (templateBuffer) {
      return await applyCustomTemplate(templateBuffer, flat);
    }
    const ws = XLSX.utils.json_to_sheet(flat);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '采集数据');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return Buffer.from(buf);
  }

  function buildCsvBuffer() {
    const ws = XLSX.utils.json_to_sheet(flat.length ? flat : [{}]);
    const csv = XLSX.utils.sheet_to_csv(ws);
    return Buffer.from('\uFEFF' + csv);
  }

  const sendFile = async () => {
    res.setHeader('X-Export-ColumnMap-Mode', exportColumnMapMode);
    if (exportColumnMapVersion) res.setHeader('X-Export-ColumnMap-Version', exportColumnMapVersion);
    if (exportColumnMapHeaderRow) res.setHeader('X-Export-ColumnMap-HeaderRow', exportColumnMapHeaderRow);
    if (exportColumnMapDataStartRow) res.setHeader('X-Export-ColumnMap-DataStartRow', exportColumnMapDataStartRow);
    if (exportColumnMapSheetName) res.setHeader('X-Export-ColumnMap-SheetName', exportColumnMapSheetName);
    if (format === 'xlsx') {
      res.setHeader('X-Export-Workbook-Extension', workbookExt);
      res.setHeader('Content-Disposition', `attachment; filename="collections.${workbookExt}"`);
      res.setHeader('Content-Type', workbookMime);
      res.send(await buildWorkbookBuffer());
      return;
    }

    res.setHeader('Content-Disposition', 'attachment; filename="collections.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(buildCsvBuffer());
  };

  async function buildAmazonExportBuffer() {
    const baseUrl = getExportBaseUrl(req);
    if (!templateBuffer) {
      throw new Error('亚马逊导出缺少模板文件（请先上传空模板并选择 exportTypeId）');
    }
    const amazonFeedProductType = '';
    const amazonItemType = '';
    const amazonClosureType = '';
    const amazonStyleName = '';
    const amazonItemTypeName = '';
    const amazonCoatChildOnlyRowFields = undefined;
    const rowObjects = [];

    const readParentSkuStmt = db.prepare('SELECT amazon_parent_sku AS s FROM collections WHERE id = ?');
    const existsParentSkuStmt = db.prepare(
      'SELECT 1 AS ok FROM collections WHERE amazon_parent_sku = ? LIMIT 1'
    );
    const writeParentSkuStmt = db.prepare('UPDATE collections SET amazon_parent_sku = ? WHERE id = ?');

    for (const r of rows) {
      // 父行（parent）卖家 SKU：需要持久化写入 DB，并保证全库不重复
      let parentSellerSku = String(r.amazon_parent_sku ?? '').trim();
      if (!parentSellerSku) {
        for (let i = 0; i < 20; i++) {
          const candidate = generateAmazonParentSellerSku();
          const exists = existsParentSkuStmt.get(candidate);
          if (exists) continue;
          writeParentSkuStmt.run(candidate, r.id);
          parentSellerSku = candidate;
          break;
        }
        if (!parentSellerSku) {
          const got = readParentSkuStmt.get(r.id);
          parentSellerSku = String(got?.s ?? '').trim();
        }
      }

      let parsed = {};
      try {
        parsed = JSON.parse(r.data_json);
      } catch {
        parsed = {};
      }
      if (collectionDataHasSizeFieldArrays(parsed)) {
        parsed = applyPlatformDataOnSave(parsed);
      }
      let manifest = null;
      try {
        if (r.images_manifest_json) manifest = JSON.parse(r.images_manifest_json);
      } catch {
        manifest = null;
      }
      const vrows = buildAmazonVariantTemplateRowObjects({
        collectionId: r.id,
        parsed,
        manifest,
        imagesNobgStatus: r.images_nobg_status ?? null,
        baseUrl,
        imagesStorage: r.images_storage,
        parentSellerSku,
        ...(amazonFeedProductType ? { amazonFeedProductType } : {}),
        ...(amazonItemType ? { amazonItemType } : {}),
        ...(amazonClosureType ? { amazonClosureType } : {}),
        ...(amazonStyleName ? { amazonStyleName } : {}),
        ...(amazonItemTypeName ? { amazonItemTypeName } : {}),
        ...(amazonCoatChildOnlyRowFields ? { amazonCoatChildOnlyRowFields } : {}),
      });
      for (const row of vrows) rowObjects.push(row);
    }
    return await applyCustomTemplate(templateBuffer, rowObjects);
  }

  async function sendAmazonExport() {
    res.setHeader('X-Export-ColumnMap-Mode', exportColumnMapMode);
    if (exportColumnMapVersion) res.setHeader('X-Export-ColumnMap-Version', exportColumnMapVersion);
    if (exportColumnMapHeaderRow) res.setHeader('X-Export-ColumnMap-HeaderRow', exportColumnMapHeaderRow);
    if (exportColumnMapDataStartRow) res.setHeader('X-Export-ColumnMap-DataStartRow', exportColumnMapDataStartRow);
    if (exportColumnMapSheetName) res.setHeader('X-Export-ColumnMap-SheetName', exportColumnMapSheetName);
    if (format === 'xlsx') res.setHeader('X-Export-Workbook-Extension', workbookExt);
    const body = await buildAmazonExportBuffer();
    if (format === 'xlsx') {
      res.setHeader('X-Export-Workbook-Extension', workbookExt);
      res.setHeader('Content-Disposition', `attachment; filename="amazon_export.${workbookExt}"`);
      res.setHeader('Content-Type', workbookMime);
      res.send(body);
      return;
    }
    res.setHeader('Content-Disposition', 'attachment; filename="amazon_export.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(body);
  }

  /**
   * 亚马逊导出 + 含图片：表格与单独导出完全一致，zip 内额外附带「已去背景」主图/副图文件（images/{id}/…/main-nobg|gallery-nobg/）。
   */
  async function buildAmazonZipWithNobgImages() {
    res.setHeader('X-Export-ColumnMap-Mode', exportColumnMapMode);
    if (exportColumnMapVersion) res.setHeader('X-Export-ColumnMap-Version', exportColumnMapVersion);
    if (exportColumnMapHeaderRow) res.setHeader('X-Export-ColumnMap-HeaderRow', exportColumnMapHeaderRow);
    if (exportColumnMapDataStartRow) res.setHeader('X-Export-ColumnMap-DataStartRow', exportColumnMapDataStartRow);
    if (exportColumnMapSheetName) res.setHeader('X-Export-ColumnMap-SheetName', exportColumnMapSheetName);
    if (format === 'xlsx' || templateBuffer) res.setHeader('X-Export-Workbook-Extension', workbookExt);
    const tableBuf = await buildAmazonExportBuffer();
    const tableName =
      format === 'xlsx' || templateBuffer ? `amazon_export.${workbookExt}` : 'amazon_export.csv';
    /** @type {{ zipName: string, ossKey?: string, absPath?: string }[]} */
    const imagesToAdd = [];
    const seenZip = new Set();
    const needsOss = rows.some((rr) => collectionUsesOss(rr.images_storage) && getOssConfig().enabled);
    const ossClient = needsOss ? newOssClient() : null;

    for (const r of rows) {
      const useOssRow = collectionUsesOss(r.images_storage) && getOssConfig().enabled;
      let manifest = null;
      try {
        if (r.images_manifest_json) manifest = JSON.parse(r.images_manifest_json);
      } catch {
        manifest = null;
      }
      const mainFilesNobg = Array.isArray(manifest?.mainFilesNobg) ? manifest.mainFilesNobg : null;
      const galleryFilesNobg = Array.isArray(manifest?.galleryFilesNobg)
        ? manifest.galleryFilesNobg
        : null;

      const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
      const baseDir = absCollectionImagesRoot(dataDir, r.id);
      const addFiles = (dir, files, subfolder) => {
        if (!Array.isArray(files)) return;
        for (const fn of files) {
          const name = String(fn || '').trim();
          if (!name) continue;
          const zipName = `${relCollectionImagesDir(r.id)}/${subfolder}/${name}`.replace(/\\/g, '/');
          if (seenZip.has(zipName)) continue;
          if (useOssRow) {
            const role = String(dir).includes('gallery') ? 'gallery_nobg' : 'main_nobg';
            const key = ossKeyForCollectionImage(r.id, role, name);
            seenZip.add(zipName);
            imagesToAdd.push({ zipName, ossKey: key });
          } else {
            const abs = path.join(dir, name);
            if (!fs.existsSync(abs)) continue;
            seenZip.add(zipName);
            imagesToAdd.push({ zipName, absPath: abs });
          }
        }
      };
      if (useOssRow) {
        addFiles('main_nobg', mainFilesNobg, 'main-nobg');
        addFiles('gallery_nobg', galleryFilesNobg, 'gallery-nobg');
      } else {
        addFiles(path.join(baseDir, 'main_nobg'), mainFilesNobg, 'main-nobg');
        addFiles(path.join(baseDir, 'gallery_nobg'), galleryFilesNobg, 'gallery-nobg');
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="amazon_export_with_images.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      try {
        res.status(500).end(String(err?.message || err));
      } catch {
        // ignore
      }
    });
    archive.pipe(res);

    archive.append(tableBuf, { name: tableName });

    for (const ent of imagesToAdd) {
      if (ent.ossKey && ossClient) {
        try {
          const st = await ossClient.getStream(ent.ossKey);
          archive.append(st.stream, { name: ent.zipName });
        } catch {
          // ignore missing
        }
      } else if (ent.absPath) {
        archive.file(ent.absPath, { name: ent.zipName });
      }
    }

    await archive.finalize();
  }

  async function buildZipAndSend() {
    res.setHeader('X-Export-ColumnMap-Mode', exportColumnMapMode);
    if (exportColumnMapVersion) res.setHeader('X-Export-ColumnMap-Version', exportColumnMapVersion);
    if (exportColumnMapHeaderRow) res.setHeader('X-Export-ColumnMap-HeaderRow', exportColumnMapHeaderRow);
    if (exportColumnMapDataStartRow) res.setHeader('X-Export-ColumnMap-DataStartRow', exportColumnMapDataStartRow);
    if (exportColumnMapSheetName) res.setHeader('X-Export-ColumnMap-SheetName', exportColumnMapSheetName);
    if (format === 'xlsx' || templateBuffer) res.setHeader('X-Export-Workbook-Extension', workbookExt);
    // 1) 重新用 rows 构建带 collectionId 的平铺表（用于替换图片字段）
    const flat2 = [];
    /** @type {{ zipName: string, ossKey?: string, absPath?: string }[]} */
    const imagesToAdd = [];
    const seenZip = new Set();
    const needsOss = rows.some((rr) => collectionUsesOss(rr.images_storage) && getOssConfig().enabled);
    const ossClient = needsOss ? newOssClient() : null;
    for (const r of rows) {
      const useOssRow = collectionUsesOss(r.images_storage) && getOssConfig().enabled;
      const parsed = genericToExportSecondaryPlatformData(parseGenericForExport(r));
      let manifest = null;
      try {
        const mj = db.prepare('SELECT images_manifest_json FROM collections WHERE id = ?').get(r.id);
        manifest = mj && mj.images_manifest_json ? JSON.parse(mj.images_manifest_json) : null;
      } catch {
        manifest = null;
      }
      const { main: mainUrlList, gallery: galleryUrlList } = extractImageUrlsFromRows(
        rawRowsFromStoredData(parsed)
      );
      const mainFilesNobg = Array.isArray(manifest?.mainFilesNobg) ? manifest.mainFilesNobg : null;
      const galleryFilesNobg = Array.isArray(manifest?.galleryFilesNobg)
        ? manifest.galleryFilesNobg
        : null;
      const useNobg =
        (mainFilesNobg && mainFilesNobg.length > 0) || (galleryFilesNobg && galleryFilesNobg.length > 0);
      const exportOpts = useNobg
        ? {
            mainFiles: mainFilesNobg || [],
            galleryFiles: galleryFilesNobg || [],
            mainFolder: 'main-nobg',
            galleryFolder: 'gallery-nobg',
          }
        : { mainFolder: 'main', galleryFolder: 'gallery' };
      const base = {
        采集记录ID: r.id,
        采集时间: r.collected_at,
        采集平台: r.platform,
        采集地址: r.url,
        用户名: r.username || '',
      };
      const skuRows = getExportRowsForDataJson(parsed);
      if (skuRows.length) {
        for (const sku of skuRows) {
          const rowObj = { ...base, ...sku };
          replaceImageFieldsForExport(rowObj, manifest, mainUrlList, galleryUrlList, r.id, exportOpts);
          flat2.push(rowObj);
        }
      } else {
        const rowObj = { ...base };
        replaceImageFieldsForExport(rowObj, manifest, mainUrlList, galleryUrlList, r.id, exportOpts);
        flat2.push(rowObj);
      }

      // 收集要打包的图片：zip 内路径与表格一致，如 images/42/main-nobg/哈希.png
      const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
      const baseDir = absCollectionImagesRoot(dataDir, r.id);
      const addFiles = (dirOrRole, files, subfolder, roleForOss) => {
        if (!Array.isArray(files)) return;
        for (const fn of files) {
          const name = String(fn || '').trim();
          if (!name) continue;
          const zipName = `${relCollectionImagesDir(r.id)}/${subfolder}/${name}`.replace(/\\/g, '/');
          if (seenZip.has(zipName)) continue;
          if (useOssRow) {
            const key = ossKeyForCollectionImage(r.id, roleForOss, name);
            seenZip.add(zipName);
            imagesToAdd.push({ zipName, ossKey: key });
          } else {
            const abs = path.join(dirOrRole, name);
            if (!fs.existsSync(abs)) continue;
            seenZip.add(zipName);
            imagesToAdd.push({ zipName, absPath: abs });
          }
        }
      };
      if (useNobg) {
        if (useOssRow) {
          addFiles('main_nobg', mainFilesNobg, 'main-nobg', 'main_nobg');
          addFiles('gallery_nobg', galleryFilesNobg, 'gallery-nobg', 'gallery_nobg');
        } else {
          addFiles(path.join(baseDir, 'main_nobg'), mainFilesNobg, 'main-nobg', 'main_nobg');
          addFiles(path.join(baseDir, 'gallery_nobg'), galleryFilesNobg, 'gallery-nobg', 'gallery_nobg');
        }
      } else {
        if (useOssRow) {
          addFiles('main', manifest?.mainFiles, 'main', 'main');
          addFiles('gallery', manifest?.galleryFiles, 'gallery', 'gallery');
        } else {
          addFiles(path.join(baseDir, 'main'), manifest?.mainFiles, 'main', 'main');
          addFiles(path.join(baseDir, 'gallery'), manifest?.galleryFiles, 'gallery', 'gallery');
        }
      }
    }

    // 3) 生成表格 buffer
    let tableBuf;
    if (format === 'xlsx') {
      if (templateBuffer) {
        tableBuf = await applyCustomTemplate(templateBuffer, flat2);
      } else {
        const ws = XLSX.utils.json_to_sheet(flat2);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '采集数据');
        tableBuf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
      }
    } else {
      const ws = XLSX.utils.json_to_sheet(flat2.length ? flat2 : [{}]);
      const csv = XLSX.utils.sheet_to_csv(ws);
      tableBuf = Buffer.from('\uFEFF' + csv);
    }

    // 4) zip 输出：表格 + images/{采集记录ID}/main|gallery/（与表格列路径一致）
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="collections_with_images.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      try {
        res.status(500).end(String(err?.message || err));
      } catch {
        // ignore
      }
    });
    archive.pipe(res);

    archive.append(tableBuf, {
      name: format === 'xlsx' || templateBuffer ? `collections.${workbookExt}` : 'collections.csv',
    });

    for (const ent of imagesToAdd) {
      if (ent.ossKey && ossClient) {
        try {
          const st = await ossClient.getStream(ent.ossKey);
          archive.append(st.stream, { name: ent.zipName });
        } catch {
          // ignore missing
        }
      } else if (ent.absPath && fs.existsSync(ent.absPath)) {
        archive.file(ent.absPath, { name: ent.zipName });
      }
    }

    await archive.finalize();
  }

  try {
    const tx = db.transaction(() => {
      updateExported.run(nowCstIso(), ...idList);
    });
    tx();
    if (exportTarget === 'amazon' && includeImages) {
      await buildAmazonZipWithNobgImages();
    } else if (exportTarget === 'amazon') {
      await sendAmazonExport();
    } else if (includeImages) {
      await buildZipAndSend();
    } else {
      await sendFile();
    }
  } catch (e) {
    const code = Number(e?.statusCode);
    const status = Number.isFinite(code) && code >= 400 && code < 600 ? code : 500;
    res.status(status).json({ error: e?.message || String(e) });
  }
}

app.get(
  '/api/collections/export/data',
  authMiddleware,
  requireModuleAny(['collections', 'data-export']),
  handleCollectionsExportData
);
app.post(
  '/api/collections/export/data',
  authMiddleware,
  requireModuleAny(['collections', 'data-export']),
  handleCollectionsExportData
);

app.patch('/api/collections/:id/mark', authMiddleware, requireModule('collections'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const row = db.prepare('SELECT user_id FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权修改' });
    return;
  }
  const raw = req.body?.mark;
  const normalized = raw == null || raw === '' ? null : String(raw).trim().toLowerCase();
  if (
    normalized != null &&
    normalized !== 'export' &&
    normalized !== 'pending' &&
    normalized !== 'discard'
  ) {
    res.status(400).json({ error: '标记须为 export / pending / discard 或清空' });
    return;
  }
  db.prepare('UPDATE collections SET user_mark = ? WHERE id = ?').run(normalized, id);
  notifyCollectionsChanged({ type: 'mark', collectionId: id, userId: row.user_id });
  res.json({ ok: true });
});

app.patch('/api/collections/archive', authMiddleware, requireModule('collections'), (req, res) => {
  const ids = normalizeCollectionIds(req.body?.ids);
  if (!ids.length) {
    res.status(400).json({ error: '请提供要归档的记录 id 列表' });
    return;
  }
  const rows = getAccessibleCollectionsForIds(req, ids);
  if (rows.length !== ids.length) {
    res.status(403).json({ error: '包含不存在或无权操作的记录' });
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE collections
        SET is_archived = 1,
            archived_at = ?
      WHERE id IN (${placeholders})`
  ).run(nowCstIso(), ...ids);
  const idsByUser = new Map();
  for (const row of rows) {
    const userId = Number(row.userId);
    if (!Number.isFinite(userId)) continue;
    const arr = idsByUser.get(userId) || [];
    arr.push(row.id);
    idsByUser.set(userId, arr);
  }
  for (const [userId, collectionIds] of idsByUser) {
    notifyCollectionsChanged({ type: 'archive', collectionIds, userId });
  }
  res.json({ ok: true, ids });
});

app.patch('/api/collections/restore', authMiddleware, requireModule('collections'), (req, res) => {
  const ids = normalizeCollectionIds(req.body?.ids);
  if (!ids.length) {
    res.status(400).json({ error: '请提供要恢复的记录 id 列表' });
    return;
  }
  const rows = getAccessibleCollectionsForIds(req, ids);
  if (rows.length !== ids.length) {
    res.status(403).json({ error: '包含不存在或无权操作的记录' });
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE collections
        SET is_archived = 0,
            archived_at = NULL
      WHERE id IN (${placeholders})`
  ).run(...ids);
  const idsByUser = new Map();
  for (const row of rows) {
    const userId = Number(row.userId);
    if (!Number.isFinite(userId)) continue;
    const arr = idsByUser.get(userId) || [];
    arr.push(row.id);
    idsByUser.set(userId, arr);
  }
  for (const [userId, collectionIds] of idsByUser) {
    notifyCollectionsChanged({ type: 'restore', collectionIds, userId });
  }
  res.json({ ok: true, ids });
});

async function copyLocalDirRecursive(srcDir, dstDir) {
  await fsp.mkdir(dstDir, { recursive: true });
  const ents = await fsp.readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const ent of ents) {
    const name = String(ent?.name || '');
    if (!name) continue;
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    if (ent.isDirectory()) {
      await copyLocalDirRecursive(src, dst);
    } else if (ent.isFile()) {
      await fsp.copyFile(src, dst).catch(() => {});
    }
  }
}

/**
 * 管理员：将其它用户已归档的采集数据复制到自己的归档库。
 * - 复制后生成新 ID
 * - 重新生成父 SKU（amazon_parent_sku）
 * - exported_at 清空（默认为未导出）
 * - 图片资源同步复制（本地或 OSS），保证后续“恢复到采集模块”后图片正常显示
 */
app.post('/api/admin/collections/copy-to-my-archive', authMiddleware, requireAdmin, async (req, res) => {
  const ids = normalizeCollectionIds(req.body?.ids);
  if (!ids.length) {
    res.status(400).json({ error: '请提供要复制的归档记录 id 列表' });
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const srcRows = db
    .prepare(
      `SELECT *
         FROM collections
        WHERE id IN (${placeholders})
          AND COALESCE(is_archived, 0) = 1`
    )
    .all(...ids);

  const srcById = new Map((Array.isArray(srcRows) ? srcRows : []).map((r) => [Number(r.id), r]));
  if (srcById.size !== ids.length) {
    res.status(400).json({ error: '包含不存在或非归档库的记录，无法复制' });
    return;
  }

  const dupPlaceholders = ids.map(() => '?').join(',');
  const dupRows = db
    .prepare(
      `SELECT source_collection_id AS id FROM admin_archive_copy_log
        WHERE admin_user_id = ? AND source_collection_id IN (${dupPlaceholders})`
    )
    .all(req.user.sub, ...ids);
  if (dupRows.length > 0) {
    const dupIds = dupRows.map((x) => x.id).join(', ');
    res.status(400).json({ error: `以下记录已由当前账号复制过，无法重复复制：${dupIds}` });
    return;
  }

  const now = nowCstIso();
  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();

  /** @type {Array<{ srcId:number; newId:number }>} */
  const created = [];
  try {
    const insert = db.prepare(
      `INSERT INTO collections (
        user_id,
        collected_at,
        platform,
        url,
        data_json,
        generic_data_json,
        platform_data_json,
        exported_at,
        is_archived,
        archived_at,
        images_status,
        images_downloaded_at,
        images_error,
        images_manifest_json,
        images_nobg_status,
        images_nobg_at,
        images_nobg_error,
        images_storage,
        ai_post_status,
        ai_prompt_profile_id,
        ai_prompt_profile_name,
        ai_prompt_platform_key,
        ai_prompt_profile_set_at,
        export_dest_platform_id,
        user_mark,
        amazon_parent_sku
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      )`
    );

    for (const srcId of ids) {
      const r = srcById.get(Number(srcId));
      const out = insert.run(
        req.user.sub,
        r.collected_at,
        r.platform ?? '',
        r.url ?? '',
        r.data_json ?? '{}',
        r.generic_data_json ?? r.data_json ?? '{}',
        r.platform_data_json ?? r.data_json ?? '{}',
        null, // exported_at: reset to "未导出"
        1,
        now,
        r.images_status ?? null,
        r.images_downloaded_at ?? null,
        r.images_error ?? null,
        r.images_manifest_json ?? null,
        r.images_nobg_status ?? null,
        r.images_nobg_at ?? null,
        r.images_nobg_error ?? null,
        r.images_storage ?? null,
        r.ai_post_status ?? null,
        r.ai_prompt_profile_id ?? null,
        r.ai_prompt_profile_name ?? null,
        r.ai_prompt_platform_key ?? null,
        r.ai_prompt_profile_set_at ?? null,
        r.export_dest_platform_id ?? null,
        null, // user_mark: reset
        null // amazon_parent_sku: regenerate
      );
      const newId = Number(out.lastInsertRowid);
      created.push({ srcId: Number(srcId), newId });
    }

    // 复制图片资源（按每条记录的 storage 决定走 OSS 或本地）
    for (const { srcId, newId } of created) {
      const r = srcById.get(Number(srcId));
      const useOss = collectionUsesOss(r?.images_storage) && getOssConfig().enabled;
      if (useOss) {
        await copyOssObjectsForCollection(srcId, newId);
      } else {
        const srcDir = absCollectionImagesRoot(dataDir, srcId);
        const dstDir = absCollectionImagesRoot(dataDir, newId);
        if (fs.existsSync(srcDir)) {
          await copyLocalDirRecursive(srcDir, dstDir);
        }
      }
      // 父 SKU：写入新记录（保证唯一）
      ensureAmazonParentSkuForCollectionId(newId);
    }

    const insertCopyLog = db.prepare(
      `INSERT OR IGNORE INTO admin_archive_copy_log (admin_user_id, source_collection_id) VALUES (?, ?)`
    );
    for (const { srcId } of created) {
      insertCopyLog.run(req.user.sub, srcId);
    }

    notifyCollectionsChanged({
      type: 'admin-copy-to-my-archive',
      collectionIds: created.map((x) => x.newId),
      userId: req.user.sub,
    });
    res.json({ ok: true, copied: created });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/collections/:id', authMiddleware, requireModule('collections'), (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(
      `SELECT c.*, u.username FROM collections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`
    )
    .get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权查看' });
    return;
  }
  let data;
  try {
    data = JSON.parse(getPlatformJsonString(row));
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = {};
  }
  let genericData;
  try {
    genericData = JSON.parse(getGenericJsonString(row));
  } catch {
    genericData = {};
  }
  let imagesManifest = null;
  try {
    if (row.images_manifest_json) imagesManifest = JSON.parse(row.images_manifest_json);
  } catch {
    imagesManifest = null;
  }
  const baseUrl = getExportBaseUrl(req);
  const detailImagePublicUrls = [];
  try {
    const m = imagesManifest && typeof imagesManifest === 'object' && !Array.isArray(imagesManifest) ? imagesManifest : null;
    const dets = m && Array.isArray(m.detailFiles) ? m.detailFiles : [];
    for (const fn of dets) {
      const filename = String(fn ?? '').trim();
      if (!filename) {
        detailImagePublicUrls.push('');
        continue;
      }
      detailImagePublicUrls.push(
        buildPublicCollectionImageUrl(baseUrl, row.id, 'detail', filename, row.images_storage)
      );
    }
  } catch {
    // ignore
  }
  res.json({
    id: row.id,
    collectedAt: row.collected_at,
    platform: row.platform,
    url: row.url,
    userId: row.user_id,
    username: row.username,
    imagesStatus: row.images_status ?? null,
    imagesDownloadedAt: row.images_downloaded_at ?? null,
    imagesError: row.images_error ?? null,
    imagesManifest,
    detailImagePublicUrls,
    imagesNobgStatus: row.images_nobg_status ?? null,
    imagesNobgAt: row.images_nobg_at ?? null,
    imagesNobgError: row.images_nobg_error ?? null,
    aiPostStatus: row.ai_post_status ?? null,
    aiPromptProfileId: row.ai_prompt_profile_id ?? null,
    aiPromptProfileName: row.ai_prompt_profile_name ?? null,
    aiPromptPlatformKey: row.ai_prompt_platform_key ?? null,
    aiPromptProfileSetAt: row.ai_prompt_profile_set_at ?? null,
    exportDestPlatformId: row.export_dest_platform_id ?? null,
    imagesStorage: row.images_storage ?? null,
    userMark:
      row.user_mark && ['export', 'pending', 'discard'].includes(String(row.user_mark).trim().toLowerCase())
        ? String(row.user_mark).trim().toLowerCase()
        : null,
    /** 平台数据：默认亚马逊二次加工结果；详情编辑保存后覆盖；亚马逊 Listing 导出基于此 */
    data,
    /** 通用数据：插件上报 + 服务端清洗（sanitize 等），保留原始尺码文案；非亚马逊导出时由此在服务端二次加工 */
    genericData,
  });
});

function mimeForCollectionImage(fn) {
  const l = String(fn).toLowerCase();
  if (l.endsWith('.png')) return 'image/png';
  if (l.endsWith('.webp')) return 'image/webp';
  if (l.endsWith('.gif')) return 'image/gif';
  if (l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function sniffImageExtFromBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 12) return '';
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return '.png';
  }
  // JPEG SOI: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp';
  }
  // GIF: 'GIF8'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
  return '';
}

function ensureStringArrayLen(a, n) {
  const out = Array.isArray(a) ? [...a] : [];
  while (out.length < n) out.push('');
  return out;
}

function clearNobgSlotInManifest(manifest, role, index) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) return;
  const r = String(role || '').trim();
  if (r !== 'main' && r !== 'gallery') return;
  const src =
    r === 'main'
      ? Array.isArray(manifest.mainFiles)
        ? manifest.mainFiles
        : []
      : Array.isArray(manifest.galleryFiles)
        ? manifest.galleryFiles
        : [];
  const len = src.length;
  if (len <= 0 || idx >= len) return;
  if (r === 'main') {
    const a = ensureStringArrayLen(manifest.mainFilesNobg, len);
    a[idx] = '';
    manifest.mainFilesNobg = a;
  } else {
    const a = ensureStringArrayLen(manifest.galleryFilesNobg, len);
    a[idx] = '';
    manifest.galleryFilesNobg = a;
  }
}

/**
 * 读取已下载的主图/副图（本地或 OSS）：
 * - OSS 启用时优先从 Bucket 拉取（采集详情 / 带鉴权 fetch 与 zip 一致）；
 * - 否则或 OSS 无对象时回退本地 dataDir/images/...；
 * - 带有效 exp/sig（见 collectionImagePublic.js）时可匿名访问（用于亚马逊导出等外链）；
 * - 否则需登录且仅能访问本人记录（管理员可访问全部）。
 */
async function sendCollectionImageFile(req, res) {
  const id = Number(req.params.id);
  const role = String(req.params.role || '');
  let filename = path.basename(decodeURIComponent(String(req.params.filename || '')));
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  if (!['main', 'gallery', 'detail', 'main_nobg', 'gallery_nobg'].includes(role)) {
    res.status(400).json({ error: '路径无效' });
    return;
  }
  if (!filename) {
    res.status(400).json({ error: '缺少文件名' });
    return;
  }
  const meta = db.prepare('SELECT user_id, images_storage FROM collections WHERE id = ?').get(id);
  if (!meta) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (!req.publicImageAccess) {
    if (req.user.role !== 'admin' && meta.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权访问' });
      return;
    }
  }
  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const rootDir = path.join(absCollectionImagesRoot(dataDir, id), role);
  const abs = path.join(rootDir, filename);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedAbs = path.resolve(abs);
  const rel = path.relative(resolvedRoot, resolvedAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.status(400).json({ error: '非法路径' });
    return;
  }

  const oc = getOssConfig();
  const tryOss = collectionUsesOss(meta.images_storage) && oc.enabled;
  if (tryOss) {
    try {
      const client = newOssClient();
      const key = ossKeyForCollectionImage(id, role, filename);
      const result = await client.get(key);
      const raw = result?.content;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
      res.setHeader('Content-Type', mimeForCollectionImage(filename));
      const cache = req.publicImageAccess ? 'public, max-age=86400' : 'private, max-age=3600';
      res.setHeader('Cache-Control', cache);
      res.send(buf);
      return;
    } catch {
      /* OSS 无对象或异常时回退本地 */
    }
  }

  if (!fs.existsSync(resolvedAbs)) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  res.setHeader('Content-Type', mimeForCollectionImage(filename));
  const cache = req.publicImageAccess ? 'public, max-age=86400' : 'private, max-age=3600';
  res.setHeader('Cache-Control', cache);
  res.sendFile(resolvedAbs);
}

app.get('/api/collections/:id/image/:role/:filename', (req, res, next) => {
  if (verifyCollectionImageAccessFromRequest(req)) {
    req.publicImageAccess = true;
    return void sendCollectionImageFile(req, res).catch(next);
  }
  next();
}, authMiddleware, requireModule('collections'), (req, res, next) => {
  req.publicImageAccess = false;
  void sendCollectionImageFile(req, res).catch(next);
});

/**
 * OSS STS：前端直传使用。
 * - 返回仅允许写入该采集记录 images/{id}/... 前缀的临时凭证
 * - 需要 OSS_ENABLED=1 且配置 OSS_STS_ROLE_ARN
 */
app.get('/api/oss/sts', authMiddleware, requireModule('collections'), async (req, res) => {
  const collectionId = Number(req.query.collectionId);
  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    res.status(400).json({ error: '无效的 collectionId' });
    return;
  }
  try {
    const crow = db.prepare('SELECT user_id, images_storage FROM collections WHERE id = ?').get(collectionId);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权访问' });
      return;
    }
    if (!collectionUsesOss(crow.images_storage)) {
      res.status(400).json({ error: '该采集记录为本地存储，不能使用 OSS 直传' });
      return;
    }
    const prefix = ossKeyForCollectionImage(collectionId, '', ''); // .../images/{id}/
    const p = prefix.replace(/\/+$/, '') + '/';
    const sts = await issueOssStsForPrefix(p);
    res.json({ ok: true, ...sts });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** OSS 直传后：登记替换主图/副图（不接收文件体；如文件名不变仅触发状态更新/清理 nobg） */
app.post(
  '/api/collections/:id/image/replace-oss',
  authMiddleware,
  requireModule('collections'),
  (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const role = String(req.body?.role || '');
  const index = Number(req.body?.index);
  const filename = String(req.body?.filename || '').trim();
  if (role !== 'main' && role !== 'gallery') {
    res.status(400).json({ error: 'role 须为 main 或 gallery' });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: '无效的 index' });
    return;
  }
  if (!filename) {
    res.status(400).json({ error: '缺少 filename' });
    return;
  }
  const crow = db.prepare('SELECT user_id, images_manifest_json, images_storage FROM collections WHERE id = ?').get(
    id
  );
  if (!crow) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权修改' });
    return;
  }
  if (!collectionUsesOss(crow.images_storage)) {
    res.status(400).json({ error: '该采集记录为本地存储，请使用本地上传替换图片' });
    return;
  }
  let manifest = {};
  try {
    manifest = crow.images_manifest_json ? JSON.parse(crow.images_manifest_json) : {};
  } catch {
    manifest = {};
  }
  const mainFiles = Array.isArray(manifest.mainFiles) ? [...manifest.mainFiles] : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? [...manifest.galleryFiles] : [];
  const arr = role === 'main' ? mainFiles : galleryFiles;
  if (index >= arr.length) {
    res.status(400).json({ error: '索引超出范围' });
    return;
  }
  arr[index] = filename;
  if (role === 'main') manifest.mainFiles = arr;
  else manifest.galleryFiles = arr;
  // 替换原图：只清空该槽位对应的 nobg，避免整组都回退为“未去背景”
  clearNobgSlotInManifest(manifest, role, index);
  db.prepare(
    `UPDATE collections SET
      images_manifest_json = ?,
      images_nobg_status = COALESCE(images_nobg_status,'done'),
      images_nobg_error = NULL,
      images_nobg_at = COALESCE(images_nobg_at, ?)
     WHERE id = ?`
  ).run(JSON.stringify(manifest), nowCstIso(), id);
  res.json({ ok: true });
});

/** OSS 直传后：登记替换去背景主图/副图（保持 images_nobg_status=done） */
app.post(
  '/api/collections/:id/image/replace-nobg-oss',
  authMiddleware,
  requireModule('collections'),
  (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const role = String(req.body?.role || '');
  const index = Number(req.body?.index);
  const filename = String(req.body?.filename || '').trim();
  if (role !== 'main_nobg' && role !== 'gallery_nobg') {
    res.status(400).json({ error: 'role 须为 main_nobg 或 gallery_nobg' });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: '无效的 index' });
    return;
  }
  if (!filename) {
    res.status(400).json({ error: '缺少 filename' });
    return;
  }
  const crow = db
    .prepare(
      'SELECT user_id, images_nobg_status, images_manifest_json, images_storage FROM collections WHERE id = ?'
    )
    .get(id);
  if (!crow) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权修改' });
    return;
  }
  if (!collectionUsesOss(crow.images_storage)) {
    res.status(400).json({ error: '该采集记录为本地存储，请使用本地上传替换去背景图' });
    return;
  }
  if (String(crow.images_nobg_status || '') !== 'done') {
    res.status(400).json({ error: '该记录尚未完成去背景，无法替换 nobg 文件（请先执行去背景）' });
    return;
  }
  let manifest = {};
  try {
    manifest = crow.images_manifest_json ? JSON.parse(crow.images_manifest_json) : {};
  } catch {
    manifest = {};
  }
  const mainFiles = Array.isArray(manifest.mainFilesNobg) ? [...manifest.mainFilesNobg] : [];
  const galleryFiles = Array.isArray(manifest.galleryFilesNobg) ? [...manifest.galleryFilesNobg] : [];
  const arr = role === 'main_nobg' ? mainFiles : galleryFiles;
  if (index >= arr.length) {
    res.status(400).json({ error: '索引超出范围' });
    return;
  }
  arr[index] = filename;
  if (role === 'main_nobg') manifest.mainFilesNobg = arr;
  else manifest.galleryFilesNobg = arr;
  db.prepare(
    `UPDATE collections SET
      images_manifest_json = ?,
      images_nobg_status = 'done',
      images_nobg_error = NULL,
      images_nobg_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(manifest), nowCstIso(), id);
  res.json({ ok: true });
});

/** 手动替换某张已下载的主图/副图（覆盖磁盘文件并更新 manifest；去背景结果会清空需重做） */
app.post(
  '/api/collections/:id/image/replace',
  authMiddleware,
  requireModule('collections'),
  (req, res, next) => {
    uploadReplaceImage.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: '文件过大（最大 12MB）' });
          return;
        }
        res.status(400).json({ error: err.message || '上传无效' });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: '无效的 id' });
      return;
    }
    const role = String(req.body?.role || '');
    const index = Number(req.body?.index);
    if (role !== 'main' && role !== 'gallery') {
      res.status(400).json({ error: 'role 须为 main 或 gallery' });
      return;
    }
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: '无效的 index' });
      return;
    }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: '请上传图片文件' });
      return;
    }

    const crow = db
      .prepare('SELECT user_id, images_manifest_json, images_storage FROM collections WHERE id = ?')
      .get(id);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权修改' });
      return;
    }

    let manifest = {};
    try {
      if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
    } catch {
      manifest = {};
    }
    const mainFiles = Array.isArray(manifest.mainFiles) ? [...manifest.mainFiles] : [];
    const galleryFiles = Array.isArray(manifest.galleryFiles) ? [...manifest.galleryFiles] : [];
    const arr = role === 'main' ? mainFiles : galleryFiles;
    if (index >= arr.length) {
      res.status(400).json({ error: '索引超出范围' });
      return;
    }
    const oldFn = String(arr[index] || '').trim();
    if (!oldFn) {
      res.status(400).json({ error: '该位置无文件名' });
      return;
    }

    // 替换规则：文件名保持该槽位原 stem；扩展名采用上传文件的格式（优先），从而“文件名对应槽位、格式跟随上传”
    const newExt = extForUploadedImage(req.file) || extForExistingFilename(oldFn) || '.jpg';
    const stem = path.basename(oldFn, path.extname(oldFn));
    const newFn = stem + newExt;

    try {
      if (collectionUsesOss(crow.images_storage)) {
        const client = newOssClient();
        const newKey = ossKeyForCollectionImage(id, role, newFn);
        await client.put(newKey, req.file.buffer, {
          headers: req.file.mimetype ? { 'Content-Type': req.file.mimetype } : {},
        });
        // 尽力删除旧对象（扩展名变化时）
        if (newFn !== oldFn) {
          const oldKey = ossKeyForCollectionImage(id, role, oldFn);
          try {
            await client.delete(oldKey);
          } catch {
            // ignore
          }
        }
      } else {
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        const dir = path.join(absCollectionImagesRoot(dataDir, id), role);
        const oldAbs = path.join(dir, oldFn);
        const newAbs = path.join(dir, newFn);

        const resolvedDir = path.resolve(dir);
        const resolvedOld = path.resolve(oldAbs);
        const resolvedNew = path.resolve(newAbs);
        if (
          path.relative(resolvedDir, resolvedOld).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedOld))
        ) {
          res.status(400).json({ error: '非法路径' });
          refundUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
          return;
        }
        if (
          path.relative(resolvedDir, resolvedNew).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedNew))
        ) {
          res.status(400).json({ error: '非法路径' });
          refundUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
          return;
        }

        await fsp.mkdir(resolvedDir, { recursive: true });
        if (newFn === oldFn) {
          await fsp.writeFile(resolvedNew, req.file.buffer);
        } else {
          await fsp.writeFile(resolvedNew, req.file.buffer);
          try {
            if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
          } catch {
            // ignore
          }
        }
      }
      arr[index] = newFn;
      if (role === 'main') manifest.mainFiles = arr;
      else manifest.galleryFiles = arr;
      // 替换原图：只清空该槽位对应的 nobg，避免整组都回退为“未去背景”
      clearNobgSlotInManifest(manifest, role, index);

      db.prepare(
        `UPDATE collections SET
          images_manifest_json = ?,
          images_nobg_status = COALESCE(images_nobg_status,'done'),
          images_nobg_error = NULL,
          images_nobg_at = COALESCE(images_nobg_at, ?)
         WHERE id = ?`
      ).run(JSON.stringify(manifest), nowCstIso(), id);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  }
);

/**
 * AI 涂抹消除（DashScope image-erase-completion 或火山 i2i_inpainting，见 AI_ERASE_PROVIDER）：上传与当前槽位原图同尺寸的掩码 PNG（黑=保留，白=擦除），服务端调第三方后写回该槽位。
 * @body storageRole main|gallery|main_nobg|gallery_nobg, index, multipart mask
 */
app.post(
  '/api/collections/:id/image/ai-erase',
  authMiddleware,
  requireModule('collections'),
  (req, res, next) => {
    uploadReplaceImage.single('mask')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: '掩码图过大（最大 12MB）' });
          return;
        }
        res.status(400).json({ error: err.message || '上传无效' });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const providerOverrideRaw = String(req.body?.provider || '').trim();
    const providerOverride = providerOverrideRaw ? normalizeAiEraseProvider(providerOverrideRaw) : '';
    if (providerOverride) {
      if (!isAiEraseProviderConfigured(providerOverride)) {
        const label =
          providerOverride === 'tencent'
            ? '腾讯云'
            : providerOverride === 'volc'
              ? '火山引擎'
              : providerOverride === 'dashscope'
                ? '阿里百炼'
                : providerOverride === 'stability'
                  ? 'Stability'
                  : providerOverride;
        res.status(503).json({ error: `未配置 ${label} 通道所需密钥/环境变量` });
        return;
      }
    } else {
      const aiEraseAvail = getAiEraseAvailability();
      if (!aiEraseAvail.ok) {
        res.status(503).json({ error: aiEraseAvail.message });
        return;
      }
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: '无效的 id' });
      return;
    }
    const storageRole = String(req.body?.storageRole || '').trim();
    const index = Number(req.body?.index);
    if (!['main', 'gallery', 'main_nobg', 'gallery_nobg'].includes(storageRole)) {
      res.status(400).json({ error: 'storageRole 须为 main、gallery、main_nobg 或 gallery_nobg' });
      return;
    }
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: '无效的 index' });
      return;
    }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: '请上传掩码图 mask（PNG）' });
      return;
    }

    const crow = db
      .prepare(
        'SELECT user_id, images_manifest_json, images_storage, images_nobg_status FROM collections WHERE id = ?'
      )
      .get(id);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权修改' });
      return;
    }

    let manifest = {};
    try {
      if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
    } catch {
      manifest = {};
    }

    const isNobg = storageRole === 'main_nobg' || storageRole === 'gallery_nobg';
    if (isNobg && String(crow.images_nobg_status || '') !== 'done') {
      res.status(400).json({ error: '该记录尚未完成去背景，无法对去背景图做 AI 消除' });
      return;
    }

    const mainFiles = Array.isArray(manifest.mainFiles) ? [...manifest.mainFiles] : [];
    const galleryFiles = Array.isArray(manifest.galleryFiles) ? [...manifest.galleryFiles] : [];
    const mainNobg = Array.isArray(manifest.mainFilesNobg) ? [...manifest.mainFilesNobg] : [];
    const galleryNobg = Array.isArray(manifest.galleryFilesNobg) ? [...manifest.galleryFilesNobg] : [];

    let readRole;
    let arr;
    let oldFn;
    if (storageRole === 'main') {
      arr = mainFiles;
      readRole = 'main';
    } else if (storageRole === 'gallery') {
      arr = galleryFiles;
      readRole = 'gallery';
    } else if (storageRole === 'main_nobg') {
      arr = mainNobg;
      readRole = 'main_nobg';
    } else {
      arr = galleryNobg;
      readRole = 'gallery_nobg';
    }
    if (index >= arr.length) {
      res.status(400).json({ error: '索引超出范围' });
      return;
    }
    oldFn = String(arr[index] || '').trim();
    if (!oldFn) {
      res.status(400).json({ error: '该位置无文件名' });
      return;
    }

    let imageBuf;
    try {
      imageBuf = await readCollectionImageBuffer({
        collectionId: id,
        role: readRole,
        filename: oldFn,
        imagesStorage: crow.images_storage,
      });
    } catch (e) {
      res.status(400).json({ error: e?.message || '读取原图失败' });
      return;
    }

    const imageMime = mimeForCollectionImage(oldFn);
    const maskMime = String(req.file.mimetype || '').toLowerCase();
    if (!maskMime.includes('png')) {
      res.status(400).json({ error: '掩码须为 PNG' });
      return;
    }

    const hold = consumeUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
    if (!hold.ok) {
      res.status(403).json({ error: 'AI消除次数不足' });
      return;
    }

    try {
      const { buf: outBuf, contentType, provider } = await runImageErase({
        imageBuffer: imageBuf,
        imageMime,
        maskBuffer: req.file.buffer,
        fastMode: true,
        dilateFlag: false,
        addWatermark: false,
        ...(providerOverride ? { provider: providerOverride } : {}),
      });
      const outMime = contentType || 'image/png';
      const outFile = {
        buffer: outBuf,
        mimetype: outMime,
        originalname: 'ai-erase-result.png',
      };
      const newExt = extForUploadedImage(outFile) || extForExistingFilename(oldFn) || '.png';
      const stem = path.basename(oldFn, path.extname(oldFn));
      const newFn = stem + newExt;

      if (!isNobg) {
        const role = storageRole === 'main' ? 'main' : 'gallery';
        if (collectionUsesOss(crow.images_storage)) {
          const client = newOssClient();
          const newKey = ossKeyForCollectionImage(id, role, newFn);
          await client.put(newKey, outBuf, {
            headers: outMime ? { 'Content-Type': outMime } : {},
          });
          if (newFn !== oldFn) {
            const oldKey = ossKeyForCollectionImage(id, role, oldFn);
            try {
              await client.delete(oldKey);
            } catch {
              /* ignore */
            }
          }
        } else {
          const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
          const dir = path.join(absCollectionImagesRoot(dataDir, id), role);
          const oldAbs = path.join(dir, oldFn);
          const newAbs = path.join(dir, newFn);
          const resolvedDir = path.resolve(dir);
          const resolvedOld = path.resolve(oldAbs);
          const resolvedNew = path.resolve(newAbs);
          if (
            path.relative(resolvedDir, resolvedOld).startsWith('..') ||
            path.isAbsolute(path.relative(resolvedDir, resolvedOld))
          ) {
            res.status(400).json({ error: '非法路径' });
            refundUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
            return;
          }
          if (
            path.relative(resolvedDir, resolvedNew).startsWith('..') ||
            path.isAbsolute(path.relative(resolvedDir, resolvedNew))
          ) {
            res.status(400).json({ error: '非法路径' });
            refundUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
            return;
          }
          await fsp.mkdir(resolvedDir, { recursive: true });
          await fsp.writeFile(resolvedNew, outBuf);
          if (newFn !== oldFn) {
            try {
              if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
            } catch {
              /* ignore */
            }
          }
        }
        arr[index] = newFn;
        if (role === 'main') manifest.mainFiles = arr;
        else manifest.galleryFiles = arr;
        clearNobgSlotInManifest(manifest, role, index);
        db.prepare(
          `UPDATE collections SET
            images_manifest_json = ?,
            images_nobg_status = COALESCE(images_nobg_status,'done'),
            images_nobg_error = NULL,
            images_nobg_at = COALESCE(images_nobg_at, ?)
           WHERE id = ?`
        ).run(JSON.stringify(manifest), nowCstIso(), id);
      } else {
        const role = storageRole;
        if (collectionUsesOss(crow.images_storage)) {
          const client = newOssClient();
          const newKey = ossKeyForCollectionImage(id, role, newFn);
          await client.put(newKey, outBuf, {
            headers: outMime ? { 'Content-Type': outMime } : {},
          });
          if (newFn !== oldFn) {
            const oldKey = ossKeyForCollectionImage(id, role, oldFn);
            try {
              await client.delete(oldKey);
            } catch {
              /* ignore */
            }
          }
        } else {
          const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
          const folder = role;
          const dir = path.join(absCollectionImagesRoot(dataDir, id), folder);
          const oldAbs = path.join(dir, oldFn);
          const newAbs = path.join(dir, newFn);
          const resolvedDir = path.resolve(dir);
          const resolvedOld = path.resolve(oldAbs);
          const resolvedNew = path.resolve(newAbs);
          if (
            path.relative(resolvedDir, resolvedOld).startsWith('..') ||
            path.isAbsolute(path.relative(resolvedDir, resolvedOld))
          ) {
            res.status(400).json({ error: '非法路径' });
            return;
          }
          if (
            path.relative(resolvedDir, resolvedNew).startsWith('..') ||
            path.isAbsolute(path.relative(resolvedDir, resolvedNew))
          ) {
            res.status(400).json({ error: '非法路径' });
            return;
          }
          await fsp.mkdir(resolvedDir, { recursive: true });
          await fsp.writeFile(resolvedNew, outBuf);
          if (newFn !== oldFn) {
            try {
              if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
            } catch {
              /* ignore */
            }
          }
        }
        arr[index] = newFn;
        if (role === 'main_nobg') manifest.mainFilesNobg = arr;
        else manifest.galleryFilesNobg = arr;
        db.prepare(
          `UPDATE collections SET
            images_manifest_json = ?,
            images_nobg_status = 'done',
            images_nobg_error = NULL,
            images_nobg_at = ?
           WHERE id = ?`
        ).run(JSON.stringify(manifest), nowCstIso(), id);
      }

      res.json({ ok: true, filename: newFn, provider });
    } catch (e) {
      refundUserCredits(Number(crow.user_id), 'ai_erase_credits', 1);
      res.status(500).json({ error: e?.message || String(e) });
    }
  }
);

/**
 * 图像修复（百度 inpainting）：按规则矩形修复并写回当前槽位。
 * @body storageRole main|gallery|main_nobg|gallery_nobg, index, rectangle:[{left,top,width,height}]
 */
app.post('/api/collections/:id/image/repair', authMiddleware, requireModule('collections'), async (req, res) => {
  if (!isBaiduInpaintingConfigured()) {
    res.status(503).json({ error: '未配置百度图像修复（请设置 BAIDU_API_KEY / BAIDU_SECRET_KEY）' });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const storageRole = String(req.body?.storageRole || '').trim();
  const index = Number(req.body?.index);
  const rectangle = Array.isArray(req.body?.rectangle) ? req.body.rectangle : [];
  if (!['main', 'gallery', 'main_nobg', 'gallery_nobg'].includes(storageRole)) {
    res.status(400).json({ error: 'storageRole 须为 main、gallery、main_nobg 或 gallery_nobg' });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: '无效的 index' });
    return;
  }
  if (!rectangle.length) {
    res.status(400).json({ error: '请提供 rectangle（至少 1 个矩形）' });
    return;
  }

  const crow = db
    .prepare(
      'SELECT user_id, images_manifest_json, images_storage, images_nobg_status FROM collections WHERE id = ?'
    )
    .get(id);
  if (!crow) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权修改' });
    return;
  }

  const isNobg = storageRole === 'main_nobg' || storageRole === 'gallery_nobg';
  if (isNobg && String(crow.images_nobg_status || '') !== 'done') {
    res.status(400).json({ error: '该记录尚未完成去背景，无法对去背景图做图像修复' });
    return;
  }

  let manifest = {};
  try {
    if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
  } catch {
    manifest = {};
  }

  const mainFiles = Array.isArray(manifest.mainFiles) ? [...manifest.mainFiles] : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? [...manifest.galleryFiles] : [];
  const mainNobg = Array.isArray(manifest.mainFilesNobg) ? [...manifest.mainFilesNobg] : [];
  const galleryNobg = Array.isArray(manifest.galleryFilesNobg) ? [...manifest.galleryFilesNobg] : [];

  let readRole;
  let arr;
  if (storageRole === 'main') {
    arr = mainFiles;
    readRole = 'main';
  } else if (storageRole === 'gallery') {
    arr = galleryFiles;
    readRole = 'gallery';
  } else if (storageRole === 'main_nobg') {
    arr = mainNobg;
    readRole = 'main_nobg';
  } else {
    arr = galleryNobg;
    readRole = 'gallery_nobg';
  }
  if (index >= arr.length) {
    res.status(400).json({ error: '索引超出范围' });
    return;
  }
  const oldFn = String(arr[index] || '').trim();
  if (!oldFn) {
    res.status(400).json({ error: '该位置无文件名' });
    return;
  }

  let imageBuf;
  try {
    imageBuf = await readCollectionImageBuffer({
      collectionId: id,
      role: readRole,
      filename: oldFn,
      imagesStorage: crow.images_storage,
    });
  } catch (e) {
    res.status(400).json({ error: e?.message || '读取原图失败' });
    return;
  }

  // 百度接口：image 为 base64（不包含 data:image/... 头）
  const { imageBase64: outB64 } = await baiduInpaintRectangle({
    imageBase64: imageBuf.toString('base64'),
    rectangle: rectangle,
  });
  const outBuf = Buffer.from(outB64, 'base64');
  const sniffExt = sniffImageExtFromBuffer(outBuf);
  const newExt = sniffExt || extForExistingFilename(oldFn) || '.png';
  const stem = path.basename(oldFn, path.extname(oldFn));
  const newFn = stem + newExt;

  try {
    if (!isNobg) {
      const role = storageRole === 'main' ? 'main' : 'gallery';
      if (collectionUsesOss(crow.images_storage)) {
        const client = newOssClient();
        const newKey = ossKeyForCollectionImage(id, role, newFn);
        await client.put(newKey, outBuf, {
          headers: sniffExt ? { 'Content-Type': mimeForCollectionImage(newFn) } : {},
        });
        if (newFn !== oldFn) {
          const oldKey = ossKeyForCollectionImage(id, role, oldFn);
          try {
            await client.delete(oldKey);
          } catch {
            /* ignore */
          }
        }
      } else {
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        const dir = path.join(absCollectionImagesRoot(dataDir, id), role);
        const oldAbs = path.join(dir, oldFn);
        const newAbs = path.join(dir, newFn);
        const resolvedDir = path.resolve(dir);
        const resolvedOld = path.resolve(oldAbs);
        const resolvedNew = path.resolve(newAbs);
        if (
          path.relative(resolvedDir, resolvedOld).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedOld))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }
        if (
          path.relative(resolvedDir, resolvedNew).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedNew))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }
        await fsp.mkdir(resolvedDir, { recursive: true });
        await fsp.writeFile(resolvedNew, outBuf);
        if (newFn !== oldFn) {
          try {
            if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
          } catch {
            /* ignore */
          }
        }
      }

      arr[index] = newFn;
      if (role === 'main') manifest.mainFiles = arr;
      else manifest.galleryFiles = arr;
      clearNobgSlotInManifest(manifest, role, index);
      db.prepare(
        `UPDATE collections SET
          images_manifest_json = ?,
          images_nobg_status = COALESCE(images_nobg_status,'done'),
          images_nobg_error = NULL,
          images_nobg_at = COALESCE(images_nobg_at, ?)
         WHERE id = ?`
      ).run(JSON.stringify(manifest), nowCstIso(), id);
    } else {
      const role = storageRole === 'main_nobg' ? 'main_nobg' : 'gallery_nobg';
      if (collectionUsesOss(crow.images_storage)) {
        const client = newOssClient();
        const newKey = ossKeyForCollectionImage(id, role, newFn);
        await client.put(newKey, outBuf, {
          headers: sniffExt ? { 'Content-Type': mimeForCollectionImage(newFn) } : {},
        });
        if (newFn !== oldFn) {
          const oldKey = ossKeyForCollectionImage(id, role, oldFn);
          try {
            await client.delete(oldKey);
          } catch {
            /* ignore */
          }
        }
      } else {
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        const dir = path.join(absCollectionImagesRoot(dataDir, id), role);
        const oldAbs = path.join(dir, oldFn);
        const newAbs = path.join(dir, newFn);
        const resolvedDir = path.resolve(dir);
        const resolvedOld = path.resolve(oldAbs);
        const resolvedNew = path.resolve(newAbs);
        if (
          path.relative(resolvedDir, resolvedOld).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedOld))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }
        if (
          path.relative(resolvedDir, resolvedNew).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedNew))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }
        await fsp.mkdir(resolvedDir, { recursive: true });
        await fsp.writeFile(resolvedNew, outBuf);
        if (newFn !== oldFn) {
          try {
            if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
          } catch {
            /* ignore */
          }
        }
      }
      arr[index] = newFn;
      if (role === 'main_nobg') manifest.mainFilesNobg = arr;
      else manifest.galleryFilesNobg = arr;
      db.prepare(
        `UPDATE collections SET
          images_manifest_json = ?,
          images_nobg_status = 'done',
          images_nobg_error = NULL,
          images_nobg_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(manifest), nowCstIso(), id);
    }

    res.json({ ok: true, filename: newFn });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** 手动新增一张副图（最多 8 张；文件名由服务端生成；格式跟随上传文件；去背景该槽位清空需重做） */
app.post(
  '/api/collections/:id/image/append-gallery',
  authMiddleware,
  requireModule('collections'),
  (req, res, next) => {
    uploadReplaceImage.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: '文件过大（最大 12MB）' });
          return;
        }
        res.status(400).json({ error: err.message || '上传无效' });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: '无效的 id' });
      return;
    }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: '请上传图片文件' });
      return;
    }

    const crow = db
      .prepare('SELECT user_id, images_manifest_json, images_storage FROM collections WHERE id = ?')
      .get(id);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权修改' });
      return;
    }

    let manifest = {};
    try {
      if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
    } catch {
      manifest = {};
    }
    const galleryFiles = Array.isArray(manifest.galleryFiles) ? [...manifest.galleryFiles] : [];
    if (galleryFiles.length >= 8) {
      res.status(400).json({ error: '副图最多 8 张' });
      return;
    }

    const ext = extForUploadedImage(req.file) || '.jpg';
    const existing = new Set(galleryFiles.map((x) => String(x || '').trim()).filter(Boolean));
    const baseStem = `gallery_${galleryFiles.length + 1}`;
    let stem = baseStem;
    let newFn = `${stem}${ext}`;
    let guard = 0;
    while (existing.has(newFn) && guard++ < 50) {
      stem = `${baseStem}_${guard}`;
      newFn = `${stem}${ext}`;
    }

    try {
      if (collectionUsesOss(crow.images_storage)) {
        const client = newOssClient();
        const key = ossKeyForCollectionImage(id, 'gallery', newFn);
        await client.put(key, req.file.buffer, {
          headers: req.file.mimetype ? { 'Content-Type': req.file.mimetype } : {},
        });
      } else {
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        const dir = path.join(absCollectionImagesRoot(dataDir, id), 'gallery');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, newFn), req.file.buffer);
      }

      galleryFiles.push(newFn);
      manifest.galleryFiles = galleryFiles;

      // 新增原图：仅清空新增槽位对应的 nobg（若此前已去背景）
      const len = galleryFiles.length;
      const a = ensureStringArrayLen(manifest.galleryFilesNobg, len);
      a[len - 1] = '';
      manifest.galleryFilesNobg = a;

      db.prepare(
        `UPDATE collections SET
          images_manifest_json = ?,
          images_nobg_status = COALESCE(images_nobg_status,'done'),
          images_nobg_error = NULL,
          images_nobg_at = COALESCE(images_nobg_at, ?)
         WHERE id = ?`
      ).run(JSON.stringify(manifest), nowCstIso(), id);

      res.json({ ok: true, filename: newFn, index: len - 1 });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  }
);

/** 手动替换某张已去背景的主图/副图（覆盖磁盘文件并更新 manifest；保持去背景状态为 done） */
app.post(
  '/api/collections/:id/image/replace-nobg',
  authMiddleware,
  requireModule('collections'),
  (req, res, next) => {
    uploadReplaceImage.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: '文件过大（最大 12MB）' });
          return;
        }
        res.status(400).json({ error: err.message || '上传无效' });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: '无效的 id' });
      return;
    }
    const role = String(req.body?.role || '');
    const index = Number(req.body?.index);
    if (role !== 'main_nobg' && role !== 'gallery_nobg') {
      res.status(400).json({ error: 'role 须为 main_nobg 或 gallery_nobg' });
      return;
    }
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: '无效的 index' });
      return;
    }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: '请上传图片文件' });
      return;
    }

    const crow = db
      .prepare(
        'SELECT user_id, images_nobg_status, images_manifest_json, images_storage FROM collections WHERE id = ?'
      )
      .get(id);
    if (!crow) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    if (req.user.role !== 'admin' && crow.user_id !== req.user.sub) {
      res.status(403).json({ error: '无权修改' });
      return;
    }
    if (String(crow.images_nobg_status || '') !== 'done') {
      res.status(400).json({ error: '该记录尚未完成去背景，无法替换 nobg 文件（请先执行去背景）' });
      return;
    }

    let manifest = {};
    try {
      if (crow.images_manifest_json) manifest = JSON.parse(crow.images_manifest_json);
    } catch {
      manifest = {};
    }
    const mainFiles = Array.isArray(manifest.mainFilesNobg) ? [...manifest.mainFilesNobg] : [];
    const galleryFiles = Array.isArray(manifest.galleryFilesNobg) ? [...manifest.galleryFilesNobg] : [];
    const arr = role === 'main_nobg' ? mainFiles : galleryFiles;
    if (index >= arr.length) {
      res.status(400).json({ error: '索引超出范围' });
      return;
    }
    const oldFn = String(arr[index] || '').trim();
    if (!oldFn) {
      res.status(400).json({ error: '该位置无文件名' });
      return;
    }

    // 替换规则：文件名保持该槽位原 stem；扩展名采用上传文件的格式（优先），从而“文件名对应槽位、格式跟随上传”
    const newExt = extForUploadedImage(req.file) || extForExistingFilename(oldFn) || '.jpg';
    const stem = path.basename(oldFn, path.extname(oldFn));
    const newFn = stem + newExt;

    try {
      if (collectionUsesOss(crow.images_storage)) {
        const client = newOssClient();
        const newKey = ossKeyForCollectionImage(id, role, newFn);
        await client.put(newKey, req.file.buffer, {
          headers: req.file.mimetype ? { 'Content-Type': req.file.mimetype } : {},
        });
        if (newFn !== oldFn) {
          const oldKey = ossKeyForCollectionImage(id, role, oldFn);
          try {
            await client.delete(oldKey);
          } catch {
            // ignore
          }
        }
      } else {
        const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
        const folder = role; // main_nobg / gallery_nobg
        const dir = path.join(absCollectionImagesRoot(dataDir, id), folder);
        const oldAbs = path.join(dir, oldFn);
        const newAbs = path.join(dir, newFn);

        const resolvedDir = path.resolve(dir);
        const resolvedOld = path.resolve(oldAbs);
        const resolvedNew = path.resolve(newAbs);
        if (
          path.relative(resolvedDir, resolvedOld).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedOld))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }
        if (
          path.relative(resolvedDir, resolvedNew).startsWith('..') ||
          path.isAbsolute(path.relative(resolvedDir, resolvedNew))
        ) {
          res.status(400).json({ error: '非法路径' });
          return;
        }

        await fsp.mkdir(resolvedDir, { recursive: true });
        if (newFn === oldFn) {
          await fsp.writeFile(resolvedNew, req.file.buffer);
        } else {
          await fsp.writeFile(resolvedNew, req.file.buffer);
          try {
            if (fs.existsSync(resolvedOld) && resolvedOld !== resolvedNew) await fsp.unlink(resolvedOld);
          } catch {
            // ignore
          }
        }
      }
      arr[index] = newFn;
      if (role === 'main_nobg') manifest.mainFilesNobg = arr;
      else manifest.galleryFilesNobg = arr;

      db.prepare(
        `UPDATE collections SET
          images_manifest_json = ?,
          images_nobg_status = 'done',
          images_nobg_error = NULL,
          images_nobg_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(manifest), nowCstIso(), id);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  }
);

app.put('/api/collections/:id', authMiddleware, requireModule('collections'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  const row = db.prepare('SELECT user_id FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权修改' });
    return;
  }
  const body = req.body || {};
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    res.status(400).json({ error: '请提供对象 data' });
    return;
  }
  const platformToStore = collectionDataHasSizeFieldArrays(data)
    ? applyPlatformDataOnSave(data)
    : data;
  let json;
  try {
    json = JSON.stringify(platformToStore);
  } catch {
    res.status(400).json({ error: 'data 含无法序列化的内容' });
    return;
  }
  const maxBytes = 25 * 1024 * 1024;
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    res.status(400).json({ error: '数据过大' });
    return;
  }
  db.prepare('UPDATE collections SET platform_data_json = ?, data_json = ? WHERE id = ?').run(json, json, id);
  res.json({ ok: true });
});

app.post(
  '/api/collections/:id/remove-background',
  authMiddleware,
  requireModule('collections'),
  async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  if (!isPixianConfigured()) {
    res.status(503).json({ error: '未配置 Pixian 密钥（环境变量 PIXIAN_USER / PIXIAN_SECRET）' });
    return;
  }
  const row = db
    .prepare(
      'SELECT user_id, images_status, images_manifest_json FROM collections WHERE id = ?'
    )
    .get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  if (String(row.images_status || '') !== 'done') {
    res.status(400).json({ error: '请等待图片下载完成后再去除背景' });
    return;
  }
  let manifest = {};
  try {
    manifest = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
  } catch {
    manifest = {};
  }
  const mainFiles = Array.isArray(manifest.mainFiles) ? manifest.mainFiles : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? manifest.galleryFiles : [];
  if (!mainFiles.length && !galleryFiles.length) {
    res.status(400).json({ error: '没有可处理的图片（请先完成下载）' });
    return;
  }

  try {
    const result = await runNobgSerialized(id, () =>
      processRemoveBackgroundForCollection(id, { onlyMain: false })
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e?.message || String(e);
    if (String(msg).includes('去背景次数不足')) {
      res.status(403).json({ error: '去背景次数不足' });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

/**
 * 单张去背景：替换某张图片后手动重跑该槽位
 * body: { role: 'main'|'gallery', index: number }
 */
app.post(
  '/api/collections/:id/remove-background-one',
  authMiddleware,
  requireModule('collections'),
  async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: '无效的 id' });
    return;
  }
  if (!isPixianConfigured()) {
    res.status(503).json({ error: '未配置 Pixian 密钥（环境变量 PIXIAN_USER / PIXIAN_SECRET）' });
    return;
  }
  const role = String(req.body?.role || '').trim();
  const index = Number(req.body?.index);
  if (role !== 'main' && role !== 'gallery') {
    res.status(400).json({ error: 'role 须为 main 或 gallery' });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: '无效的 index' });
    return;
  }
  const row = db
    .prepare('SELECT user_id, images_status, images_manifest_json FROM collections WHERE id = ?')
    .get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  if (String(row.images_status || '') !== 'done') {
    res.status(400).json({ error: '请等待图片下载完成后再去除背景' });
    return;
  }
  let manifest = {};
  try {
    manifest = row.images_manifest_json ? JSON.parse(row.images_manifest_json) : {};
  } catch {
    manifest = {};
  }
  const mainFiles = Array.isArray(manifest.mainFiles) ? manifest.mainFiles : [];
  const galleryFiles = Array.isArray(manifest.galleryFiles) ? manifest.galleryFiles : [];
  if (role === 'main' && (!mainFiles.length || index >= mainFiles.length)) {
    res.status(400).json({ error: '索引超出范围' });
    return;
  }
  if (role === 'gallery' && (!galleryFiles.length || index >= galleryFiles.length)) {
    res.status(400).json({ error: '索引超出范围' });
    return;
  }

  try {
    const r = await runNobgSerialized(id, () => processRemoveBackgroundForOneSlot(id, role, index));
    res.json({ ok: true, ...r });
  } catch (e) {
    const msg = e?.message || String(e);
    if (String(msg).includes('去背景次数不足')) {
      res.status(403).json({ error: '去背景次数不足' });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/collections/:id', authMiddleware, requireModule('collections'), async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id, images_storage FROM collections WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.sub) {
    res.status(403).json({ error: '无权删除' });
    return;
  }
  const rawDel = String(req.query?.deleteImages ?? '').trim().toLowerCase();
  const deleteImages = rawDel === '' ? true : !(rawDel === '0' || rawDel === 'false' || rawDel === 'no');
  const shouldCleanOss = deleteImages && collectionUsesOss(row.images_storage);
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  if (deleteImages) {
    // 同步清理磁盘图片目录：images/{id}/...
    try {
      const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
      const dir = absCollectionImagesRoot(dataDir, id);
      // force 兼容旧 Node；失败不影响删除 DB
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // OSS：删除该采集 id 下全部对象（与 ossKey 前缀一致）；images_storage=local 或未启用 OSS 时跳过
  if (shouldCleanOss) {
    try {
      const { deleted } = await deleteOssObjectsForCollection(id);
      if (deleted > 0) {
        console.log('[collections delete] OSS objects removed', id, 'count=', deleted);
      }
    } catch (e) {
      console.warn('[collections delete] OSS cleanup failed', id, e?.message || e);
    }
  }
  notifyCollectionsChanged({ type: 'delete', collectionId: id, userId: row.user_id });
  res.json({ ok: true });
});

/** ---------- 管理员：导出平台 id → MiMo 提示词平台键映射 ---------- */
app.get('/api/admin/export-platform-settings', authMiddleware, requireAdmin, (_req, res) => {
  try {
    res.json({
      map: getPlatformEnrichMap(),
      defaultExportPlatformId: getAppSetting('default_export_platform_id') || '',
      platforms: getExportPlatformCatalog(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.put('/api/admin/export-platform-settings', authMiddleware, requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const raw = body.map;
    const clean = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const kk = String(k).trim();
        if (!kk) continue;
        const vv = String(v ?? '').trim().toLowerCase();
        if (!vv) continue;
        if (!/^[a-z0-9_-]+$/.test(vv)) continue;
        clean[kk] = vv;
      }
    }
    setAppSetting('platform_enrich_map', JSON.stringify(clean));
    if (body.defaultExportPlatformId != null) {
      setAppSetting('default_export_platform_id', String(body.defaultExportPlatformId).trim());
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** ---------- 管理员：用户 ---------- */
app.get('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, role, valid_from, valid_to, created_at, allowed_modules_json,
              nobg_credits, ai_erase_credits, image_gen_credits, plan_id
       FROM users ORDER BY id`
    )
    .all();
  res.json(rows.map(mapUserRowForAdminApi));
});

app.get('/api/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(
      `SELECT id, username, role, valid_from, valid_to, created_at, allowed_modules_json,
              nobg_credits, ai_erase_credits, image_gen_credits, plan_id
       FROM users WHERE id = ?`
    )
    .get(id);
  if (!row) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  const ruleRows = db
    .prepare('SELECT rule_id AS ruleId FROM user_rule_access WHERE user_id = ?')
    .all(id);
  const ruleIds = ruleRows.map((r) => r.ruleId);
  res.json({ ...mapUserRowForAdminApi(row), ruleIds });
});

app.post('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  const {
    username,
    password,
    role,
    validFrom,
    validTo,
    ruleIds,
    allowedModules: rawMods,
    nobgCredits,
    aiEraseCredits,
    imageGenCredits,
    planId,
  } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: '用户名与密码必填' });
    return;
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) {
    res.status(400).json({ error: '用户名已存在' });
    return;
  }
  const finalRole = role === 'admin' ? 'admin' : 'user';
  let modsJson = null;
  if (finalRole === 'user') {
    const s = sanitizeAllowedModulesInput(rawMods);
    modsJson = JSON.stringify(
      s != null && s.length > 0 ? s : ['collections', 'images', 'data-export']
    );
  }
  const nobg = clampNonnegInt(nobgCredits, 0);
  const aiErase = clampNonnegInt(aiEraseCredits, 0);
  const imageGen = clampNonnegInt(imageGenCredits, 0);
  const nextPlanId = MEMBERSHIP_PLANS[String(planId || '').trim()] ? String(planId).trim() : 'trial';
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, valid_from, valid_to, allowed_modules_json, nobg_credits, ai_erase_credits, image_gen_credits, plan_id, quota_ym)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username,
      hash,
      finalRole,
      validFrom || null,
      validTo || null,
      modsJson,
      nobg,
      aiErase,
      imageGen,
      nextPlanId,
      currentCstYearMonth()
    );
  const uid = info.lastInsertRowid;
  const ids = Array.isArray(ruleIds) ? ruleIds.map(Number).filter(Boolean) : [];
  const insA = db.prepare('INSERT INTO user_rule_access (user_id, rule_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const rid of ids) insA.run(uid, rid);
  });
  tx();
  res.json({ id: uid });
});

app.put('/api/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!u) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  const {
    password,
    role,
    validFrom,
    validTo,
    ruleIds,
    allowedModules: rawMods,
    nobgCredits,
    aiEraseCredits,
    imageGenCredits,
    planId,
    defaultExportPlatformId,
  } = req.body || {};
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  let newRole = u.role;
  if (role === 'user' || role === 'admin') {
    newRole = role;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, id);
  }
  if (newRole === 'admin') {
    db.prepare('UPDATE users SET allowed_modules_json = NULL WHERE id = ?').run(id);
  } else if (rawMods !== undefined) {
    const s = sanitizeAllowedModulesInput(rawMods);
    db.prepare('UPDATE users SET allowed_modules_json = ? WHERE id = ?').run(
      JSON.stringify(s != null ? s : []),
      id
    );
  }
  if (validFrom !== undefined || validTo !== undefined) {
    const vf = validFrom === '' || validFrom == null ? null : validFrom;
    const vt = validTo === '' || validTo == null ? null : validTo;
    db.prepare('UPDATE users SET valid_from = ?, valid_to = ? WHERE id = ?').run(vf, vt, id);
  }
  if (nobgCredits !== undefined) {
    db.prepare('UPDATE users SET nobg_credits = ? WHERE id = ?').run(clampNonnegInt(nobgCredits, 0), id);
  }
  if (aiEraseCredits !== undefined) {
    db.prepare('UPDATE users SET ai_erase_credits = ? WHERE id = ?').run(clampNonnegInt(aiEraseCredits, 0), id);
  }
  if (imageGenCredits !== undefined) {
    db.prepare('UPDATE users SET image_gen_credits = ? WHERE id = ?').run(clampNonnegInt(imageGenCredits, 0), id);
  }
  if (defaultExportPlatformId !== undefined) {
    const next = defaultExportPlatformId == null ? '' : String(defaultExportPlatformId).trim();
    db.prepare('UPDATE users SET default_export_platform_id = ? WHERE id = ?').run(next, id);
  }
  if (planId !== undefined) {
    const nextPlanId = MEMBERSHIP_PLANS[String(planId || '').trim()] ? String(planId).trim() : 'trial';
    db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(nextPlanId, id);
    // 变更套餐：立刻按当前月重置为新套餐配额
    const p = MEMBERSHIP_PLANS[nextPlanId] || MEMBERSHIP_PLANS.trial;
    db.prepare(
      'UPDATE users SET quota_ym = ?, nobg_credits = ?, ai_erase_credits = ?, image_gen_credits = ? WHERE id = ?'
    ).run(
      currentCstYearMonth(),
      clampNonnegInt(p.perMonth.nobg, 0),
      clampNonnegInt(p.perMonth.erase, 0),
      clampNonnegInt(p.perMonth.imageGen ?? p.perMonth.erase, 0),
      id
    );
  }
  if (Array.isArray(ruleIds)) {
    db.prepare('DELETE FROM user_rule_access WHERE user_id = ?').run(id);
    const insA = db.prepare('INSERT INTO user_rule_access (user_id, rule_id) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (const rid of ruleIds.map(Number).filter(Boolean)) insA.run(id, rid);
    });
    tx();
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const self = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (self && self.username === 'admin') {
    res.status(400).json({ error: '不能删除内置 admin 账号' });
    return;
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** ---------- 管理员：规则 CRUD ---------- */
app.get('/api/admin/rules', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, platform, description, updated_at AS updatedAt FROM scrape_rules ORDER BY id DESC`
    )
    .all();
  res.json(rows);
});

app.get('/api/admin/rules/:id', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM scrape_rules WHERE id = ?').get(id);
  if (!r) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }
  let config;
  try {
    config = JSON.parse(r.config_json);
  } catch {
    config = { rules: [], pre_click_xpath: '' };
  }
  res.json({
    id: r.id,
    name: r.name,
    platform: r.platform,
    description: r.description,
    config,
  });
});

app.post('/api/admin/rules', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const { name, platform, description, config } = req.body || {};
  if (!name) {
    res.status(400).json({ error: '规则名称必填' });
    return;
  }
  const cfg = config && typeof config === 'object' ? config : { rules: [], pre_click_xpath: '' };
  const info = db
    .prepare(
      `INSERT INTO scrape_rules (name, platform, description, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      name,
      String(platform || ''),
      String(description || ''),
      JSON.stringify(cfg),
      nowCstIso()
    );
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/rules/:id', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT id FROM scrape_rules WHERE id = ?').get(id);
  if (!r) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }
  const { name, platform, description, config } = req.body || {};
  const cur = db.prepare('SELECT config_json FROM scrape_rules WHERE id = ?').get(id);
  let cfg = {};
  try {
    cfg = JSON.parse(cur.config_json);
  } catch {
    cfg = {};
  }
  if (config && typeof config === 'object') cfg = config;
  db.prepare(
    `UPDATE scrape_rules SET
      name = COALESCE(?, name),
      platform = COALESCE(?, platform),
      description = COALESCE(?, description),
      config_json = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    name ?? null,
    platform ?? null,
    description ?? null,
    JSON.stringify(cfg),
    nowCstIso(),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/rules/:id', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM scrape_rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** ---------- SKU 内置数据识别规则 ---------- */
function parseJsonField(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function skuDetectRuleFromDbRow(r) {
  return normalizeSkuDetectRule({
    id: r.id,
    name: r.name,
    platform: r.platform,
    matchHost: parseJsonField(r.match_host_json, []),
    enabled: Number(r.enabled) === 1,
    priority: Number(r.priority),
    windowPaths: parseJsonField(r.window_paths_json, []),
    scriptKeywords: parseJsonField(r.script_keywords_json, []),
    arrayDetectRules: parseJsonField(r.array_detect_rules_json, {}),
    fieldMapping: parseJsonField(r.field_mapping_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function skuDetectRuleToApi(r) {
  const rule = skuDetectRuleFromDbRow(r);
  return {
    ...rule,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeSkuDetectRulePayload(body) {
  const rule = normalizeSkuDetectRule(body || {});
  if (!rule.name) throw new Error('规则名称必填');
  if (!rule.platform) throw new Error('平台必填');
  if (!rule.matchHost.length) throw new Error('匹配域名不能为空');
  return rule;
}

function allSkuDetectRulesFromDb({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? `SELECT * FROM sku_detect_rules WHERE enabled = 1 ORDER BY priority ASC, id DESC`
    : `SELECT * FROM sku_detect_rules ORDER BY priority ASC, id DESC`;
  return db.prepare(sql).all().map(skuDetectRuleToApi);
}

app.get('/api/sku-detect-rules/match', authMiddleware, (req, res) => {
  const host = String(req.query.host || '').trim();
  const platform = String(req.query.platform || '').trim();
  if (!host) {
    res.status(400).json({ error: 'host 必填' });
    return;
  }
  const enabledRules = allSkuDetectRulesFromDb({ enabledOnly: true });
  const matched = matchSkuDetectRules(enabledRules, host, platform);
  const filtered = [];
  try {
    for (const r of enabledRules || []) {
      const m = r && typeof r === 'object' ? r.matchHost : null;
      const pats = Array.isArray(m) ? m : [];
      const hostLower = String(host || '').toLowerCase();
      const hasPat = pats.length > 0;
      const patHit = hasPat
        ? pats
            .map((x) => String(x || '').toLowerCase().trim())
            .filter(Boolean)
            .some((p) => p === '*' || hostLower === p || hostLower.endsWith(`.${p}`) || hostLower.includes(p))
        : false;
      if (!patHit) {
        filtered.push({
          name: String(r?.name || '—'),
          platform: String(r?.platform || ''),
          reason: hasPat ? 'host_not_match' : 'empty_matchHost',
        });
      }
    }
  } catch {
    // ignore
  }
  res.json({
    rules: matched,
    debug: {
      host,
      platform,
      enabledCount: Array.isArray(enabledRules) ? enabledRules.length : 0,
      matchedCount: Array.isArray(matched) ? matched.length : 0,
      filtered,
    },
  });
});

app.get('/api/admin/sku-detect-rules', authMiddleware, requireAdminOrModule('rules'), (_req, res) => {
  res.json({ rules: allSkuDetectRulesFromDb() });
});

app.post('/api/admin/sku-detect-rules', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  let rule;
  try {
    rule = normalizeSkuDetectRulePayload(req.body);
  } catch (e) {
    res.status(400).json({ error: e?.message || '规则无效' });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO sku_detect_rules
        (name, platform, match_host_json, enabled, priority, window_paths_json, script_keywords_json, array_detect_rules_json, field_mapping_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rule.name,
      rule.platform,
      JSON.stringify(rule.matchHost),
      rule.enabled ? 1 : 0,
      rule.priority,
      JSON.stringify(rule.windowPaths),
      JSON.stringify(rule.scriptKeywords),
      JSON.stringify(rule.arrayDetectRules),
      JSON.stringify(rule.fieldMapping),
      nowCstIso()
    );
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/sku-detect-rules/:id', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT id FROM sku_detect_rules WHERE id = ?').get(id);
  if (!cur) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }
  let rule;
  try {
    rule = normalizeSkuDetectRulePayload({ ...req.body, id });
  } catch (e) {
    res.status(400).json({ error: e?.message || '规则无效' });
    return;
  }
  db.prepare(
    `UPDATE sku_detect_rules SET
      name = ?,
      platform = ?,
      match_host_json = ?,
      enabled = ?,
      priority = ?,
      window_paths_json = ?,
      script_keywords_json = ?,
      array_detect_rules_json = ?,
      field_mapping_json = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    rule.name,
    rule.platform,
    JSON.stringify(rule.matchHost),
    rule.enabled ? 1 : 0,
    rule.priority,
    JSON.stringify(rule.windowPaths),
    JSON.stringify(rule.scriptKeywords),
    JSON.stringify(rule.arrayDetectRules),
    JSON.stringify(rule.fieldMapping),
    nowCstIso(),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/sku-detect-rules/:id', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM sku_detect_rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/admin/sku-detect-rules/export', authMiddleware, requireAdminOrModule('rules'), (_req, res) => {
  res.json({ version: '1.0', exportTime: nowCstIso(), rules: allSkuDetectRulesFromDb() });
});

app.post('/api/admin/sku-detect-rules/import', authMiddleware, requireAdminOrModule('rules'), (req, res) => {
  const list = Array.isArray(req.body?.rules) ? req.body.rules : Array.isArray(req.body) ? req.body : [];
  if (!list.length) {
    res.status(400).json({ error: '导入内容中没有 rules' });
    return;
  }
  const insert = db.prepare(
    `INSERT INTO sku_detect_rules
      (name, platform, match_host_json, enabled, priority, window_paths_json, script_keywords_json, array_detect_rules_json, field_mapping_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let count = 0;
  const tx = db.transaction((items) => {
    for (const item of items) {
      const rule = normalizeSkuDetectRulePayload(item);
      insert.run(
        rule.name,
        rule.platform,
        JSON.stringify(rule.matchHost),
        rule.enabled ? 1 : 0,
        rule.priority,
        JSON.stringify(rule.windowPaths),
        JSON.stringify(rule.scriptKeywords),
        JSON.stringify(rule.arrayDetectRules),
        JSON.stringify(rule.fieldMapping),
        nowCstIso()
      );
      count += 1;
    }
  });
  try {
    tx(list);
  } catch (e) {
    res.status(400).json({ error: e?.message || '导入失败' });
    return;
  }
  res.json({ ok: true, count });
});

function hostFromUrlOrHost(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    return new URL(s).host;
  } catch {
    return s;
  }
}

async function loadSkuDetectTestSources(body) {
  const jsonValues = [];
  const scriptTexts = [];
  const jsonText = String(body?.json || body?.windowJson || '').trim();
  if (jsonText) {
    try {
      jsonValues.push({ source: 'json', path: 'input.json', value: JSON.parse(jsonText) });
    } catch {
      throw new Error('粘贴的 window/context JSON 不是有效 JSON');
    }
  }
  const scriptText = String(body?.script || body?.scriptText || '').trim();
  if (scriptText) scriptTexts.push(scriptText);
  const url = String(body?.url || '').trim();
  if (url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 SKU Detect Tester' } });
      const html = await r.text();
      scriptTexts.push(html);
    } finally {
      clearTimeout(timer);
    }
  }
  return { jsonValues, scriptTexts };
}

app.post('/api/admin/sku-detect-rules/test', authMiddleware, requireAdminOrModule('rules'), async (req, res) => {
  const host = hostFromUrlOrHost(req.body?.host || req.body?.url);
  if (!host) {
    res.status(400).json({ error: '请提供商品页面 URL 或 host' });
    return;
  }
  let sources;
  try {
    sources = await loadSkuDetectTestSources(req.body || {});
  } catch (e) {
    res.status(400).json({ error: e?.message || '测试输入无效' });
    return;
  }
  const rules = allSkuDetectRulesFromDb({ enabledOnly: true });
  const result = detectSkuFromSources({
    rules,
    host,
    platform: String(req.body?.platform || ''),
    jsonValues: sources.jsonValues,
    scriptTexts: sources.scriptTexts,
  });
  if (result.ok) {
    res.json({
      ok: true,
      matchedRule: { id: result.rule.id, name: result.rule.name, platform: result.rule.platform },
      foundPath: result.path,
      source: result.source,
      rawCount: result.rawCount,
      preview: result.items.slice(0, 20).map((x) => ({
        skuId: x.skuId,
        color: x.color,
        size: x.size,
        stock: x.stock,
        price: x.price,
        mainImage: x.mainImage,
      })),
      missing: result.missing,
      attempts: result.attempts,
    });
    return;
  }
  res.json(result);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>采集 API</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;max-width:560px">
  <h1>采集后台 API 已运行</h1>
  <p>本服务只提供 <code>/api/*</code> 接口，没有网页首页。</p>
  <ul>
    <li>健康检查：<a href="/api/health">/api/health</a></li>
    <li>管理界面请使用前端开发服务：<strong>http://127.0.0.1:5173</strong>（或运行 <code>admin-ui</code> 的 <code>npm run dev</code>）</li>
  </ul>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Scraper admin API listening on http://localhost:${PORT}`);
  resumePendingCollectionAiJobs();
});
