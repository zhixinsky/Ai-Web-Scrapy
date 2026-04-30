import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  collectionEventsUrl,
  downloadCollectionExtensionZip,
  type CollectionAiPromptSettings,
  type CollectionAiPromptProfilesResponse,
  type CollectionMarkFilter,
  type CollectionUserMark,
  type ExportDestPlatform,
  type UserInfo,
} from '../api';
import { formatCstDateOnly, formatCstDisplay } from '../utils/timeCst';
import {
  tableActionCopyClass,
  tableActionDeleteClass,
  tableActionEditClass,
  tableActionExpandedClass,
  tableActionExportClass,
  tableActionRowWrapClass,
} from '../ui/tableActionClasses';
import CollectionDetailEditor from '../components/CollectionDetailEditor';
import CollectionExportModal from '../components/CollectionExportModal';
import { CustomSelect } from '../components/CustomSelect';
import { PlatformGlyph, platformImageSrcForName } from '../components/PlatformGlyph';
import { pushToast, toastError, toastSuccess } from '../utils/toast';

/** 估算每行高度（px），略保守以减少「末行被裁切」感；与 ResizeObserver 一起决定每页条数 */
const COLLECTIONS_ROW_EST_PX = 58;
const COLLECTIONS_THEAD_FALLBACK_PX = 48;
/** 服务端 /api/collections 单页最大 limit */
const COLLECTIONS_LIMIT_MAX = 200;
const EDIT_MODAL_FRAME_INSET_PX = 12;
/** 临时关闭采集列表搜索入口；后端搜索接口保留，后续需要时改回 true 即可恢复。 */
const COLLECTION_SEARCH_UI_ENABLED = true;

const USER_MARK_OPTIONS: readonly { value: CollectionUserMark; label: string; dotClass: string }[] =
  [
    { value: 'export', label: '导出', dotClass: 'bg-emerald-500' },
    { value: 'pending', label: '待定', dotClass: 'bg-amber-500' },
    { value: 'discard', label: '丢弃', dotClass: 'bg-red-500' },
  ];

function markBorderClass(mark: string | null | undefined): string {
  const m = String(mark || '').trim().toLowerCase();
  if (m === 'export') return 'border-emerald-200 hover:border-emerald-300';
  if (m === 'pending') return 'border-amber-200 hover:border-amber-300';
  if (m === 'discard') return 'border-red-200 hover:border-red-300';
  return 'border-slate-200 hover:border-slate-300';
}

/** 顶部「标记筛选」下拉选项（与列表请求 mark 参数一致） */
const MARK_FILTER_OPTIONS: readonly { value: CollectionMarkFilter; label: string }[] = [
  { value: '', label: '全部标记' },
  { value: 'export', label: '导出' },
  { value: 'pending', label: '待定' },
  { value: 'discard', label: '丢弃' },
  { value: 'unmarked', label: '未标记' },
];

/** 本页「快选平台」下拉：刷新 / 切模块后仍保留所选平台（sessionStorage） */
function pagePlatformFilterStorageKey(mode: 'active' | 'archived'): string {
  return `admin:collections:${mode}:pagePlatformFilter`;
}

function pageSearchStorageKey(mode: 'active' | 'archived'): string {
  return `admin:collections:${mode}:search`;
}

function lastSearchStorageKey(mode: 'active' | 'archived'): string {
  return `admin:collections:${mode}:lastSearch`;
}

function readStoredPagePlatformFilter(mode: 'active' | 'archived'): string {
  try {
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(pagePlatformFilterStorageKey(mode)) || '';
  } catch {
    return '';
  }
}

function persistPagePlatformFilter(mode: 'active' | 'archived', p: string) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const t = String(p || '').trim();
    if (t) sessionStorage.setItem(pagePlatformFilterStorageKey(mode), t);
    else sessionStorage.removeItem(pagePlatformFilterStorageKey(mode));
  } catch {
    /* ignore */
  }
}

function readStoredSearchText(mode: 'active' | 'archived'): string {
  try {
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(pageSearchStorageKey(mode)) || '';
  } catch {
    return '';
  }
}

function persistSearchText(mode: 'active' | 'archived', value: string) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const t = String(value || '').trim();
    if (t) sessionStorage.setItem(pageSearchStorageKey(mode), t);
    else sessionStorage.removeItem(pageSearchStorageKey(mode));
  } catch {
    /* ignore */
  }
}

function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function IconChevronUp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832l-3.71 3.94a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function platformIconOnly(name: string) {
  const src = platformImageSrcForName(name);
  if (!src) return null;
  return <img src={src} alt={name} className="h-6 w-20 object-contain" loading="lazy" />;
}

function ExportStatusBadge({ exportedAt }: { exportedAt: string | null }) {
  if (exportedAt) {
    return (
      <span
        className="inline-flex items-center gap-1 text-emerald-600"
        title={`已导出 ${formatCstDisplay(exportedAt)}`}
      >
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-xs font-medium">已导出</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-red-500" title="尚未导出过">
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
      <span className="text-xs font-medium">未导出</span>
    </span>
  );
}

const iconCheckCircle = (
  <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
      clipRule="evenodd"
    />
  </svg>
);

const iconXCircle = (
  <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
      clipRule="evenodd"
    />
  </svg>
);

function ImageDownloadBadge({
  status,
  downloadedAt,
  error,
}: {
  status: string | null | undefined;
  downloadedAt: string | null | undefined;
  error: string | null | undefined;
}) {
  const s = String(status || 'pending');
  if (s === 'done') {
    return (
      <span
        className="inline-flex items-center gap-1 text-emerald-600"
        title={downloadedAt ? `已下载 ${downloadedAt}` : '已下载'}
      >
        {iconCheckCircle}
        <span className="text-xs font-medium">已下载</span>
      </span>
    );
  }
  const tip = error ? `未完成：${error}` : '未完成';
  return (
    <span className="inline-flex items-center gap-1 text-red-500" title={tip}>
      {iconXCircle}
      <span className="text-xs font-medium">未完成</span>
    </span>
  );
}

/** 与 ImageDownloadBadge 视觉一致：完成=翠绿勾选；未完成/失败/处理中=红叉「未完成」 */
function NobgStatusBadge({
  status,
  doneAt,
  error,
}: {
  status: string | null | undefined;
  doneAt: string | null | undefined;
  error: string | null | undefined;
}) {
  const s = String(status || '');
  if (s === 'done') {
    return (
      <span
        className="inline-flex items-center gap-1 text-emerald-600"
        title={doneAt ? `已去背景 ${doneAt}` : '已去背景'}
      >
        {iconCheckCircle}
        <span className="text-xs font-medium">已去背景</span>
      </span>
    );
  }
  let tip = '未完成';
  if (s === 'failed' && error) tip = `未完成：${error}`;
  else if (s === 'pending') tip = '未完成：处理中…';
  return (
    <span className="inline-flex items-center gap-1 text-red-500" title={tip}>
      {iconXCircle}
      <span className="text-xs font-medium">未完成</span>
    </span>
  );
}

export default function CollectionsPage({
  user,
  mode = 'active',
}: {
  user: UserInfo;
  mode?: 'active' | 'archived';
}) {
  const isArchivedMode = mode === 'archived';
  const [searchParams, setSearchParams] = useSearchParams();
  const didInitFromUrlRef = useRef(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.collections>> | null>(null);
  const [page, setPage] = useState(1);
  /** 按列表可视区域高度计算，随窗口变化；与底部分页独立，避免「大块留白」 */
  const [pageLimit, setPageLimit] = useState(12);
  const tableScrollViewportRef = useRef<HTMLDivElement>(null);
  const [userIdFilter, setUserIdFilter] = useState<number | ''>('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.collection>> | null>(null);
  const [users, setUsers] = useState<{ id: number; username: string }[]>([]);
  const [err, setErr] = useState('');
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [deleteModal, setDeleteModal] = useState<{ ids: number[] } | null>(null);
  const [deleteAlsoImages, setDeleteAlsoImages] = useState(false);
  /**
   * 勾选：ids 跨页保留；platformById 在勾选时写入，供底部摘要显示「含几种采集平台」
   * （仅用当前页 data.rows 无法看到其它页已选行的 platform）。
   */
  const [sel, setSel] = useState<{
    ids: number[];
    platformById: Record<number, string>;
  }>({ ids: [], platformById: {} });
  /** 列表「采集平台」筛选（服务端 WHERE）；与 URL + sessionStorage 同步，刷新/切模块不丢 */
  const [pagePlatformFilter, setPagePlatformFilter] = useState<string>(() => readStoredPagePlatformFilter(mode));
  const [searchInput, setSearchInput] = useState<string>(() =>
    COLLECTION_SEARCH_UI_ENABLED ? readStoredSearchText(mode) : ''
  );
  const [searchText, setSearchText] = useState<string>(() =>
    COLLECTION_SEARCH_UI_ENABLED ? readStoredSearchText(mode) : ''
  );

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalIds, setExportModalIds] = useState<number[]>([]);
  const [genericModal, setGenericModal] = useState<{ collectionId: number; text: string } | null>(null);
  const [genericLoadingId, setGenericLoadingId] = useState<number | null>(null);
  /** 与右侧透明磨砂主框边界一致，用于编辑弹窗宽度与首屏高度 */
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutBounds, setLayoutBounds] = useState<{ width: number; top: number; height: number } | null>(null);
  const [markFilter, setMarkFilter] = useState<CollectionMarkFilter>('');
  const [markSavingId, setMarkSavingId] = useState<number | null>(null);
  const [archivingSelected, setArchivingSelected] = useState(false);
  const [restoringSelected, setRestoringSelected] = useState(false);
  const [pluginZipDownloading, setPluginZipDownloading] = useState(false);
  const [aiPromptModalOpen, setAiPromptModalOpen] = useState(false);
  const [aiPromptProfiles, setAiPromptProfiles] = useState<CollectionAiPromptProfilesResponse | null>(null);
  const [aiPromptDraft, setAiPromptDraft] = useState<CollectionAiPromptSettings['prompts'] | null>(null);
  const [aiPromptNewProfileName, setAiPromptNewProfileName] = useState('');
  const [aiPromptLoading, setAiPromptLoading] = useState(false);
  const [aiPromptSaving, setAiPromptSaving] = useState(false);
  const [aiPromptDeleteConfirmId, setAiPromptDeleteConfirmId] = useState<string | null>(null);
  const [aiPromptPlatformKey, setAiPromptPlatformKey] = useState<string>('amazon');
  const [exportPlatforms, setExportPlatforms] = useState<ExportDestPlatform[]>([]);
  const [formatSavingId, setFormatSavingId] = useState<number | null>(null);

  // 刷新/分享链接时保留筛选：从 URL 读取初始 page/userId/mark
  useEffect(() => {
    if (didInitFromUrlRef.current) return;
    didInitFromUrlRef.current = true;

    const sp0 = searchParams;
    let sp = sp0;

    // 侧边栏切换模块时通常只跳裸路径（不带 ?），导致筛选回默认；
    // 若当前 URL 没带任何筛选参数，则从 sessionStorage 恢复上一次的查询参数，并立刻用于初始化 state。
    try {
      const hasAny = Boolean(
        sp0.get('page') || sp0.get('userId') || sp0.get('mark') || sp0.get('platform') || sp0.get('q')
      );
      if (!hasAny && typeof sessionStorage !== 'undefined') {
        const raw = sessionStorage.getItem(lastSearchStorageKey(mode)) || '';
        if (raw.trim()) {
          sp = new URLSearchParams(raw);
          setSearchParams(sp, { replace: true });
        }
      }
    } catch {
      /* ignore */
    }

    const pageRaw = sp.get('page');
    const userIdRaw = sp.get('userId');
    const markRaw = sp.get('mark');
    const qRaw = COLLECTION_SEARCH_UI_ENABLED ? String(sp.get('q') || '').trim() : '';

    const p = Number(pageRaw || '');
    if (Number.isFinite(p) && p >= 1) setPage(Math.floor(p));

    if (user.role === 'admin') {
      const uid = Number(userIdRaw || '');
      if (Number.isFinite(uid) && uid > 0) setUserIdFilter(Math.floor(uid));
    }

    const mk = String(markRaw || '').trim() as CollectionMarkFilter;
    if (mk === '' || mk === 'export' || mk === 'pending' || mk === 'discard' || mk === 'unmarked') {
      setMarkFilter(mk);
    }
    if (COLLECTION_SEARCH_UI_ENABLED) {
      setSearchInput(qRaw);
      setSearchText(qRaw);
      persistSearchText(mode, qRaw);
    } else {
      setSearchInput('');
      setSearchText('');
      persistSearchText(mode, '');
    }

    const platformFromUrl = String(sp.get('platform') || '').trim();
    if (platformFromUrl) {
      setPagePlatformFilter(platformFromUrl);
      persistPagePlatformFilter(mode, platformFromUrl);
    } else {
      try {
        if (typeof sessionStorage !== 'undefined') {
          const st = sessionStorage.getItem(pagePlatformFilterStorageKey(mode)) || '';
          if (st.trim()) {
            setPagePlatformFilter(st.trim());
          }
        }
      } catch {
        /* ignore */
      }
    }
  }, [mode, searchParams, setSearchParams, user.role]);

  // 筛选变化时同步 URL（刷新不丢）
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('page', String(page));
    if (user.role === 'admin' && userIdFilter !== '') next.set('userId', String(userIdFilter));
    if (markFilter) next.set('mark', String(markFilter));
    const pf = pagePlatformFilter.trim();
    if (pf) next.set('platform', pf);
    const qText = COLLECTION_SEARCH_UI_ENABLED ? searchText.trim() : '';
    if (qText) next.set('q', qText);
    setSearchParams(next, { replace: true });

    persistPagePlatformFilter(mode, pagePlatformFilter);
    persistSearchText(mode, COLLECTION_SEARCH_UI_ENABLED ? searchText : '');

    // 同步写入 sessionStorage：用于“切换模块 → 返回本页”恢复筛选
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(lastSearchStorageKey(mode), next.toString());
      }
    } catch {
      /* ignore */
    }
  }, [mode, page, user.role, userIdFilter, markFilter, pagePlatformFilter, searchText, setSearchParams]);

  const load = useCallback(async () => {
    setErr('');
    const q = new URLSearchParams({ page: String(page), limit: String(pageLimit) });
    q.set('archived', isArchivedMode ? '1' : '0');
    if (user.role === 'admin' && userIdFilter !== '') q.set('userId', String(userIdFilter));
    if (markFilter) q.set('mark', markFilter);
    const pf = pagePlatformFilter.trim();
    if (pf) q.set('platform', pf);
    const search = COLLECTION_SEARCH_UI_ENABLED ? searchText.trim() : '';
    if (search) q.set('q', search);
    try {
      const res = await api.collections(q.toString());
      setData(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    }
  }, [isArchivedMode, markFilter, page, pageLimit, pagePlatformFilter, searchText, user.role, userIdFilter]);

  const measurePageLimit = useCallback(() => {
    const el = tableScrollViewportRef.current;
    if (!el) return;
    const h = el.clientHeight;
    if (h < 56) return;
    const thead = el.querySelector('table thead');
    const theadH =
      thead instanceof HTMLElement ? thead.offsetHeight : COLLECTIONS_THEAD_FALLBACK_PX;
    const available = Math.max(0, h - theadH);
    const raw = Math.floor(available / COLLECTIONS_ROW_EST_PX);
    const next = Math.min(COLLECTIONS_LIMIT_MAX, Math.max(3, raw));
    setPageLimit((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    measurePageLimit();
    const el = tableScrollViewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measurePageLimit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measurePageLimit]);

  useEffect(() => {
    if (!data?.total) return;
    const maxPage = Math.max(1, Math.ceil(data.total / pageLimit));
    if (page > maxPage) setPage(maxPage);
  }, [data?.total, page, pageLimit]);

  useEffect(() => {
    load();
  }, [load]);

  useLayoutEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const sync = () => {
      const frostedFrame = el.closest('.app-page-enter');
      const frameRect = (frostedFrame instanceof HTMLElement ? frostedFrame : el).getBoundingClientRect();
      const contentRect = el.getBoundingClientRect();
      const frameInnerHeight = Math.max(160, Math.round(frameRect.height) - EDIT_MODAL_FRAME_INSET_PX * 2);
      const next = {
        width: Math.round(contentRect.width),
        top: EDIT_MODAL_FRAME_INSET_PX,
        height: frameInnerHeight,
      };
      setLayoutBounds((prev) =>
        prev && prev.width === next.width && prev.top === next.top && prev.height === next.height ? prev : next
      );
    };
    sync();
    const raf = window.requestAnimationFrame(sync);
    const animationSettledTimer = window.setTimeout(sync, 460);
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const frostedFrame = el.closest('.app-page-enter');
    if (frostedFrame instanceof HTMLElement) ro.observe(frostedFrame);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      window.clearTimeout(animationSettledTimer);
      window.removeEventListener('resize', sync);
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [isArchivedMode, markFilter, searchText]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const url = collectionEventsUrl();
    if (!url) return;

    let closed = false;
    let debounceTimer: number | null = null;
    const refreshSoon = () => {
      if (closed) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 250);
    };

    const es = new EventSource(url);
    es.addEventListener('collections-changed', refreshSoon);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshSoon);

    return () => {
      closed = true;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      es.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshSoon);
    };
  }, [load]);

  useEffect(() => {
    setSel({ ids: [], platformById: {} });
  }, [userIdFilter]);

  const platformQuickSelectOptions = useMemo(() => {
    const fromApi = Array.isArray(data?.platforms) ? data.platforms : [];
    const set = new Set<string>(fromApi.map((p) => String(p || '').trim()).filter(Boolean));
    const cur = pagePlatformFilter.trim();
    if (cur && !set.has(cur)) set.add(cur);
    const sorted = [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return [
      {
        value: '',
        label: '全部平台',
        icon: null,
        iconOnly: false,
      },
      ...sorted.map((pl) => ({
        value: pl,
        label: pl,
        icon: platformIconOnly(pl),
        iconOnly: true,
      })),
    ];
  }, [data?.platforms, pagePlatformFilter]);

  useEffect(() => {
    if (user.role !== 'admin') return;
    api
      .adminUsers()
      .then((list) => setUsers(list.map((u) => ({ id: u.id, username: u.username }))))
      .catch(() => {});
  }, [user.role]);

  useEffect(() => {
    api
      .exportPlatforms()
      .then((r) => setExportPlatforms(Array.isArray(r.platforms) ? r.platforms : []))
      .catch(() => setExportPlatforms([]));
  }, []);

  useEffect(() => {
    if (detailId == null) {
      setDetail(null);
      return;
    }
    api
      .collection(detailId)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [detailId]);

  function toggleRowSelect(id: number, platform: string) {
    const p = String(platform || '').trim();
    setSel((prev) => {
      if (prev.ids.includes(id)) {
        const ids = prev.ids.filter((x) => x !== id);
        const { [id]: _removed, ...platformById } = prev.platformById;
        queueMicrotask(() => setErr(''));
        return { ids, platformById };
      }
      queueMicrotask(() => setErr(''));
      return {
        ids: [...prev.ids, id],
        platformById: { ...prev.platformById, [id]: p },
      };
    });
  }

  async function openGenericDataModal(collectionId: number) {
    setGenericLoadingId(collectionId);
    setErr('');
    try {
      const d = await api.collection(collectionId);
      const text = JSON.stringify(d.genericData ?? {}, null, 2);
      setGenericModal({ collectionId, text });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载插件数据失败');
    } finally {
      setGenericLoadingId(null);
    }
  }

  async function copyCollectionUrl(url: string) {
    const u = String(url || '').trim();
    if (!u) return;
    try {
      await navigator.clipboard.writeText(u);
      setErr('');
      toastSuccess('采集地址已复制到剪贴板', '复制成功');
    } catch {
      setErr('复制失败');
    }
  }

  async function setRowUserMark(id: number, value: string) {
    setMarkSavingId(id);
    setErr('');
    try {
      const mark: CollectionUserMark | null =
        value === '' ? null : (value as CollectionUserMark);
      await api.setCollectionMark(id, mark);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存标记失败');
    } finally {
      setMarkSavingId(null);
    }
  }

  async function setRowDataFormat(id: number, nextPlatformId: string) {
    setFormatSavingId(id);
    setErr('');
    try {
      await api.setCollectionExportDestPlatform(id, nextPlatformId);
      toastSuccess('已切换数据格式，AI 将按新规则重新处理', '已入队');
      // 依赖 SSE 刷新列表；这里再主动刷新一次避免用户等待
      await load();
      if (detailId === id) {
        try {
          const d = await api.collection(id);
          setDetail(d);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '切换失败');
    } finally {
      setFormatSavingId(null);
    }
  }

  function openExportModal(ids: number[]) {
    if (ids.length === 0) {
      setErr('请先勾选要导出的记录');
      return;
    }
    setErr('');
    setExportModalIds(ids);
    setExportModalOpen(true);
  }

  async function remove(id: number) {
    setDeleteAlsoImages(true);
    setDeleteModal({ ids: [id] });
  }

  async function removeSelected() {
    if (sel.ids.length === 0) return;
    setDeleteAlsoImages(true);
    setDeleteModal({ ids: [...sel.ids] });
  }

  async function confirmDelete() {
    if (!deleteModal || deleteModal.ids.length === 0) return;
    setErr('');
    setDeletingSelected(true);
    try {
      for (const id of deleteModal.ids) {
        await api.deleteCollection(id, { deleteImages: deleteAlsoImages });
      }
      if (detailId != null && deleteModal.ids.includes(detailId)) {
        setDetailId(null);
        setDetail(null);
      }
      if (deleteModal.ids.length > 1) {
        setSel({ ids: [], platformById: {} });
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : deleteModal.ids.length > 1 ? '批量删除失败' : '删除失败');
    } finally {
      setDeletingSelected(false);
      setDeleteModal(null);
    }
  }

  async function archiveSelected() {
    if (sel.ids.length === 0) return;
    setErr('');
    setArchivingSelected(true);
    try {
      await api.archiveCollections(sel.ids);
      setSel({ ids: [], platformById: {} });
      if (detailId != null && sel.ids.includes(detailId)) {
        setDetailId(null);
        setDetail(null);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '移动到归档库失败');
    } finally {
      setArchivingSelected(false);
    }
  }

  async function restoreSelected() {
    if (sel.ids.length === 0) return;
    setErr('');
    setRestoringSelected(true);
    try {
      await api.restoreCollections(sel.ids);
      setSel({ ids: [], platformById: {} });
      if (detailId != null && sel.ids.includes(detailId)) {
        setDetailId(null);
        setDetail(null);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setRestoringSelected(false);
    }
  }

  async function restoreOne(id: number) {
    setErr('');
    setRestoringSelected(true);
    try {
      await api.restoreCollections([id]);
      if (detailId === id) {
        setDetailId(null);
        setDetail(null);
      }
      setSel((prev) => ({
        ids: prev.ids.filter((x) => x !== id),
        platformById: Object.fromEntries(Object.entries(prev.platformById).filter(([k]) => Number(k) !== id)),
      }));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setRestoringSelected(false);
    }
  }

  function toggleDetail(id: number) {
    setDetailId((prev) => (prev === id ? null : id));
  }

  const pageRowIds = (data?.rows || []).map((r) => r.id);
  const allOnPageSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => sel.ids.includes(id));
  const anyOnPageSelected = pageRowIds.some((id) => sel.ids.includes(id));
  const pageTitle = isArchivedMode ? '归档库管理' : '数据采集管理';
  const emptyText = isArchivedMode ? '归档库暂无数据' : '暂无数据';

  function toggleSelectAllOnPage() {
    setSel((prev) => {
      const prevIds = Array.isArray(prev.ids) ? prev.ids : [];
      if (pageRowIds.length === 0) return prev;
      // 再点一次：取消本页全选（仅移除本页 id，保留其它页/其它筛选的勾选）
      if (pageRowIds.every((id) => prevIds.includes(id))) {
        const next = prevIds.filter((id) => !pageRowIds.includes(id));
        const platformById = { ...prev.platformById };
        for (const id of pageRowIds) delete platformById[id];
        return { ...prev, ids: next, platformById };
      }
      // 第一次点：全选本页（追加缺失 id，并写入 platform 供摘要显示）
      const set = new Set(prevIds);
      const platformById = { ...prev.platformById };
      for (const row of data?.rows || []) {
        if (pageRowIds.includes(row.id)) {
          set.add(row.id);
          platformById[row.id] = String(row.platform || '').trim();
        }
      }
      return { ...prev, ids: [...set], platformById };
    });
  }

  const listTable = (
    <table className="w-full min-w-max table-auto border-spacing-0 text-center text-sm">
          <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-600 shadow-sm [&_th]:bg-slate-50 [&_th]:text-center">
            <tr>
              <th
                className="w-14 whitespace-nowrap px-2 py-3 font-medium"
                title={allOnPageSelected ? '取消全选（本页）' : '全选（本页）'}
              >
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-teal-600"
                    checked={allOnPageSelected}
                    onChange={toggleSelectAllOnPage}
                    aria-label={allOnPageSelected ? '取消全选（本页）' : '全选（本页）'}
                    ref={(el) => {
                      if (!el) return;
                      el.indeterminate = anyOnPageSelected && !allOnPageSelected;
                    }}
                  />
                </div>
              </th>
              <th className="w-16 whitespace-nowrap px-2 py-3 font-medium">ID</th>
              <th className="w-[8.5rem] whitespace-nowrap px-2 py-3 font-medium">SKU</th>
              {user.role === 'admin' && <th className="px-4 py-3 font-medium">用户</th>}
              <th className="min-w-[9rem] whitespace-nowrap px-3 py-3 font-medium">标记</th>
              <th className="w-[8.5rem] whitespace-nowrap px-2 py-3 font-medium">采集时间</th>
              <th className="px-3 py-3 font-medium whitespace-nowrap">导出状态</th>
              <th className="px-4 py-3 font-medium">采集平台</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">数据格式</th>
              <th className="w-[7rem] whitespace-nowrap px-2 py-3 font-medium">采集地址</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">图片处理</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">AI提示词</th>
              <th className="px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row) => (
              <tr
                key={row.id}
                className={`app-table-row border-t border-slate-100 ${
                  detailId === row.id ? 'bg-teal-50/80 shadow-[inset_3px_0_0_rgba(13,148,136,0.6)]' : ''
                } ${sel.ids.includes(row.id) ? 'bg-amber-50/60 shadow-[inset_3px_0_0_rgba(245,158,11,0.55)]' : ''}`}
              >
                <td className="px-2 py-3 align-middle">
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-teal-600"
                      checked={sel.ids.includes(row.id)}
                      onChange={() => toggleRowSelect(row.id, row.platform)}
                      aria-label="勾选（批量导出、删除）"
                    />
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-mono text-xs text-slate-700">
                  {row.id}
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-center font-mono text-xs text-slate-700">
                  {String(row.amazonParentSku || '').trim() ? String(row.amazonParentSku).trim() : '—'}
                </td>
                {user.role === 'admin' && (
                  <td className="px-4 py-3 text-slate-700">{row.username || row.userId}</td>
                )}
                <td className="px-3 py-3">
                  <div className="flex items-center justify-center">
                    <CustomSelect
                      value={row.userMark ?? ''}
                      onChange={(v) => void setRowUserMark(row.id, v)}
                      options={[
                        { value: '', label: '未标记', dotClass: 'bg-slate-200' },
                        ...USER_MARK_OPTIONS.map((o) => ({
                          value: o.value,
                          label: o.label,
                          dotClass: o.dotClass,
                        })),
                      ]}
                      disabled={markSavingId === row.id}
                      aria-label="标记"
                      className="!w-[7rem] max-w-[7rem] shrink-0 min-w-0"
                      buttonClassName={`flex h-8 w-full cursor-pointer items-center justify-center gap-1 rounded-full border bg-white/80 px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${markBorderClass(
                        row.userMark
                      )}`}
                    />
                  </div>
                </td>
                <td className="w-[8.5rem] whitespace-nowrap px-2 py-3 text-center text-slate-700">
                  {formatCstDateOnly(row.collectedAt)}
                </td>
                <td className="px-3 py-3">
                  <ExportStatusBadge exportedAt={row.exportedAt ?? null} />
                </td>
                <td className="px-4 py-3">
                  {String(row.platform || '').trim() ? (
                    <div className="flex items-center justify-center text-slate-800" title={row.platform}>
                      <PlatformGlyph name={row.platform} />
                    </div>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center">
                    <CustomSelect
                      value={String(row.exportDestPlatformId || '')}
                      onChange={(v) => void setRowDataFormat(row.id, String(v || ''))}
                      options={[
                        { value: '', label: '未设置', icon: null, iconOnly: true },
                        ...exportPlatforms.map((p) => ({
                          value: p.id,
                          label: p.name,
                            icon: platformIconOnly(p.name),
                          iconOnly: true,
                        })),
                      ]}
                      disabled={formatSavingId === row.id || row.aiPostStatus === 'pending'}
                      aria-label="数据格式（导出目标平台）"
                      className="!w-[6.5rem] max-w-[6.5rem] shrink-0 min-w-0"
                      buttonClassName="flex h-8 w-full cursor-pointer items-center justify-center bg-transparent p-0 shadow-none transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                </td>
                <td className="w-[7rem] px-2 py-3 align-middle">
                  {row.url ? (
                    <div className="mx-auto flex w-[6.25rem] min-w-0 flex-col items-center gap-0.5">
                      <div className="flex h-8 items-center justify-center">
                        <button
                          type="button"
                          className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium shadow-sm ${
                            row.urlDuplicate
                              ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                              : 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                          }`}
                          title={row.urlDuplicate ? '同账号历史曾采过该地址' : undefined}
                          onClick={() => void copyCollectionUrl(row.url)}
                        >
                          复制地址
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center text-slate-400">—</div>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <div className="mx-auto flex w-[5.5rem] flex-col items-start gap-1 pl-3">
                    <ImageDownloadBadge
                      status={row.imagesStatus ?? null}
                      downloadedAt={row.imagesDownloadedAt ? formatCstDisplay(row.imagesDownloadedAt) : null}
                      error={row.imagesError ?? null}
                    />
                    <NobgStatusBadge
                      status={row.imagesNobgStatus ?? null}
                      doneAt={row.imagesNobgAt ? formatCstDisplay(row.imagesNobgAt) : null}
                      error={row.imagesNobgError ?? null}
                    />
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  {row.aiPromptProfileName ? (
                    <span
                      className="inline-flex max-w-[10rem] items-center justify-center truncate rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-900"
                      title={`自动处理提示词类别：${row.aiPromptProfileName}${row.aiPromptProfileSetAt ? `（${formatCstDisplay(row.aiPromptProfileSetAt)}）` : ''}`}
                    >
                      {row.aiPromptProfileName}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400" title="旧数据或未经过自动 AI 处理，未记录提示词类别">
                      未记录
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <div className={tableActionRowWrapClass}>
                    {!isArchivedMode ? (
                    <button
                      type="button"
                      className={detailId === row.id ? tableActionExpandedClass : tableActionEditClass}
                      disabled={row.aiPostStatus === 'pending'}
                      onClick={() => toggleDetail(row.id)}
                      title={
                        row.aiPostStatus === 'pending'
                          ? 'AI处理中（标题/描述/颜色/详情/搜索关键字等），完成后才能编辑/收起'
                          : undefined
                      }
                    >
                      {row.aiPostStatus === 'pending' ? (
                        <>AI处理中</>
                      ) : detailId === row.id ? (
                        <>
                          收起
                          <IconChevronUp className="h-3 w-3 shrink-0" />
                        </>
                      ) : (
                        <>
                          编辑
                          <IconChevronDown className="h-3 w-3 shrink-0" />
                        </>
                      )}
                    </button>
                    ) : null}
                    <button
                      type="button"
                      title="选择目标平台与导出类型后下载"
                      className={tableActionExportClass}
                      onClick={() => openExportModal([row.id])}
                    >
                      导出
                    </button>
                    <button
                      type="button"
                      title="插件数据（插件清洗后）；非亚马逊导出在导出时由此二次加工"
                      className={tableActionCopyClass}
                      disabled={genericLoadingId === row.id}
                      onClick={() => void openGenericDataModal(row.id)}
                    >
                      {genericLoadingId === row.id ? '加载…' : '插件数据'}
                    </button>
                    {isArchivedMode ? (
                      <button
                        type="button"
                        className={tableActionEditClass}
                        disabled={restoringSelected}
                        onClick={() => void restoreOne(row.id)}
                      >
                        恢复
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={tableActionDeleteClass}
                      onClick={() => remove(row.id)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td
                  colSpan={user.role === 'admin' ? 12 : 11}
                  className="px-4 py-8 text-center text-slate-400"
                >
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
  );

  const effectiveLimit = data?.limit ?? pageLimit;
  const totalPages =
    data != null && data.total > 0 ? Math.max(1, Math.ceil(data.total / effectiveLimit)) : 1;

  const listCardFooter =
    data != null ? (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm">
        <span className="text-slate-500">本页 {data.rows.length} 条</span>
        {data.total > 0 ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={page <= 1}
              className="rounded border border-slate-200 bg-white px-3 py-1 text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-40"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span className="text-slate-600">
              第 {page} 页 / 共 {totalPages} 页
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              className="rounded border border-slate-200 bg-white px-3 py-1 text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-40"
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  function closeDetail() {
    setDetailId(null);
  }

  async function openAiPromptModal() {
    setAiPromptModalOpen(true);
    setAiPromptLoading(true);
    setErr('');
    try {
      const profiles = await api.collectionAiPromptProfiles(aiPromptPlatformKey || 'amazon');
      setAiPromptProfiles(profiles);
      const active = profiles.profiles.find((p) => p.id === profiles.activeProfileId) || profiles.profiles[0];
      setAiPromptDraft(active ? { ...active.prompts } : null);
      setAiPromptNewProfileName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载 AI 提示词失败');
      setAiPromptModalOpen(false);
    } finally {
      setAiPromptLoading(false);
    }
  }

  async function saveAiPromptDraft() {
    if (!aiPromptDraft) return;
    const platformKey = aiPromptProfiles?.platformKey || aiPromptPlatformKey || 'amazon';
    const activeId = aiPromptProfiles?.activeProfileId || 'default';
    const activeProfile =
      aiPromptProfiles?.profiles.find((p) => p.id === activeId) || aiPromptProfiles?.profiles[0];
    const prompts = {
      title: aiPromptDraft.title.trim(),
      description: aiPromptDraft.description.trim(),
      searchKeywords: aiPromptDraft.searchKeywords.trim(),
    };
    if (!prompts.title || !prompts.description || !prompts.searchKeywords) {
      setErr('AI 提示词不能为空');
      return;
    }
    setAiPromptSaving(true);
    setErr('');
    try {
      const saved = await api.upsertCollectionAiPromptProfile({
        platformKey,
        profileId: activeId,
        name: activeProfile?.name || aiPromptProfiles?.activeProfileName || '默认',
        prompts,
        setActive: true,
      });
      setAiPromptProfiles(saved);
      const nextActive =
        saved.profiles.find((p) => p.id === saved.activeProfileId) || saved.profiles[0];
      setAiPromptDraft(nextActive ? { ...nextActive.prompts } : { ...prompts });
      toastSuccess('AI 提示词已保存', '保存成功');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存 AI 提示词失败');
    } finally {
      setAiPromptSaving(false);
    }
  }

  async function saveAiPromptAsNewProfile() {
    if (!aiPromptDraft) return;
    const name = String(aiPromptNewProfileName || '').trim();
    if (!name) {
      setErr('请填写新提示词类别名称（例如：玩具）');
      return;
    }
    const prompts = {
      title: aiPromptDraft.title.trim(),
      description: aiPromptDraft.description.trim(),
      searchKeywords: aiPromptDraft.searchKeywords.trim(),
    };
    if (!prompts.title || !prompts.description || !prompts.searchKeywords) {
      setErr('AI 提示词不能为空');
      return;
    }
    setAiPromptSaving(true);
    setErr('');
    try {
      const saved = await api.upsertCollectionAiPromptProfile({
        platformKey: aiPromptProfiles?.platformKey || aiPromptPlatformKey || 'amazon',
        name,
        prompts,
        setActive: true,
      });
      setAiPromptProfiles(saved);
      const nextActive =
        saved.profiles.find((p) => p.id === saved.activeProfileId) || saved.profiles[0];
      setAiPromptDraft(nextActive ? { ...nextActive.prompts } : { ...prompts });
      setAiPromptNewProfileName('');
      toastSuccess('新提示词类别已保存并切换', '保存成功');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存 AI 提示词失败');
    } finally {
      setAiPromptSaving(false);
    }
  }

  async function deleteActiveAiPromptProfile() {
    if (!aiPromptProfiles) return;
    const activeId = String(aiPromptProfiles.activeProfileId || '').trim();
    if (!activeId || activeId === 'default') {
      setErr('默认提示词类别不能删除');
      return;
    }
    const active =
      aiPromptProfiles.profiles.find((p) => p.id === activeId) || aiPromptProfiles.profiles[0];
    if (!active) return;
    if (aiPromptDeleteConfirmId !== activeId) {
      setAiPromptDeleteConfirmId(activeId);
      pushToast({
        tone: 'warning',
        title: '确认删除',
        message: `将删除提示词类别「${active.name || active.id}」，删除后会自动切回默认类别。请再次点击“确认删除”。`,
        timeoutMs: 5200,
      });
      window.setTimeout(() => {
        setAiPromptDeleteConfirmId((prev) => (prev === activeId ? null : prev));
      }, 5200);
      return;
    }

    setAiPromptSaving(true);
    setAiPromptDeleteConfirmId(null);
    setErr('');
    try {
      const updated = await api.deleteCollectionAiPromptProfile({
        platformKey: aiPromptProfiles.platformKey || aiPromptPlatformKey || 'amazon',
        profileId: activeId,
      });
      setAiPromptProfiles(updated);
      const nextActive =
        updated.profiles.find((p) => p.id === updated.activeProfileId) || updated.profiles[0];
      setAiPromptDraft(nextActive ? { ...nextActive.prompts } : null);
      setAiPromptNewProfileName('');
      toastSuccess('提示词类别已删除', '删除成功');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除提示词类别失败');
    } finally {
      setAiPromptSaving(false);
    }
  }

  return (
    <div ref={layoutRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-800">{pageTitle}</h1>
          {!isArchivedMode && (
            <button
              type="button"
              disabled={pluginZipDownloading}
              title="下载浏览器采集插件（ZIP）；解压后在 Chrome「扩展程序」中加载已解压的扩展"
              className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-sm font-medium text-teal-900 shadow-sm hover:bg-teal-100 disabled:opacity-50"
              onClick={() => {
                setErr('');
                setPluginZipDownloading(true);
                void downloadCollectionExtensionZip().catch((e) => {
                  setErr(e instanceof Error ? e.message : '插件包下载失败');
                }).finally(() => {
                  setPluginZipDownloading(false);
                });
              }}
            >
              {pluginZipDownloading ? '打包中…' : '下载采集插件'}
            </button>
          )}
          {!isArchivedMode && (
            <button
              type="button"
              title="编辑采集后自动 AI 处理使用的提示词：标题、描述、搜索关键字"
              className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-900 shadow-sm hover:bg-violet-100"
              onClick={() => void openAiPromptModal()}
            >
              AI提示词
            </button>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {COLLECTION_SEARCH_UI_ENABLED && (
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSearchInput(v);
                    // 清空搜索框（点 x 或手动删空）时，立刻恢复为未搜索的全量列表
                    if (!v.trim()) {
                      setPage(1);
                      setSearchText('');
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setPage(1);
                      setSearchText(searchInput.trim());
                    }
                  }}
                  placeholder="搜索 ID/SKU/用户"
                  className="h-10 w-[10rem] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-teal-400"
                />
                <button
                  type="button"
                  className="rounded-lg border border-teal-600 bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-700 active:bg-teal-800"
                  onClick={() => {
                    setPage(1);
                    setSearchText(searchInput.trim());
                  }}
                >
                  搜索
                </button>
              </div>
            )}
            {user.role === 'admin' && (
              <CustomSelect
                value={userIdFilter === '' ? '' : String(userIdFilter)}
                onChange={(v) => {
                  setPage(1);
                  setUserIdFilter(v ? Number(v) : '');
                }}
                options={[
                  { value: '', label: '全部用户' },
                  ...users.map((u) => ({ value: String(u.id), label: u.username })),
                ]}
                className="min-w-0"
                buttonClassName="flex h-10 w-32 items-center justify-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            )}
            <CustomSelect
              value={pagePlatformFilter}
              onChange={(v) => {
                const p = String(v || '').trim();
                setPagePlatformFilter(p);
                setPage(1);
                if (!p) setSel({ ids: [], platformById: {} });
              }}
              options={platformQuickSelectOptions}
              aria-label="按采集平台筛选列表"
              title="仅显示该平台的采集记录（服务端筛选）；选项为当前账号下曾出现过的平台；刷新或切换模块后仍保留（URL 与本地会话）"
              className="min-w-0"
              buttonClassName="flex h-10 w-[7.25rem] items-center justify-center rounded-full border border-slate-200 bg-white px-2 py-2 text-sm text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:opacity-50"
            />
            <CustomSelect
              value={markFilter}
              onChange={(v) => setMarkFilter(v as CollectionMarkFilter)}
              options={MARK_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              aria-label="标记筛选"
              title="标记筛选：按列表标记过滤（与表格「标记」列一致）"
              className="min-w-0"
              buttonClassName="flex h-10 w-32 items-center justify-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            />
            <button
              type="button"
              disabled={sel.ids.length === 0}
              onClick={() => openExportModal(sel.ids)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="与单行「导出」相同；翻页不会清空已选，可跨页勾选后导出。在弹窗中选导出类型与是否含图片；可多平台混选"
            >
              批量导出
            </button>
            {!isArchivedMode ? (
              <button
                type="button"
                disabled={sel.ids.length === 0 || archivingSelected}
                onClick={() => void archiveSelected()}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                title="将已勾选记录移动到归档库，并从当前列表与图片资源模块隐藏"
              >
                {archivingSelected ? '归档中…' : '移动到归档库'}
              </button>
            ) : (
              <button
                type="button"
                disabled={sel.ids.length === 0 || restoringSelected}
                onClick={() => void restoreSelected()}
                className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50"
                title="将已勾选归档记录恢复回主列表"
              >
                {restoringSelected ? '恢复中…' : '批量恢复'}
              </button>
            )}
            <button
              type="button"
              disabled={sel.ids.length === 0 || deletingSelected}
              onClick={() => void removeSelected()}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="删除已勾选的采集记录"
            >
              {deletingSelected ? '删除中…' : '批量删除'}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            已选 {sel.ids.length} 条
            {sel.ids.length > 0
              ? (() => {
                  const uniq = new Set(
                    sel.ids.map((id) => sel.platformById[id]).filter((x) => String(x || '').trim())
                  );
                  if (uniq.size === 0) return ' · 平台（未知）';
                  if (uniq.size === 1) return ` · 平台「${[...uniq][0]}」`;
                  return ` · 含 ${uniq.size} 种采集平台`;
                })()
              : ''}
            {' · 可跨页勾选'}
          </p>
        </div>
      </div>

      {/* errors are shown as toasts (top-right) */}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            ref={tableScrollViewportRef}
            className="min-h-0 flex-1 overflow-auto overscroll-contain pb-2 [scrollbar-gutter:stable]"
          >
            {listTable}
          </div>
        </div>
        {listCardFooter}
      </div>

      {detailId != null ? (
        <div
          className="app-modal-backdrop absolute inset-0 z-[200] flex items-start justify-center"
          role="presentation"
          onClick={(e) => {
            // 避免误点遮罩关闭编辑弹窗：仅允许点击「关闭」按钮关闭
            if (e.target === e.currentTarget) e.stopPropagation();
          }}
        >
          <div
            className="app-modal-panel flex w-full max-w-full flex-col overflow-hidden rounded-[1.75rem]"
            style={
              layoutBounds
                ? {
                    width: layoutBounds.width,
                    marginTop: layoutBounds.top,
                    height: layoutBounds.height,
                    maxHeight: layoutBounds.height,
                    marginBottom: EDIT_MODAL_FRAME_INSET_PX,
                  }
                : {
                    height: 'calc(100vh - 1.5rem)',
                    maxHeight: 'calc(100vh - 1.5rem)',
                    marginTop: EDIT_MODAL_FRAME_INSET_PX,
                    marginBottom: EDIT_MODAL_FRAME_INSET_PX,
                  }
            }
            role="dialog"
            aria-modal
            aria-labelledby="collection-edit-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <h2 id="collection-edit-modal-title" className="text-sm font-semibold text-slate-800">
                编辑采集 · #{detailId}
              </h2>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <div
                  id={`collection-edit-actions-${detailId}`}
                  className="flex shrink-0 items-center justify-end gap-2"
                />
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  onClick={closeDetail}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-y-contain p-3">
              {!detail ? (
                <p className="pt-3 text-sm text-slate-500">加载中…</p>
              ) : (
                <CollectionDetailEditor
                  detail={detail}
                  onDetailReplace={setDetail}
                  headerActionsTargetId={`collection-edit-actions-${detailId}`}
                  onSaved={async () => {
                    if (detailId != null) {
                      try {
                        const d = await api.collection(detailId);
                        setDetail(d);
                      } catch {
                        // ignore
                      }
                    }
                    await load();
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {deleteModal ? (
        <div
          className="app-modal-backdrop fixed inset-0 z-[210] flex items-center justify-center p-4"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteModal(null);
          }}
        >
          <div
            className="app-modal-panel w-full max-w-lg rounded-[1.75rem] p-5"
            role="dialog"
            aria-modal
            aria-label="确认删除"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-800">确认删除</h3>
            <p className="mt-2 text-sm text-slate-600">
              即将删除 <span className="font-semibold">{deleteModal.ids.length}</span> 条采集记录，此操作不可恢复。
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-slate-50 p-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600"
                checked={deleteAlsoImages}
                onChange={(e) => setDeleteAlsoImages(e.target.checked)}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">同时删除服务器/OSS 图片</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  默认会同步清理图片资源；取消勾选将只删除采集记录数据，已下载图片文件会保留在服务器/OSS。
                </div>
              </div>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setDeleteModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg border border-red-200 bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={deletingSelected}
                onClick={() => void confirmDelete()}
              >
                {deletingSelected ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CollectionExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        ids={exportModalIds}
        userIdForApi={user.role === 'admin' && userIdFilter !== '' ? Number(userIdFilter) : undefined}
        onAfterDownload={async () => {
          setSel({ ids: [], platformById: {} });
          setErr('');
          await load();
        }}
      />

      {aiPromptModalOpen && (
        <div
          className="app-modal-backdrop fixed inset-0 z-[220] flex items-center justify-center p-4"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) e.stopPropagation();
          }}
        >
          <div
            className="app-modal-panel flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[1.75rem]"
            role="dialog"
            aria-modal
            aria-labelledby="ai-prompt-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <div>
                <h2 id="ai-prompt-modal-title" className="text-sm font-semibold text-slate-800">
                  AI提示词 · 采集自动处理
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  保存后只影响当前登录用户；后续新采集的标题、描述、搜索关键字会按该用户最新提示词自动处理，详情页手动 AI 也会同步使用。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-slate-600">平台</span>
                  <CustomSelect
                    value={aiPromptPlatformKey}
                    onChange={async (v) => {
                      const nextKey = String(v || '').trim().toLowerCase() || 'amazon';
                      if (nextKey === aiPromptPlatformKey) return;
                      if (aiPromptSaving || aiPromptLoading) return;

                      // 若当前提示词未保存，切平台会丢弃草稿
                      if (aiPromptDraft && !confirm('当前提示词未保存，切换平台会丢弃修改。是否继续？')) return;

                      setAiPromptPlatformKey(nextKey);
                      setAiPromptProfiles(null);
                      setAiPromptDraft(null);
                      setAiPromptNewProfileName('');
                      setAiPromptDeleteConfirmId(null);

                      setAiPromptLoading(true);
                      setErr('');
                      try {
                        const profiles = await api.collectionAiPromptProfiles(nextKey);
                        setAiPromptProfiles(profiles);
                        const active =
                          profiles.profiles.find((p) => p.id === profiles.activeProfileId) || profiles.profiles[0];
                        setAiPromptDraft(active ? { ...active.prompts } : null);
                      } catch (e) {
                        setErr(e instanceof Error ? e.message : '加载 AI 提示词失败');
                        setAiPromptModalOpen(false);
                      } finally {
                        setAiPromptLoading(false);
                      }
                    }}
                    options={[
                      { value: 'amazon', label: 'Amazon', icon: platformIconOnly('Amazon'), iconOnly: true },
                      ...exportPlatforms
                        .filter((p) => String(p.enrichKey || '').trim().toLowerCase() !== 'amazon')
                        .filter((p, i, a) => {
                          const ek = String(p.enrichKey || '').trim().toLowerCase();
                          if (!ek) return false;
                          return a.findIndex((x) => String(x.enrichKey || '').trim().toLowerCase() === ek) === i;
                        })
                        .map((p) => ({
                          value: String(p.enrichKey || '').trim().toLowerCase(),
                          label: p.name,
                          icon: platformIconOnly(p.name),
                          iconOnly: true,
                        })),
                    ]}
                    className="min-w-0"
                    buttonClassName="flex h-8 w-[7.25rem] items-center justify-center rounded-full border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:opacity-50"
                  />
                  <span className="text-xs font-medium text-slate-600">提示词类别</span>
                  <CustomSelect
                    value={aiPromptProfiles?.activeProfileId || 'default'}
                    onChange={async (v) => {
                      if (!aiPromptProfiles) return;
                      const nextId = String(v || '').trim();
                      if (!nextId || nextId === aiPromptProfiles.activeProfileId) return;
                      if (aiPromptSaving || aiPromptLoading) return;

                      const cur =
                        aiPromptProfiles.profiles.find((p) => p.id === aiPromptProfiles.activeProfileId) ||
                        aiPromptProfiles.profiles[0];
                      const isDirty =
                        Boolean(aiPromptDraft) &&
                        Boolean(cur) &&
                        (aiPromptDraft.title !== cur.prompts.title ||
                          aiPromptDraft.description !== cur.prompts.description ||
                          aiPromptDraft.searchKeywords !== cur.prompts.searchKeywords);
                      if (isDirty && !confirm('当前提示词未保存，切换类别会丢弃修改。是否继续？')) return;

                      setAiPromptDeleteConfirmId(null);
                      const prevProfiles = aiPromptProfiles;
                      const prevDraft = aiPromptDraft;

                      // Optimistic UI: switch the textarea immediately.
                      const nextProfile = aiPromptProfiles.profiles.find((p) => p.id === nextId);
                      if (nextProfile) {
                        setAiPromptProfiles({
                          ...aiPromptProfiles,
                          activeProfileId: nextId,
                          activeProfileName: nextProfile.name,
                        });
                        setAiPromptDraft({ ...nextProfile.prompts });
                        setAiPromptNewProfileName('');
                      }

                      setAiPromptLoading(true);
                      setErr('');
                      try {
                        const updated = await api.setActiveCollectionAiPromptProfile({
                          platformKey: aiPromptProfiles.platformKey || aiPromptPlatformKey || 'amazon',
                          activeProfileId: nextId,
                        });
                        setAiPromptProfiles(updated);
                        const active =
                          updated.profiles.find((p) => p.id === updated.activeProfileId) || updated.profiles[0];
                        setAiPromptDraft(active ? { ...active.prompts } : null);
                        setAiPromptNewProfileName('');
                      } catch (e) {
                        // Rollback optimistic changes.
                        setAiPromptProfiles(prevProfiles);
                        setAiPromptDraft(prevDraft);
                        setErr(e instanceof Error ? e.message : '切换提示词类别失败');
                      } finally {
                        setAiPromptLoading(false);
                      }
                    }}
                    options={(aiPromptProfiles?.profiles || []).map((p) => ({
                      value: p.id,
                      label: p.name || p.id,
                    }))}
                    className="min-w-[10rem]"
                    buttonClassName="flex h-8 w-full min-w-[10rem] items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                  />
                  <span className="text-xs text-slate-500">
                    当前：{aiPromptProfiles?.activeProfileName || aiPromptProfiles?.profiles.find((p) => p.id === aiPromptProfiles?.activeProfileId)?.name || '—'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setAiPromptModalOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {aiPromptLoading || !aiPromptDraft ? (
                <p className="text-sm text-slate-500">加载中…</p>
              ) : (
                <div className="space-y-4">
                  {([
                    ['title', '标题', '控制标题清洗、翻译、润色和平台规范。'],
                    ['description', '描述', '控制描述/五点描述的翻译、清洗和重写；无原始描述时也作为按标题生成描述的规则。'],
                    ['searchKeywords', '搜索关键字', '控制由标题生成搜索关键字的格式和限制。'],
                  ] as const).map(([key, label, hint]) => (
                    <section key={key} className="rounded-2xl border border-white/70 bg-white/45 p-3 shadow-sm">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-800">{label}</h3>
                          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          onClick={() => {
                            const fallback = aiPromptProfiles?.defaults[key] || '';
                            setAiPromptDraft((prev) => (prev ? { ...prev, [key]: fallback } : prev));
                          }}
                        >
                          恢复默认
                        </button>
                      </div>
                      <textarea
                        value={aiPromptDraft[key]}
                        onChange={(e) =>
                          setAiPromptDraft((prev) => (prev ? { ...prev, [key]: e.target.value } : prev))
                        }
                        className="h-44 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-800 outline-none focus:border-violet-300"
                        spellCheck={false}
                      />
                    </section>
                  ))}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/70 bg-white/35 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-slate-500">
                  当前平台键：{aiPromptProfiles?.platformKey || 'amazon'} · 用户：{aiPromptProfiles?.userId ?? user.id} · 类别：{aiPromptProfiles?.activeProfileName || '—'}（采集自动处理将使用该类别）
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <input
                  value={aiPromptNewProfileName}
                  onChange={(e) => setAiPromptNewProfileName(e.target.value)}
                  placeholder="新类别名：例如 玩具"
                  className="hidden w-36 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-violet-300 sm:block"
                  disabled={aiPromptSaving || aiPromptLoading}
                />
                <button
                  type="button"
                  disabled={aiPromptSaving || aiPromptLoading || !aiPromptDraft}
                  className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void saveAiPromptAsNewProfile()}
                  title="新增一个提示词类别，并切换为该类别"
                >
                  新增
                </button>
                <button
                  type="button"
                  disabled={
                    aiPromptSaving ||
                    aiPromptLoading ||
                    !aiPromptProfiles ||
                    aiPromptProfiles.activeProfileId === 'default'
                  }
                  className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={() => void deleteActiveAiPromptProfile()}
                  title={
                    aiPromptProfiles?.activeProfileId === 'default'
                      ? '默认提示词类别不能删除'
                      : '删除当前提示词类别'
                  }
                >
                  {aiPromptDeleteConfirmId === aiPromptProfiles?.activeProfileId ? '确认删除' : '删除当前类别'}
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => setAiPromptModalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={aiPromptSaving || aiPromptLoading || !aiPromptDraft}
                  className="rounded-full bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void saveAiPromptDraft()}
                >
                  {aiPromptSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {genericModal && (
        <div
          className="app-modal-backdrop fixed inset-0 z-[190] flex items-center justify-center p-4"
          role="presentation"
        >
          <div
            className="app-modal-panel flex max-h-[85vh] w-full max-w-5xl flex-col rounded-[1.75rem]"
            role="dialog"
            aria-modal
            aria-labelledby="generic-modal-title"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 id="generic-modal-title" className="text-sm font-semibold text-slate-800">
                插件数据 · 采集 #{genericModal.collectionId}
              </h2>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
                onClick={() => setGenericModal(null)}
              >
                关闭
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-4 text-left text-xs leading-relaxed text-slate-700">
              {genericModal.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
