import crypto from 'crypto';
import path from 'path';
import { db } from './db.js';
import { buildOssPublicUrl, collectionUsesOss, getOssConfig } from './oss.js';

/**
 * 采集图片「公开访问」签名（用于亚马逊导出等外链，无需登录）。
 * 需在 .env 配置 PUBLIC_IMAGE_SIGNING_SECRET；未配置则导出仍为需登录的 URL。
 */

export function getPublicImageSigningSecret() {
  return String(process.env.PUBLIC_IMAGE_SIGNING_SECRET || '').trim();
}

/**
 * 管理端「复制地址」、亚马逊导出等共用的完整外链（配置 PUBLIC_ORIGIN 时与导出一致；配置 PUBLIC_IMAGE_SIGNING_SECRET 时带 exp/sig，匿名可访问）
 * @param {string} baseUrl getExportBaseUrl(req) 或 PUBLIC_ORIGIN，无末尾斜杠
 * @param {unknown} [imagesStorage] 传入则不再查库；未传时按采集记录 images_storage 列判断
 */
export function buildPublicCollectionImageUrl(baseUrl, collectionId, role, filename, imagesStorage) {
  const oc = getOssConfig();
  let storage = imagesStorage;
  if (storage === undefined) {
    const row = db.prepare('SELECT images_storage FROM collections WHERE id = ?').get(collectionId);
    storage = row?.images_storage;
  }
  if (collectionUsesOss(storage) && oc.enabled && oc.publicOrigin) {
    const u = buildOssPublicUrl(collectionId, role, filename);
    if (u) return u;
  }
  const b = String(baseUrl || '').replace(/\/$/, '');
  const raw = path.basename(String(filename || '').trim());
  if (!b || !raw) return '';
  const fnEnc = encodeURIComponent(raw);
  let url = `${b}/api/collections/${collectionId}/image/${role}/${fnEnc}`;
  const signed = signCollectionImageAccess({ id: collectionId, role, filename: raw });
  if (signed) {
    url += `?exp=${signed.exp}&sig=${encodeURIComponent(signed.sig)}`;
  }
  return url;
}

/**
 * @param {{ id: number; role: string; filename: string; expiresInSec?: number }} opts
 * @returns {{ exp: number; sig: string } | null}
 */
export function signCollectionImageAccess({ id, role, filename, expiresInSec = 31536000 }) {
  const secret = getPublicImageSigningSecret();
  if (!secret) return null;
  const fn = path.basename(String(filename || '').trim());
  if (!fn) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Number(expiresInSec) || 31536000);
  const payload = `${id}|${role}|${fn}|${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { exp, sig };
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function verifyCollectionImageAccessFromRequest(req) {
  const secret = getPublicImageSigningSecret();
  if (!secret) return false;
  const id = Number(req.params.id);
  const role = String(req.params.role || '');
  let filename = path.basename(decodeURIComponent(String(req.params.filename || '')));
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || '').trim();
  if (!Number.isFinite(id) || id <= 0) return false;
  if (!['main', 'gallery', 'detail', 'main_nobg', 'gallery_nobg'].includes(role)) return false;
  if (!filename) return false;
  if (!sig || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = `${id}|${role}|${filename}|${exp}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
