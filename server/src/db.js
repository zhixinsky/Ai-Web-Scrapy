import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

export const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
  );
  CREATE TABLE IF NOT EXISTS scrape_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
  );
  CREATE TABLE IF NOT EXISTS user_rule_access (
    user_id INTEGER NOT NULL,
    rule_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, rule_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES scrape_rules(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    collected_at TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);
  CREATE INDEX IF NOT EXISTS idx_collections_time ON collections(collected_at);
`);

{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const hasMods = cols.some((c) => c.name === 'allowed_modules_json');
  if (!hasMods) {
    db.exec('ALTER TABLE users ADD COLUMN allowed_modules_json TEXT');
    db.exec(
      `UPDATE users SET allowed_modules_json = '["collections","images","data-export"]'
       WHERE role = 'user' AND (allowed_modules_json IS NULL OR TRIM(COALESCE(allowed_modules_json,'')) = '')`
    );
  }
}

// 用户额度：去背景次数 / AI 消除次数（按每张图片一次）
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const hasNobgCredits = cols.some((c) => c.name === 'nobg_credits');
  if (!hasNobgCredits) {
    db.exec('ALTER TABLE users ADD COLUMN nobg_credits INTEGER NOT NULL DEFAULT 0');
  }
  const hasAiEraseCredits = cols.some((c) => c.name === 'ai_erase_credits');
  if (!hasAiEraseCredits) {
    db.exec('ALTER TABLE users ADD COLUMN ai_erase_credits INTEGER NOT NULL DEFAULT 0');
  }
  const hasImageGenCredits = cols.some((c) => c.name === 'image_gen_credits');
  if (!hasImageGenCredits) {
    db.exec('ALTER TABLE users ADD COLUMN image_gen_credits INTEGER NOT NULL DEFAULT 0');
    // 首次上线：按当前套餐写入默认月度额度
    db.exec(`
      UPDATE users SET image_gen_credits = CASE TRIM(COALESCE(plan_id,''))
        WHEN 'studio' THEN 500
        WHEN 'pro' THEN 120
        WHEN 'lite' THEN 20
        ELSE 3
      END
      WHERE role != 'admin'
    `);
  }
}

/** 用户默认导出平台：采集入库时用于填写 export_dest_platform_id（可被本次采集 exportDestPlatformId 覆盖） */
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const hasDefaultExport = cols.some((c) => c.name === 'default_export_platform_id');
  if (!hasDefaultExport) {
    db.exec('ALTER TABLE users ADD COLUMN default_export_platform_id TEXT NOT NULL DEFAULT ""');
  }
}

// 会员体系：套餐 + 月度配额发放（标记当前月份已发放）
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const hasPlanId = cols.some((c) => c.name === 'plan_id');
  if (!hasPlanId) {
    db.exec("ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'trial'");
  }
  const hasQuotaYm = cols.some((c) => c.name === 'quota_ym');
  if (!hasQuotaYm) {
    db.exec("ALTER TABLE users ADD COLUMN quota_ym TEXT NOT NULL DEFAULT ''");
  }
}

{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasExported = cols.some((c) => c.name === 'exported_at');
  if (!hasExported) {
    db.exec('ALTER TABLE collections ADD COLUMN exported_at TEXT');
  }
  const hasArchived = cols.some((c) => c.name === 'is_archived');
  if (!hasArchived) {
    db.exec('ALTER TABLE collections ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_collections_is_archived ON collections(is_archived)');
  }
  const hasArchivedAt = cols.some((c) => c.name === 'archived_at');
  if (!hasArchivedAt) {
    db.exec('ALTER TABLE collections ADD COLUMN archived_at TEXT');
  }
}

// 图片下载状态：pending/done/failed
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasStatus = cols.some((c) => c.name === 'images_status');
  if (!hasStatus) {
    db.exec("ALTER TABLE collections ADD COLUMN images_status TEXT");
  }
  const hasDownloadedAt = cols.some((c) => c.name === 'images_downloaded_at');
  if (!hasDownloadedAt) {
    db.exec("ALTER TABLE collections ADD COLUMN images_downloaded_at TEXT");
  }
  const hasErr = cols.some((c) => c.name === 'images_error');
  if (!hasErr) {
    db.exec("ALTER TABLE collections ADD COLUMN images_error TEXT");
  }
  const hasManifest = cols.some((c) => c.name === 'images_manifest_json');
  if (!hasManifest) {
    db.exec("ALTER TABLE collections ADD COLUMN images_manifest_json TEXT");
  }
  const hasNobgStatus = cols.some((c) => c.name === 'images_nobg_status');
  if (!hasNobgStatus) {
    db.exec("ALTER TABLE collections ADD COLUMN images_nobg_status TEXT");
  }
  const hasNobgAt = cols.some((c) => c.name === 'images_nobg_at');
  if (!hasNobgAt) {
    db.exec("ALTER TABLE collections ADD COLUMN images_nobg_at TEXT");
  }
  const hasNobgErr = cols.some((c) => c.name === 'images_nobg_error');
  if (!hasNobgErr) {
    db.exec("ALTER TABLE collections ADD COLUMN images_nobg_error TEXT");
  }
}

/** 上报后异步 MiMo 富化：pending / done / skipped / failed；旧数据为 NULL 视为已完成 */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasAiPost = cols.some((c) => c.name === 'ai_post_status');
  if (!hasAiPost) {
    db.exec('ALTER TABLE collections ADD COLUMN ai_post_status TEXT');
  }
}

/** 采集入库自动处理：记录当时使用的 AI 提示词类别（用于追溯） */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasProfileId = cols.some((c) => c.name === 'ai_prompt_profile_id');
  if (!hasProfileId) {
    db.exec('ALTER TABLE collections ADD COLUMN ai_prompt_profile_id TEXT');
  }
  const hasProfileName = cols.some((c) => c.name === 'ai_prompt_profile_name');
  if (!hasProfileName) {
    db.exec('ALTER TABLE collections ADD COLUMN ai_prompt_profile_name TEXT');
  }
  const hasProfilePlatformKey = cols.some((c) => c.name === 'ai_prompt_platform_key');
  if (!hasProfilePlatformKey) {
    db.exec('ALTER TABLE collections ADD COLUMN ai_prompt_platform_key TEXT');
  }
  const hasProfileAt = cols.some((c) => c.name === 'ai_prompt_profile_set_at');
  if (!hasProfileAt) {
    db.exec('ALTER TABLE collections ADD COLUMN ai_prompt_profile_set_at TEXT');
  }
}

/** 通用数据 / 平台数据分栏：插件清洗后为通用数据；入库后立即生成默认亚马逊平台数据写入 platform_data；非亚马逊导出优先用已保存的 platform_data（无则 data_json），并对图片 URL 等做轻量规范化 */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasGen = cols.some((c) => c.name === 'generic_data_json');
  if (!hasGen) {
    db.exec('ALTER TABLE collections ADD COLUMN generic_data_json TEXT');
    db.exec('ALTER TABLE collections ADD COLUMN platform_data_json TEXT');
    db.exec(
      `UPDATE collections SET generic_data_json = data_json WHERE generic_data_json IS NULL OR TRIM(COALESCE(generic_data_json,'')) = ''`
    );
    db.exec(
      `UPDATE collections SET platform_data_json = data_json WHERE platform_data_json IS NULL OR TRIM(COALESCE(platform_data_json,'')) = ''`
    );
  }
}

/** 管理员配置的键值（如导出平台 UUID → MiMo 提示词平台键 amazon） */
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL DEFAULT ''
  );
`);

/**
 * 用户上传的“空模板表格”元信息（用于导出映射配置的自定义表头）。
 * headers_json：按列顺序的列名数组（允许重复；空字符串表示空表头单元格）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS export_templates (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    export_type_id TEXT NOT NULL DEFAULT '',
    dest_platform_id TEXT NOT NULL DEFAULT '',
    original_filename TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    sheet_name TEXT NOT NULL DEFAULT '',
    header_row INTEGER NOT NULL,
    data_start_row INTEGER NOT NULL,
    headers_json TEXT NOT NULL,
    created_by_user_id INTEGER,
    is_public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
  );
  -- 兼容旧版本：name 不应全局唯一，应按用户隔离
  DROP INDEX IF EXISTS idx_export_templates_name;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_export_templates_user_name ON export_templates(created_by_user_id, name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_export_templates_export_type_id ON export_templates(export_type_id);
  CREATE INDEX IF NOT EXISTS idx_export_templates_created_at ON export_templates(created_at);
`);

// 兼容迁移：若历史数据中同一用户下存在重名模板，自动加后缀避免创建组合唯一索引失败
{
  try {
    const dups = db
      .prepare(
        `SELECT created_by_user_id AS uid, name, COUNT(*) AS c
           FROM export_templates
          WHERE created_by_user_id IS NOT NULL
          GROUP BY created_by_user_id, name
         HAVING COUNT(*) > 1`
      )
      .all();
    for (const g of dups || []) {
      const uid = g.uid;
      const name = String(g.name || '').trim();
      if (uid == null || !name) continue;
      const rows = db
        .prepare(
          `SELECT id
             FROM export_templates
            WHERE created_by_user_id = ? AND name = ?
            ORDER BY created_at ASC, id ASC`
        )
        .all(uid, name);
      let n = 1;
      for (const r of rows || []) {
        const id = String(r.id || '').trim();
        if (!id) continue;
        if (n === 1) {
          n += 1;
          continue;
        }
        const next = `${name} (${n})`;
        db.prepare(`UPDATE export_templates SET name = ?, updated_at = (datetime('now','+8 hours')) WHERE id = ?`).run(
          next,
          id
        );
        n += 1;
      }
    }
  } catch {
    // ignore
  }
}

// 兼容：历史绝对路径改为相对 process.cwd()（与整目录迁移一致）
{
  try {
    const cwd = path.resolve(process.cwd());
    const rows = db.prepare('SELECT id, file_path FROM export_templates').all();
    const upd = db.prepare('UPDATE export_templates SET file_path = ? WHERE id = ?');
    for (const r of rows || []) {
      const fp = String(r.file_path || '').trim();
      if (!fp || !path.isAbsolute(fp)) continue;
      const abs = path.resolve(fp);
      const rel = path.relative(cwd, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const stored = rel.split(path.sep).join('/');
      upd.run(stored, r.id);
    }
  } catch {
    // ignore
  }
}

// 兼容旧库：补 export_type_id 列
{
  const cols = db.prepare('PRAGMA table_info(export_templates)').all();
  const has = cols.some((c) => c.name === 'export_type_id');
  if (!has) {
    db.exec("ALTER TABLE export_templates ADD COLUMN export_type_id TEXT NOT NULL DEFAULT ''");
  }
}

// 兼容旧库：补 dest_platform_id 列
{
  const cols = db.prepare('PRAGMA table_info(export_templates)').all();
  const has = cols.some((c) => c.name === 'dest_platform_id');
  if (!has) {
    db.exec("ALTER TABLE export_templates ADD COLUMN dest_platform_id TEXT NOT NULL DEFAULT ''");
  }
}

// 兼容旧库：补 is_public 列（旧数据默认公开，避免升级后普通用户看不到历史模板）
{
  const cols = db.prepare('PRAGMA table_info(export_templates)').all();
  const has = cols.some((c) => c.name === 'is_public');
  if (!has) {
    db.exec("ALTER TABLE export_templates ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE export_templates SET is_public = 1 WHERE is_public IS NULL");
  }
}

/** 采集记录可选绑定「导出目标平台」UUID，用于解析标题二次处理所用提示词 */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasEdp = cols.some((c) => c.name === 'export_dest_platform_id');
  if (!hasEdp) {
    db.exec('ALTER TABLE collections ADD COLUMN export_dest_platform_id TEXT');
  }
}

/** 用户标记：export=导出 / pending=待定 / discard=丢弃；NULL 表示未标记 */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasUserMark = cols.some((c) => c.name === 'user_mark');
  if (!hasUserMark) {
    db.exec('ALTER TABLE collections ADD COLUMN user_mark TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_collections_user_mark ON collections(user_mark)');
  }
}

/** 插件选择的图片落库方式：local=服务器磁盘 / oss=对象存储；NULL=未传（与 OSS_ENABLED 一致） */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasImgStore = cols.some((c) => c.name === 'images_storage');
  if (!hasImgStore) {
    db.exec('ALTER TABLE collections ADD COLUMN images_storage TEXT');
  }
}

/**
 * 亚马逊导出父 SKU（卖家 SKU）：需要持久化，保证同一条采集记录多次导出不变。
 * 格式：随机 6 位（大小写字母+数字） + '-' + 月日（MMDD）
 * 示例：D5s2tb-0612
 */
{
  const cols = db.prepare('PRAGMA table_info(collections)').all();
  const hasAmazonParentSku = cols.some((c) => c.name === 'amazon_parent_sku');
  if (!hasAmazonParentSku) {
    db.exec('ALTER TABLE collections ADD COLUMN amazon_parent_sku TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_collections_amazon_parent_sku ON collections(amazon_parent_sku)');
  }
}

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return;
  const hash = bcrypt.hashSync('admin123', 10);
  const urow = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, valid_from, valid_to)
       VALUES ('admin', ?, 'admin', date('now'), date('now','+10 years'))`
    )
    .run(hash);
  const adminId = urow.lastInsertRowid;
  const demoRule = {
    version: '1.0',
    rules: [],
    pre_click_xpath: '',
  };
  const rrow = db
    .prepare(
      `INSERT INTO scrape_rules (name, platform, description, config_json)
       VALUES ('示例规则（请在后台编辑）', '通用', '在「采集规则配置」中编辑 XPath 配置', ?)`
    )
    .run(JSON.stringify(demoRule));
  const rid = rrow.lastInsertRowid;
  db.prepare('INSERT INTO user_rule_access (user_id, rule_id) VALUES (?, ?)').run(adminId, rid);
}

seedIfEmpty();
