export const API_BASE = import.meta.env.VITE_API_BASE || '';
export const OSS_PUBLIC_ORIGIN = import.meta.env.VITE_OSS_PUBLIC_ORIGIN || '';
export const OSS_PREFIX = import.meta.env.VITE_OSS_PREFIX || '';

export type OssStsResponse = {
  ok: true;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  publicOrigin: string;
};

export function ossPublicUrlForCollectionImage(
  collectionId: number,
  role: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg',
  filename: string
): string {
  const origin = String(OSS_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  const prefix = String(OSS_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const fn = encodeURIComponent(String(filename || '')).replace(/%2F/g, '/');
  if (!origin || !fn) return '';
  const key = `${prefix ? `${prefix}/` : ''}images/${collectionId}/${role}/${fn}`;
  return `${origin}/${key}`.replace(/([^:]\/)\/+/g, '$1');
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(t: string | null) {
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export function collectionEventsUrl(): string | null {
  const token = getToken();
  if (!token) return null;
  const q = new URLSearchParams({ token });
  return `${API_BASE}/api/collections/events?${q.toString()}`;
}

/** 下载 Chrome 采集插件压缩包（解压后在 chrome://extensions 加载「已解压的扩展」） */
export async function downloadCollectionExtensionZip(): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/plugin/extension-zip`, { method: 'GET', headers });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('auth-expired'));
    throw new Error('未登录或登录已过期');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const t = await res.text();
      const data: unknown = t ? JSON.parse(t) : null;
      if (data && typeof data === 'object' && data !== null && 'error' in data) {
        msg = String((data as { error: string }).error);
      } else if (t) msg = t;
    } catch {
      /* ignore */
    }
    throw new Error(msg || '下载失败');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-collection-extension.zip';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function postFormData<T>(path: string, formData: FormData): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: formData, headers });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('auth-expired'));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: string }).error)
        : res.statusText;
    throw new Error(msg || '请求失败');
  }
  return data as T;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('auth-expired'));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: string }).error)
        : res.statusText;
    throw new Error(msg || '请求失败');
  }
  return data as T;
}

async function requestWithTimeout<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 75_000,
  timeoutMessage = '请求超时，请稍后重试'
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<T>(path, { ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 与服务端 GET /api/export/platforms 一致 */
export type ExportDestPlatform = {
  id: string;
  name: string;
  enrichKey?: string;
};

/** 与服务端 GET /api/export/types 一致（只读目录） */
export type ServerExportTypeRow = {
  id: string;
  name: string;
  mode: 'amazon' | 'generic';
  destPlatformId: string;
  hasBuiltinHeaderRow: boolean;
  columnCount: number;
  /** 表头行从左到右的列数（内置为 txt 行数；无内置时按映射估算） */
  headerColumnCount: number;
};

export type ExportPreviewResponse = {
  ok: true;
  exportTypeId: string;
  collectionId: number;
  parentRow: Record<string, unknown> | null;
  childRow: Record<string, unknown> | null;
  availableKeys: string[];
};

export type ExportBlobResponse = {
  blob: Blob;
  /** 服务端标记：builtin / draft */
  mappingMode?: string;
  /** 服务端实际使用的映射版本（若为 draft） */
  mappingVersion?: string;
  /** 服务端实际使用的 headerRow / dataStartRow（若可解析） */
  headerRow?: string;
  dataStartRow?: string;
  sheetName?: string;
};

export type CollectionAiPromptSettings = {
  platformKey: string;
  userId?: number | null;
  hasUserOverride?: boolean;
  activeProfileId?: string;
  activeProfileName?: string;
  prompts: {
    title: string;
    description: string;
    searchKeywords: string;
  };
  defaults: {
    title: string;
    description: string;
    searchKeywords: string;
  };
};

export type CollectionAiPromptProfile = {
  id: string;
  name: string;
  prompts: CollectionAiPromptSettings['prompts'];
};

export type CollectionAiPromptProfilesResponse = {
  platformKey: string;
  userId?: number | null;
  activeProfileId: string;
  activeProfileName?: string;
  profiles: CollectionAiPromptProfile[];
  defaults: CollectionAiPromptSettings['defaults'];
};

/** 采集列表用户标记（与库字段 user_mark 一致） */
export type CollectionUserMark = 'export' | 'pending' | 'discard';
/** 列表筛选：空=全部；unmarked=未标记 */
export type CollectionMarkFilter = '' | CollectionUserMark | 'unmarked';

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: UserInfo }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<UserInfo>('/api/auth/me'),
  collections: (q?: string) =>
    request<CollectionList>(`/api/collections${q ? `?${q}` : ''}`),
  archiveCollections: (ids: number[]) =>
    request<{ ok: boolean; ids: number[] }>(`/api/collections/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ ids }),
    }),
  restoreCollections: (ids: number[]) =>
    request<{ ok: boolean; ids: number[] }>(`/api/collections/restore`, {
      method: 'PATCH',
      body: JSON.stringify({ ids }),
    }),
  setCollectionMark: (id: number, mark: CollectionUserMark | null) =>
    request<{ ok: boolean }>(`/api/collections/${id}/mark`, {
      method: 'PATCH',
      body: JSON.stringify({ mark }),
    }),
  /** 图片资源管理：分页列出采集记录及已下载主图/副图（文件名），缩略图请用带 Token 的请求拉取 /api/collections/:id/image/... */
  imagesList: (q?: string) =>
    request<ImagesListResponse>(`/api/images${q ? `?${q}` : ''}`),
  /** 将主图/副图下载重新入队（pending/失败或卡住后） */
  retryCollectionImagesDownload: (id: number) =>
    request<{ ok: boolean }>(`/api/collections/${id}/images/retry-download`, { method: 'POST' }),
  /** 用本地上传文件替换指定主图/副图（保持 manifest 槽位，扩展名可变） */
  replaceCollectionImage: (
    id: number,
    opts: { role: 'main' | 'gallery'; index: number; file: File }
  ) => {
    const fd = new FormData();
    fd.append('role', opts.role);
    fd.append('index', String(opts.index));
    fd.append('file', opts.file);
    return postFormData<{ ok: boolean }>(`/api/collections/${id}/image/replace`, fd);
  },
  /** 图片资源管理：新增一张副图（最多 8 张；文件名由服务端生成；格式跟随上传文件） */
  appendCollectionGalleryImage: (id: number, opts: { file: File }) => {
    const fd = new FormData();
    fd.append('file', opts.file);
    return postFormData<{ ok: boolean; filename: string; index: number }>(
      `/api/collections/${id}/image/append-gallery`,
      fd
    );
  },
  /** OSS 直传后登记：替换指定主图/副图（不上传文件体） */
  replaceCollectionImageOss: (
    id: number,
    opts: { role: 'main' | 'gallery'; index: number; filename: string }
  ) =>
    request<{ ok: boolean }>(`/api/collections/${id}/image/replace-oss`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** 用本地上传文件替换指定去背景主图/副图（main_nobg / gallery_nobg） */
  replaceCollectionImageNobg: (
    id: number,
    opts: { role: 'main_nobg' | 'gallery_nobg'; index: number; file: File }
  ) => {
    const fd = new FormData();
    fd.append('role', opts.role);
    fd.append('index', String(opts.index));
    fd.append('file', opts.file);
    return postFormData<{ ok: boolean }>(`/api/collections/${id}/image/replace-nobg`, fd);
  },
  /** OSS 直传后登记：替换指定去背景主图/副图（不上传文件体） */
  replaceCollectionImageNobgOss: (
    id: number,
    opts: { role: 'main_nobg' | 'gallery_nobg'; index: number; filename: string }
  ) =>
    request<{ ok: boolean }>(`/api/collections/${id}/image/replace-nobg-oss`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** OSS STS：前端直传使用 */
  ossSts: (collectionId: number) =>
    request<OssStsResponse>(`/api/oss/sts?collectionId=${encodeURIComponent(String(collectionId))}`),
  collection: (id: number) => request<CollectionDetail>(`/api/collections/${id}`),
  /** 切换采集记录的数据格式（导出目标平台），并触发重新转化 + AI 后处理 */
  setCollectionExportDestPlatform: (id: number, exportDestPlatformId: string) =>
    request<{ ok: boolean; id: number; exportDestPlatformId: string }>(
      `/api/collections/${id}/export-dest-platform`,
      {
        method: 'PUT',
        body: JSON.stringify({ exportDestPlatformId }),
      }
    ),
  deleteCollection: (id: number, opts?: { deleteImages?: boolean }) => {
    const del = opts?.deleteImages !== false;
    const q = new URLSearchParams();
    q.set('deleteImages', del ? '1' : '0');
    return request<{ ok: boolean }>(`/api/collections/${id}?${q.toString()}`, { method: 'DELETE' });
  },
  updateCollection: (id: number, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/collections/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),
  /** 对已下载主图调用 Pixian 去背景（仅主图；需服务端配置 PIXIAN_USER / PIXIAN_SECRET） */
  removeCollectionBackground: (id: number) =>
    request<{ ok: boolean; mainCount: number; galleryCount: number }>(
      `/api/collections/${id}/remove-background`,
      { method: 'POST' }
    ),
  /** 单张去背景：替换某张图片后仅重跑该槽位（role=main|gallery） */
  removeCollectionBackgroundOne: (id: number, opts: { role: 'main' | 'gallery'; index: number }) =>
    request<{ ok: boolean; outFilename: string }>(`/api/collections/${id}/remove-background-one`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /**
   * AI 涂抹消除（阿里云 DashScope image-erase-completion）：上传与当前槽位原图同尺寸的掩码 PNG。
   * 需服务端配置 DASHSCOPE_API_KEY。
   */
  aiEraseCollectionImage: (
    id: number,
    opts: {
      storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
      index: number;
      mask: File;
      provider?: 'tencent' | 'volc' | 'dashscope' | 'stability';
    }
  ) => {
    const fd = new FormData();
    fd.append('storageRole', opts.storageRole);
    fd.append('index', String(opts.index));
    if (opts.provider) fd.append('provider', String(opts.provider));
    fd.append('mask', opts.mask, opts.mask.name || 'mask.png');
    return postFormData<{ ok: boolean; filename: string; provider?: 'dashscope' | 'volc' | 'tencent' | 'stability' }>(
      `/api/collections/${id}/image/ai-erase`,
      fd
    );
  },
  /**
   * 图像修复（百度 inpainting）：传入矩形区域，服务端读取该槽位原图并写回结果。
   * 需服务端配置 BAIDU_API_KEY / BAIDU_SECRET_KEY。
   */
  repairCollectionImage: (
    id: number,
    opts: {
      storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
      index: number;
      rectangle: Array<{ left: number; top: number; width: number; height: number }>;
    }
  ) =>
    request<{ ok: boolean; filename: string }>(`/api/collections/${id}/image/repair`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** 图片生成/编辑（千问 qwen-image-edit）：返回 base64 PNG */
  generateImage: (opts: { prompt: string; collectionId: number; storageRole: string; index: number; filename: string }) =>
    request<{ ok: true; b64: string; contentType?: string; model?: string; provider?: 'dashscope'; imageUrl?: string }>(
      '/api/ai/image/generate',
      {
      method: 'POST',
      body: JSON.stringify(opts),
      }
    ),
  mimoStatus: () => request<{ configured: boolean; provider?: string; model?: string }>('/api/ai/mimo/status'),
  mimoChat: (body: {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    model?: string;
    max_completion_tokens?: number;
    temperature?: number;
    top_p?: number;
  }) =>
    requestWithTimeout<{ text: string; model?: string; provider?: string; usage?: unknown; id?: string }>(
      '/api/ai/mimo/chat',
      { method: 'POST', body: JSON.stringify(body) },
      75_000,
      'AI 处理超过 75 秒未返回，已自动停止。请稍后重试，或检查当前模型服务是否拥堵。'
    ),
  /** 腾讯翻译状态 */
  tencentTranslateStatus: () => request<{ configured: boolean }>('/api/translate/tencent/status'),
  /** 腾讯翻译：英文转中文（临时预览） */
  tencentTranslate: (text: string, source = 'en', target = 'zh') =>
    request<{ text: string }>('/api/translate/tencent', {
      method: 'POST',
      body: JSON.stringify({ text, source, target }),
    }),
  collectionAiPrompts: (platformKey = 'amazon') =>
    request<CollectionAiPromptSettings>(
      `/api/ai/prompts?platformKey=${encodeURIComponent(platformKey)}`
    ),
  collectionAiPromptProfiles: (platformKey = 'amazon') =>
    request<CollectionAiPromptProfilesResponse>(
      `/api/ai/prompt-profiles?platformKey=${encodeURIComponent(platformKey)}`
    ),
  updateCollectionAiPrompts: (
    body: Pick<CollectionAiPromptSettings, 'platformKey' | 'prompts'>
  ) =>
    request<{ ok: boolean } & CollectionAiPromptSettings>('/api/ai/prompts', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setActiveCollectionAiPromptProfile: (body: { platformKey: string; activeProfileId: string }) =>
    request<{ ok: boolean } & CollectionAiPromptProfilesResponse>('/api/ai/prompt-profiles/active', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  upsertCollectionAiPromptProfile: (body: {
    platformKey: string;
    profileId?: string;
    name: string;
    prompts: CollectionAiPromptSettings['prompts'];
    setActive?: boolean;
  }) =>
    request<{ ok: boolean; profileId: string } & CollectionAiPromptProfilesResponse>('/api/ai/prompt-profile', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteCollectionAiPromptProfile: (body: { platformKey: string; profileId: string }) =>
    request<{ ok: boolean } & CollectionAiPromptProfilesResponse>('/api/ai/prompt-profile', {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
  exportCollections: (
    format: 'csv' | 'xlsx',
    opts: {
      userId?: number;
      ids: number[];
      includeImages?: boolean;
      /** 服务端：amazon 为亚马逊平铺；其他小写标识走通用扁表（可扩展各平台专用导出） */
      target?: string;
    }
  ) => {
    const params = new URLSearchParams({ format });
    if (opts.userId != null) params.set('userId', String(opts.userId));
    params.set('ids', opts.ids.join(','));
    if (opts.includeImages) params.set('includeImages', '1');
    if (opts.target) params.set('target', opts.target);
    const token = getToken();
    const url = `${API_BASE}/api/collections/export/data?${params}`;
    return fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => {
      if (!r.ok) {
        const text = await r.text();
        let msg = '导出失败';
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      return r.blob();
    });
  },
  exportPreview: (opts: { collectionId: number; exportTypeId: string }) => {
    const q = new URLSearchParams();
    q.set('collectionId', String(opts.collectionId));
    q.set('exportTypeId', String(opts.exportTypeId));
    return request<ExportPreviewResponse>(`/api/export/preview?${q.toString()}`);
  },
  /** 须 POST。带 exportTypeId 时：模板为客户端 `templateWorkbookBase64` 或服务端 `AMAZON_EXPORT_SERVER_TEMPLATE_INDEX` / `AMAZON_EXPORT_SERVER_TEMPLATE_PATH` 空表；亚马逊 target 禁止 Base64。 */
  exportCollectionsPost: (
    format: 'xlsx',
    opts: {
      userId?: number;
      ids: number[];
      includeImages?: boolean;
      target?: string;
      templateWorkbookBase64?: string;
      /** 与本地导出类型 id 一致，用于服务端内置导出类型（builtinExportTemplates.js） */
      exportTypeId: string;
      /** 可选：列映射草稿；未传时服务端可按 exportTypeId 使用已保存草稿 */
      columnMapDraft?: unknown;
    }
  ) => {
    const token = getToken();
    const url = `${API_BASE}/api/collections/export/data`;
    const payload: Record<string, unknown> = {
      format,
      ids: opts.ids,
      includeImages: opts.includeImages ? true : false,
      target: opts.target,
      userId: opts.userId,
      exportTypeId: opts.exportTypeId,
    };
    if (opts.templateWorkbookBase64 != null && String(opts.templateWorkbookBase64).trim() !== '') {
      payload.templateWorkbookBase64 = opts.templateWorkbookBase64;
    }
    if (opts.columnMapDraft != null) {
      payload.columnMapDraft = opts.columnMapDraft;
    }
    const body = JSON.stringify(payload);
    return fetch(url, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body,
    }).then(async (r) => {
      if (!r.ok) {
        const text = await r.text();
        let msg = '导出失败';
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      const blob = await r.blob();
      const mappingMode = r.headers.get('x-export-columnmap-mode') || undefined;
      const mappingVersion = r.headers.get('x-export-columnmap-version') || undefined;
      const headerRow = r.headers.get('x-export-columnmap-headerrow') || undefined;
      const dataStartRow = r.headers.get('x-export-columnmap-datastartrow') || undefined;
      const sheetName = r.headers.get('x-export-columnmap-sheetname') || undefined;
      return { blob, mappingMode, mappingVersion, headerRow, dataStartRow, sheetName } as ExportBlobResponse;
    });
  },
  /** 图片资源管理：仅打包图片 zip（不含表格） */
  downloadCollectionImagesZip: (id: number, opts?: { nobg?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.nobg) params.set('nobg', '1');
    const token = getToken();
    const url = `${API_BASE}/api/collections/${id}/images-zip${params.toString() ? `?${params}` : ''}`;
    return fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => {
      if (!r.ok) {
        const text = await r.text();
        let msg = '下载失败';
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      return r.blob();
    });
  },
  adminUsers: () => request<AdminUser[]>('/api/admin/users'),
  adminUser: (id: number) =>
    request<AdminUser & { ruleIds: number[] }>(`/api/admin/users/${id}`),
  createUser: (body: Record<string, unknown>) =>
    request<{ id: number }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteUser: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  /** 个人中心：个人信息/授权/模板/剩余次数 */
  accountOverview: () =>
    request<{
      user: UserInfo;
      credits: AccountCredits;
      planCatalog?: PlanCatalogItem[];
      authorizedRules: RuleSummary[];
      myExportTemplates: MyExportTemplateSummary[];
    }>('/api/account/overview'),
  /** 个人中心：设置采集默认导出目标平台（影响采集入库时 exportDestPlatformId） */
  setMyDefaultExportPlatform: (body: { defaultExportPlatformId: string }) =>
    request<{ ok: boolean; defaultExportPlatformId: string }>('/api/account/default-export-platform', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  changeMyPassword: (body: { oldPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminRules: () => request<RuleSummary[]>('/api/admin/rules'),
  adminRule: (id: number) => request<RuleDetail>(`/api/admin/rules/${id}`),
  createRule: (body: Record<string, unknown>) =>
    request<{ id: number }>('/api/admin/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRule: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/admin/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteRule: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/rules/${id}`, { method: 'DELETE' }),
  /** 登录即可：服务端维护的导出目标平台（名称 + 内部 id，用于导出类型与 exportDestPlatformId） */
  exportPlatforms: () =>
    request<{ platforms: ExportDestPlatform[] }>('/api/export/platforms'),
  /** 服务端内置导出类型（builtinExportTemplates.js） */
  exportTypes: (opts?: { hidePublic?: boolean }) =>
    request<{ types: ServerExportTypeRow[] }>(
      `/api/export/types${opts?.hidePublic ? `?hidePublic=1` : ''}`
    ),
  /** 读取服务端持久化的列映射草稿（任意登录用户）；无则 draft 为 null */
  getExportColumnMapDraft: (exportTypeId: string) =>
    request<{ draft: unknown | null }>(
      `/api/export/column-map-draft?exportTypeId=${encodeURIComponent(exportTypeId)}`
    ),
  /** 管理员：写入列映射草稿到服务器（app_settings） */
  putExportColumnMapDraft: (body: { exportTypeId: string; draft: unknown }) =>
    request<{ ok: boolean }>('/api/export/column-map-draft', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** 管理员：导出平台目录 + UUID → 处理模板键映射 */
  adminExportPlatformSettings: () =>
    request<{
      map: Record<string, string>;
      defaultExportPlatformId: string;
      platforms: ExportDestPlatform[];
    }>('/api/admin/export-platform-settings'),
  putAdminExportPlatformSettings: (body: {
    map: Record<string, string>;
    defaultExportPlatformId?: string;
  }) =>
    request<{ ok: boolean }>('/api/admin/export-platform-settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** 管理员/授权模块：上传空模板（自定义表头） */
  adminCreateExportTemplate: (form: FormData) =>
    postFormData<{
      ok: boolean;
      template: {
        id: string;
        name: string;
        exportTypeId: string;
        destPlatformId: string;
        sheetName: string;
        headerRow: number;
        dataStartRow: number;
        headers: string[];
        originalFilename: string;
        createdByUserId?: number | null;
        isPublic?: number;
        createdAt: string;
      };
    }>('/api/admin/export-templates', form),
  adminExportTemplates: (opts?: { hidePublic?: boolean }) =>
    request<{
      templates: Array<{
        id: string;
        name: string;
        exportTypeId: string;
        destPlatformId: string;
        originalFilename: string;
        sheetName: string;
        headerRow: number;
        dataStartRow: number;
        createdByUserId?: number | null;
        isPublic?: number;
        createdAt: string;
        updatedAt: string;
      }>;
    }>(`/api/admin/export-templates${opts?.hidePublic ? `?hidePublic=1` : ''}`),
  adminExportTemplate: (id: string) =>
    request<{
      template: {
        id: string;
        name: string;
        exportTypeId: string;
        destPlatformId: string;
        originalFilename: string;
        sheetName: string;
        headerRow: number;
        dataStartRow: number;
        headers: string[];
        createdByUserId?: number | null;
        isPublic?: number;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/api/admin/export-templates/${encodeURIComponent(id)}`),
  deleteAdminExportTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/export-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  patchAdminExportTemplateVisibility: (id: string, body: { isPublic: boolean | number }) =>
    request<{ ok: boolean; isPublic: number; updatedAt: string }>(
      `/api/admin/export-templates/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      }
    ),
  renameAdminExportTemplate: (id: string, body: { name: string }) =>
    request<{ ok: boolean; updatedAt: string }>(`/api/admin/export-templates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** 复制公开模板为当前用户私有模板 */
  adminCopyExportTemplate: (id: string) =>
    request<{
      ok: boolean;
      template: {
        id: string;
        name: string;
        exportTypeId: string;
        destPlatformId: string;
        sheetName: string;
        headerRow: number;
        dataStartRow: number;
        headers: string[];
        originalFilename: string;
        createdByUserId?: number | null;
        isPublic?: number;
        createdAt: string;
      };
    }>(`/api/admin/export-templates/${encodeURIComponent(id)}/copy`, { method: 'POST' }),
};

export type UserInfo = {
  id: number;
  username: string;
  role: 'user' | 'admin';
  validFrom: string | null;
  validTo: string | null;
  /** 非管理员由管理员勾选授权；管理员拥有全部模块 */
  allowedModules: string[];
  planId?: string;
  /** 采集默认导出目标平台（UUID；空字符串表示未设置） */
  defaultExportPlatformId?: string;
};

export type AdminUser = UserInfo & {
  createdAt: string;
  nobgCredits: number;
  aiEraseCredits: number;
  imageGenCredits: number;
  planId?: string;
};

export type AccountCredits = {
  nobgCredits: number;
  aiEraseCredits: number;
  imageGenCredits: number;
};

export type PlanCatalogItem = {
  id: string;
  name: string;
  priceCny: number;
  perMonth: { nobg: number; erase: number; imageGen: number };
};

export type MyExportTemplateSummary = {
  id: string;
  name: string;
  exportTypeId: string;
  destPlatformId: string;
  originalFilename: string;
  createdByUserId: number | null;
  isPublic: number;
  createdAt: string;
  updatedAt: string;
};

/** 与后端 MODULE_IDS 一致，用于用户权限勾选与前端路由 */
export const APP_MODULE_IDS = [
  'collections',
  'images',
  'rules',
  'export-mapping',
] as const;

export type AppModuleId = (typeof APP_MODULE_IDS)[number];

export function modulePath(mod: string): string {
  return `/${mod}`;
}

export function canAccessModule(user: UserInfo, mod: string): boolean {
  if (user.role === 'admin') return true;
  return Array.isArray(user.allowedModules) && user.allowedModules.includes(mod);
}

export function homePathForUser(user: UserInfo): string {
  if (user.role === 'admin') return '/collections';
  if (!Array.isArray(user.allowedModules) || user.allowedModules.length === 0) {
    return '/no-access';
  }
  const order = APP_MODULE_IDS;
  for (const m of order) {
    if (user.allowedModules.includes(m)) return modulePath(m);
  }
  return '/no-access';
}

export type RuleSummary = {
  id: number;
  name: string;
  platform: string;
  description: string;
  updatedAt: string;
};

export type RuleConfig = {
  version?: string;
  rules: unknown[];
  pre_click_xpath?: string;
  /** 多步页面预处理：按顺序执行（当前仅支持 XPath click），兼容旧字段 pre_click_xpath */
  pre_click_xpaths?: string[];
};

export type RuleDetail = {
  id: number;
  name: string;
  platform: string;
  description: string;
  config: RuleConfig;
};

/** storageRole：实际磁盘目录；role：逻辑槽位（替换接口仍用 main/gallery + index） */
export type ImageManifestItem = {
  role: 'main' | 'gallery' | 'detail';
  index: number;
  filename: string;
  storageRole: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg';
  /** 服务端生成的公网完整地址（PUBLIC_ORIGIN + 可选 exp/sig，与导出表格一致） */
  publicUrl?: string;
};

export type ImageCollectionRow = {
  collectionId: number;
  collectedAt: string;
  platform: string;
  url: string;
  username: string | null;
  title: string;
  /** 与采集列表/编辑窗口一致：export/pending/discard；未标记为 null */
  userMark?: CollectionUserMark | null;
  imagesStatus: string;
  imagesError: string | null;
  imagesNobgStatus?: string | null;
  /** 服务端异步 AI 后处理状态：pending 时编辑窗口会禁用部分操作 */
  aiPostStatus?: 'pending' | 'done' | 'skipped' | 'failed' | null;
  /** 插件上报：local=磁盘 / oss=对象存储；null 为旧数据或与 OSS_ENABLED 一致 */
  imagesStorage?: 'local' | 'oss' | null;
  /**
   * 与采集编辑窗口一致：按颜色下标控制是否参与导出；用于在图片资源管理中将未勾选颜色对应的主图置灰并禁用编辑入口。
   * 若无法判定颜色数或旧数据未包含该信息，则为 null/undefined。
   */
  colorExportChecked?: boolean[] | null;
  images: ImageManifestItem[];
  /** 详情图（仅展示，不参与导出） */
  detailImages?: string[];
};

export type ImagesListResponse = {
  page: number;
  limit: number;
  total: number;
  rows: ImageCollectionRow[];
};

/** 后端受保护接口路径（需 Authorization）；与 VITE_API_BASE 拼接即为浏览器可访问的本站图片 URL */
export function collectionImageApiPath(
  collectionId: number,
  role: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg',
  filename: string
): string {
  return `/api/collections/${collectionId}/image/${role}/${encodeURIComponent(filename)}`;
}

/** 展示用绝对地址（部署在子域或同域时需正确配置 VITE_API_BASE） */
export function absoluteApiUrl(apiPath: string): string {
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const b = (API_BASE || '').replace(/\/$/, '');
  if (b.startsWith('http')) return `${b}${p}`;
  if (typeof window !== 'undefined') return `${window.location.origin}${b}${p}`;
  return p;
}

export type CollectionList = {
  page: number;
  limit: number;
  total: number;
  /** 当前用户/筛选条件下出现过的采集平台（用于列表筛选下拉，不受 platform 查询参数过滤） */
  platforms?: string[];
  rows: {
    id: number;
    collectedAt: string;
    platform: string;
    url: string;
    userId: number;
    username: string | null;
    /** 父SKU（服务端列：collections.amazon_parent_sku），用于导出与快速检索 */
    amazonParentSku?: string | null;
    /** 用户标记：导出 / 待定 / 丢弃；未设置时为 null */
    userMark?: CollectionUserMark | null;
    /** 已导出时有值（ISO 时间），未导出为 null */
    exportedAt: string | null;
    archivedAt?: string | null;
    isArchived?: boolean;
    /** 图片下载状态：pending/done/failed（旧数据可能为 pending） */
    imagesStatus?: 'pending' | 'done' | 'failed';
    imagesDownloadedAt?: string | null;
    imagesError?: string | null;
    /** 去背景：pending/done/failed，未处理过为 null */
    imagesNobgStatus?: 'pending' | 'done' | 'failed' | null;
    imagesNobgAt?: string | null;
    imagesNobgError?: string | null;
    /** 图片落库：local | oss；null 为旧数据 */
    imagesStorage?: 'local' | 'oss' | null;
    /** 上报后服务端异步 MiMo：pending 时前台禁用编辑入口；null 为旧数据，视为已完成 */
    aiPostStatus?: 'pending' | 'done' | 'skipped' | 'failed' | null;
    /** 数据格式：导出目标平台内部 id（UUID）；空/undefined 表示未设置 */
    exportDestPlatformId?: string | null;
    /** 采集入库自动处理当时使用的提示词类别（用于追溯；无/旧数据为 null） */
    aiPromptProfileId?: string | null;
    aiPromptProfileName?: string | null;
    aiPromptPlatformKey?: string | null;
    aiPromptProfileSetAt?: string | null;
    /**
     * 同账号全库：是否存在更早一条采集（按 collected_at、id）且 url（trim 后）相同。
     * 不同用户相同地址不为 true。
     */
    urlDuplicate?: boolean;
  }[];
};

export type ImagesManifest = {
  mainFiles?: string[];
  galleryFiles?: string[];
  detailFiles?: string[];
  mainFilesNobg?: string[];
  galleryFilesNobg?: string[];
};

export type CollectionDetail = {
  id: number;
  collectedAt: string;
  platform: string;
  url: string;
  userId: number;
  username: string | null;
  imagesStatus?: 'pending' | 'done' | 'failed' | null;
  imagesDownloadedAt?: string | null;
  imagesError?: string | null;
  imagesManifest?: ImagesManifest | null;
  /** 与图片资源管理「复制」一致：服务端生成的详情图公网 URL（可能带 exp/sig），长度与 imagesManifest.detailFiles 对齐 */
  detailImagePublicUrls?: string[];
  imagesNobgStatus?: 'pending' | 'done' | 'failed' | null;
  imagesNobgAt?: string | null;
  imagesNobgError?: string | null;
  /** 图片落库：local=服务器磁盘 / oss=对象存储；null 为旧数据或未区分 */
  imagesStorage?: 'local' | 'oss' | null;
  /** 上报后服务端异步 MiMo：pending 时前台可遮罩；null 为旧数据，视为已完成 */
  aiPostStatus?: 'pending' | 'done' | 'skipped' | 'failed' | null;
  /** 数据格式：导出目标平台内部 id（UUID）；空/undefined 表示未设置 */
  exportDestPlatformId?: string | null;
  /** 采集入库自动处理当时使用的提示词类别（用于追溯） */
  aiPromptProfileId?: string | null;
  aiPromptProfileName?: string | null;
  aiPromptPlatformKey?: string | null;
  aiPromptProfileSetAt?: string | null;
  /** 与列表「标记」列一致；未设置时为 null */
  userMark?: CollectionUserMark | null;
  /** 平台数据：默认亚马逊二次加工；保存后为编辑结果；亚马逊导出基于此 */
  data: Record<string, unknown>;
  /** 通用数据：插件清洗后原始结构；非亚马逊导出时在服务端由此二次加工 */
  genericData?: Record<string, unknown>;
};
