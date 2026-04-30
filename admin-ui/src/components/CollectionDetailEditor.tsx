import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type CollectionDetail, type CollectionUserMark } from '../api';
// ossPublicUrlForCollectionImage moved to LocalServerImageThumb
import { extractImageUrlsFromRowsLikeServer } from '../utils/extractImageUrls';
import {
  normalizeDescLines,
} from '../utils/aiResponseNormalize';
import { CustomSelect } from './CustomSelect';
import { ImageLightbox } from './ImageLightbox';
// AuthenticatedImageThumb moved to LocalServerImageThumb
import { pushToast, toastError, toastSuccess } from '../utils/toast';
import { stableStringify } from '../utils/stableStringify';
import { useDirtySnapshot } from '../hooks/useDirtySnapshot';
import { useCollectionImageLightbox } from '../hooks/useCollectionImageLightbox';
import { useCollectionSavePayload } from '../hooks/useCollectionSavePayload';
import { useAiAndTranslateConfig } from '../hooks/useAiAndTranslateConfig';
import { useSkuAxesAndChecked } from '../hooks/useSkuAxesAndChecked';
import { TitleSection } from './collectionDetailEditor/sections/TitleSection';
import { DescriptionsSection } from './collectionDetailEditor/sections/DescriptionsSection';
import { DetailsSection } from './collectionDetailEditor/sections/DetailsSection';
import { SearchKeywordsSection } from './collectionDetailEditor/sections/SearchKeywordsSection';
import { PriceSection } from './collectionDetailEditor/sections/PriceSection';
import { SizeSection } from './collectionDetailEditor/sections/SizeSection';
import { ColorSection } from './collectionDetailEditor/sections/ColorSection';
import { MainImagesSection } from './collectionDetailEditor/sections/MainImagesSection';
import { GallerySection } from './collectionDetailEditor/sections/GallerySection';
import { DetailImagesSection } from './collectionDetailEditor/sections/DetailImagesSection';
import { normalizeColorExportChecked, normalizeGalleryChecked, normalizeSizeExportChecked } from '../utils/collectionDetailEditor/exportChecked';
import {
  COLOR_FIELD_KEYS,
  SIZE_FIELD_KEYS,
  dataToRows,
  expandFieldToLines,
  fieldLinesDisplay,
  getTitle,
  mainImageFieldEntries,
  mainImageUrl,
  readDescriptions,
  readDetails,
  readGenericPluginPrice,
  sharedRowIndex,
  variantIndices,
} from '../utils/collectionDetailEditor/rows';

const DETAIL_MARK_OPTIONS: readonly { value: CollectionUserMark; label: string; dotClass: string }[] = [
  { value: 'export', label: '导出', dotClass: 'bg-emerald-500' },
  { value: 'pending', label: '待定', dotClass: 'bg-amber-500' },
  { value: 'discard', label: '丢弃', dotClass: 'bg-red-500' },
];

/** 亚马逊五点描述：描述区块点击「AI处理」时使用；输出须为纯英文 */
const MIMO_DESC_SYSTEM = `You are an Amazon listing copy expert. From the user’s raw bullet-style text, produce exactly five new bullet lines in English only.

Each line must follow this theme in order: (1) material & composition, (2) versatile style, (3) year-round / all-season wear, (4) functional design, (5) comfort & fit.

Rules:
- Remove any country, region, or size references (e.g. China, Chinese, S, M, L, XL, 2XL).
- Remove marketing words, years, subjective or hype claims (e.g. New, Popular, Trending, Excellent, Best).
- Keep core product benefits: fabric, cut, pattern, use, pockets, sleeve length, etc.
- Tone: natural, concise, suitable for Amazon detail bullets.
- The entire output must be pure English: no Chinese, no other languages, no mixed scripts.

Example input:
- Size Consideration:Available in Chinese sizes, please refer to our size chart for a precise fit, ensuring a comfortable wear.
- Long Tee Shirt|Men 2xl Shirt|Material Blend:Crafted with 62% Polyester, 34% Viscose, and 3.3% Spandex for a comfortable, stretchable fit.
- Versatile Style:Features a turn-down collar and plaid pattern, perfect for daily casual wear.
- Seasonal Adaptability:Designed for Spring and Autumn, this long sleeve shirt offers a stylish transition between seasons.
- Functional Design:Includes a pocket for convenience and a full sleeve length for added warmth.

Output format (exactly 5 lines, one bullet per line, in this order). Each line starts with this English label followed by a space and the sentence:
Material & Composition:
Versatile Style:
Year-Round Wear:
Functional Design:
Comfort & Fit:

After each label, write the body in English on the same line. Do not use Markdown, do not add numbering, no extra lines before or after the five lines.`;

function compactPromptValue(value: unknown, maxChars = 6000): string {
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

function renderCollectionPrompt(template: string, vars: Record<string, unknown>): string {
  let s = String(template ?? '');
  for (const [key, value] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), compactPromptValue(value));
  }
  return s;
}

function detailBlocksToPromptContext(blocks: { key: string; value: string }[]): string {
  return compactPromptValue(
    blocks
      .map((b) => `${b.key}: ${compactPromptValue(b.value, 2000)}`)
      .filter((line) => line.trim())
      .join('\n'),
    6000
  );
}

// moved to utils/collectionDetailEditor/*

type Props = {
  detail: CollectionDetail;
  onSaved: () => void;
  /** AI 后处理为 pending 时用于轮询刷新详情（通常传入 setDetail） */
  onDetailReplace?: (d: CollectionDetail) => void;
  /** 将标记/保存等操作渲染到外层编辑弹窗标题栏 */
  headerActionsTargetId?: string;
};

export default function CollectionDetailEditor({
  detail,
  onSaved,
  onDetailReplace,
  headerActionsTargetId,
}: Props) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [saving, setSaving] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [galleryChecked, setGalleryChecked] = useState<boolean[]>([]);
  const [colorExportChecked, setColorExportChecked] = useState<boolean[]>([]);
  const [sizeExportChecked, setSizeExportChecked] = useState<boolean[]>([]);
  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [imageRev, setImageRev] = useState(0);
  /** 翻译预览：fieldKey → 中文预览值（不修改 rows，保存时自动忽略） */
  const [translatedPreview, setTranslatedPreview] = useState<Record<string, string>>({});

  const originalData = detail.data as Record<string, unknown>;
  const [skuAxes, setSkuAxes] = useState<Record<string, unknown> | null>(null);

  const { mimoConfigured, tencentTranslateConfigured, aiPrompts } = useAiAndTranslateConfig({
    detailId: detail.id,
    aiPromptPlatformKey: detail.aiPromptPlatformKey,
  });

  useEffect(() => {
    const onUpdated = (e: Event) => {
      const ce = e as CustomEvent<{ collectionId?: number }>;
      const cid = ce?.detail?.collectionId;
      if (cid === detail.id) setImageRev((v) => v + 1);
    };
    window.addEventListener('collection-images-updated', onUpdated as EventListener);
    return () => window.removeEventListener('collection-images-updated', onUpdated as EventListener);
  }, [detail.id]);

  useEffect(() => {
    let next = dataToRows(originalData);
    const sIdx = sharedRowIndex(next);
    const genP = readGenericPluginPrice(detail.genericData as Record<string, unknown> | undefined);
    if (genP) {
      const curRow = next[sIdx];
      const cur = String((curRow as Record<string, unknown> | undefined)?.['list_price'] ?? '').trim();
      if (!cur) {
        next = [...next];
        next[sIdx] = { ...(curRow && typeof curRow === 'object' ? curRow : {}), list_price: genP };
      }
    }
    setRows(next);
    // 允许“颜色”按 sku_axes.colors 原始数量展示（避免颜色×尺码展开导致倍增）
    const ax = (originalData as any)?.sku_axes;
    if (ax && typeof ax === 'object' && !Array.isArray(ax)) setSkuAxes({ ...(ax as any) });
    else setSkuAxes(null);
    setSaveErr('');
  }, [detail.id, originalData, detail.genericData]);

  const sharedIdx = useMemo(() => sharedRowIndex(rows), [rows]);
  const variantIdxs = useMemo(() => variantIndices(rows, sharedIdx), [rows, sharedIdx]);
  const unified = variantIdxs.length === 1 && variantIdxs[0] === sharedIdx;

  /** 更新翻译预览（不修改 rows） */
  const handlePreviewChange = useCallback((key: string, value: string | null) => {
    setTranslatedPreview((prev) => {
      if (value === null) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const sharedRow = rows[sharedIdx] || {};
  const titleValue = getTitle(rows);
  const sizeLinesDisplay = useMemo(() => {
    const ax = skuAxes;
    if (ax && typeof ax === 'object' && !Array.isArray(ax)) {
      const s = (ax as { sizes?: unknown[] }).sizes;
      if (Array.isArray(s) && s.length) {
        return s.map((x) => String(x ?? '').trim()).filter((x) => x !== '').join('\n');
      }
    }
    return fieldLinesDisplay(rows, SIZE_FIELD_KEYS);
  }, [rows, skuAxes]);
  const colorLinesDisplay = useMemo(() => {
    const ax = skuAxes;
    if (ax && typeof ax === 'object' && !Array.isArray(ax)) {
      const c = (ax as any).colors;
      if (Array.isArray(c) && c.length) {
        return c.map((x) => String(x ?? '').trim()).filter((x) => x !== '').join('\n');
      }
    }
    return fieldLinesDisplay(rows, COLOR_FIELD_KEYS);
  }, [rows, skuAxes]);

  const colorTokens = useMemo(
    () =>
      colorLinesDisplay
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((x) => x !== ''),
    [colorLinesDisplay]
  );

  const sizeTokens = useMemo(
    () =>
      sizeLinesDisplay
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((x) => x !== ''),
    [sizeLinesDisplay]
  );

  const colorExportCheckedDisplay = useMemo(() => {
    if (colorTokens.length === 0) return [];
    if (colorExportChecked.length === colorTokens.length) return colorExportChecked;
    return normalizeColorExportChecked(originalData, colorTokens.length);
  }, [colorTokens, colorExportChecked, originalData]);

  const sizeExportCheckedDisplay = useMemo(() => {
    if (sizeTokens.length === 0) return [];
    if (sizeExportChecked.length === sizeTokens.length) return sizeExportChecked;
    return normalizeSizeExportChecked(originalData, sizeTokens.length);
  }, [sizeTokens, sizeExportChecked, originalData]);

  const genericPluginPriceHint = useMemo(
    () => readGenericPluginPrice(detail.genericData as Record<string, unknown> | undefined),
    [detail.id, detail.genericData]
  );

  const descBlocks = useMemo(() => readDescriptions(sharedRow as Record<string, unknown>), [sharedRow]);
  const detailBlocks = useMemo(() => readDetails(sharedRow as Record<string, unknown>), [sharedRow]);
  const detailPromptContext = useMemo(() => detailBlocksToPromptContext(detailBlocks), [detailBlocks]);
  const titleAiSystemPrompt = aiPrompts?.prompts.title || '';
  const descAiSystemPrompt = aiPrompts?.prompts.description || MIMO_DESC_SYSTEM;
  const searchKeywordsAiSystemPrompt = aiPrompts?.prompts.searchKeywords || '';
  const renderedTitleAiSystemPrompt = useMemo(
    () => renderCollectionPrompt(titleAiSystemPrompt, { title: titleValue, detail: detailPromptContext }),
    [titleAiSystemPrompt, titleValue, detailPromptContext]
  );
  const renderedSearchKeywordsAiSystemPrompt = useMemo(
    () => renderCollectionPrompt(searchKeywordsAiSystemPrompt, { title: titleValue, detail: detailPromptContext }),
    [searchKeywordsAiSystemPrompt, titleValue, detailPromptContext]
  );
  const handleDescAiPolish = useCallback(
    async (b: { key: string; lines: string[] }) => {
      const raw = b.lines.join('\n').trim();
      if (!raw) {
        const msg = '当前描述为空，无法优化';
        toastError(msg);
        return;
      }
      if (mimoConfigured === false) {
        const msg = '服务端未配置当前默认 AI Provider 的 API Key，请在 server/.env 配置后重试';
        toastError(msg, 'AI 不可用');
        return;
      }

      const loadingKey = `desc:${b.key}`;
      if (aiLoading !== null) {
        pushToast({
          tone: 'info',
          title: 'AI 正在处理',
          message: '已有一个 AI 任务在执行中，请稍候…',
          timeoutMs: 1800,
        });
        return;
      }
      setAiLoading(loadingKey);
      setSaveErr('');
      try {
        pushToast({
          tone: 'info',
          title: 'AI 处理中',
          message: `正在优化描述「${b.key}」…`,
          timeoutMs: 1600,
        });
        const res = await api.mimoChat({
          messages: [
            {
              role: 'system',
              content: renderCollectionPrompt(descAiSystemPrompt, {
                title: titleValue,
                bullets: raw,
                detail: detailPromptContext,
              }),
            },
            {
              role: 'user',
              content: `Raw source text (any number of lines; synthesize into exactly five English bullets per the rules):\n\n${raw}`,
            },
          ],
          max_completion_tokens: 2048,
        });
        const lines = normalizeDescLines(
          typeof res?.text === 'string' ? res.text : String(res?.text ?? '')
        );
        if (lines.length === 0) {
          const msg =
            'MiMo 未返回有效描述（可能为空行），请重试。若仍失败，请稍后再试或检查 API 额度。';
          toastError(msg, 'AI 返回为空');
          return;
        }
        setRows((prev) => {
          const next = [...prev];
          const base = { ...(next[sharedIdx] || {}) };
          base[b.key] = lines;
          next[sharedIdx] = base;
          return next;
        });
        setTranslatedPreview((prev) => {
          if (!prev[loadingKey]) return prev;
          const next = { ...prev };
          delete next[loadingKey];
          return next;
        });
        toastSuccess(`描述「${b.key}」已更新`, 'AI 处理完成');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'AI 润色失败';
        toastError(msg);
      } finally {
        setAiLoading((prev) => (prev === loadingKey ? null : prev));
      }
    },
    [aiLoading, descAiSystemPrompt, detailPromptContext, mimoConfigured, sharedIdx, titleValue]
  );
  const detailImageUrls = useMemo(() => {
    const v = (sharedRow as Record<string, unknown>)['详情图'];
    return expandFieldToLines(v);
  }, [sharedRow]);
  /** 与图片下载 manifest、图片资源管理一致：全量 rows + 与服务端相同的去重规则 */
  const galleryUrls = useMemo(
    () => extractImageUrlsFromRowsLikeServer(rows).gallery,
    [rows]
  );

  const mainManifestLen = detail.imagesManifest?.mainFiles?.length ?? 0;
  const galleryManifestLen = detail.imagesManifest?.galleryFiles?.length ?? 0;
  const galleryLen = Math.max(galleryUrls.length, galleryManifestLen);
  const detailLocalFiles = detail.imagesManifest?.detailFiles ?? [];
  const detailPublicUrls = Array.isArray(detail.detailImagePublicUrls) ? detail.detailImagePublicUrls : [];
  const showLocalDetail = detail.imagesStatus === 'done' && detailLocalFiles.length > 0;
  const detailLen = showLocalDetail ? detailLocalFiles.length : detailImageUrls.length;
  const {
    lightbox,
    closeLightbox,
    registerMainBlob,
    registerGalleryBlob,
    registerDetailBlob,
    openMainLightbox,
    openGalleryLightbox,
    openDetailImagesLightbox,
  } = useCollectionImageLightbox({
    detailId: detail.id,
    imagesStatus: detail.imagesStatus,
    imagesManifestMainLen: mainManifestLen,
    imagesManifestGalleryFiles: detail.imagesManifest?.galleryFiles ?? [],
    galleryLen,
    galleryUrls,
    detailLen,
    showLocalDetail,
    detailImageUrls: detailImageUrls.map(String),
  });

  useEffect(() => {
    setGalleryChecked(normalizeGalleryChecked(originalData, galleryLen));
  }, [detail.id, originalData, galleryLen]);

  useEffect(() => {
    setColorExportChecked(normalizeColorExportChecked(originalData, colorTokens.length));
  }, [detail.id, originalData, colorTokens.length]);

  useEffect(() => {
    setSizeExportChecked(normalizeSizeExportChecked(originalData, sizeTokens.length));
  }, [detail.id, originalData, sizeTokens.length]);

  const toggleColorExportChecked = useCallback((index: number) => {
    setColorExportChecked((prev) => {
      const n = colorTokens.length;
      const base =
        prev.length === n ? [...prev] : normalizeColorExportChecked(originalData, n);
      if (index < 0 || index >= base.length) return base;
      const next = [...base];
      next[index] = !next[index];
      return next;
    });
  }, [colorTokens.length, originalData]);

  const toggleSizeExportChecked = useCallback((index: number) => {
    setSizeExportChecked((prev) => {
      const n = sizeTokens.length;
      const base =
        prev.length === n ? [...prev] : normalizeSizeExportChecked(originalData, n);
      if (index < 0 || index >= base.length) return base;
      const next = [...base];
      next[index] = !next[index];
      return next;
    });
  }, [sizeTokens.length, originalData]);

  /** 首帧或长度未对齐时用服务端/默认全选，避免勾选状态与 URL 列表错位 */
  const galleryCheckedDisplay = useMemo(() => {
    if (galleryLen === 0) return [];
    if (galleryChecked.length === galleryLen) return galleryChecked;
    return normalizeGalleryChecked(originalData, galleryLen);
  }, [galleryLen, galleryChecked, originalData]);

  const toggleGalleryChecked = useCallback(
    (index: number) => {
      setGalleryChecked((prev) => {
        const n = galleryLen;
        const cur =
          prev.length === n ? [...prev] : normalizeGalleryChecked(originalData, n);
        if (index < 0 || index >= cur.length) return cur;
        const next = [...cur];
        next[index] = !next[index];
        return next;
      });
    },
    [galleryLen, originalData]
  );

  const { buildSavePayload } = useCollectionSavePayload({
    rows,
    originalData,
    galleryLen,
    galleryChecked,
    skuAxes,
    colorTokensLength: colorTokens.length,
    colorExportChecked,
    sizeTokensLength: sizeTokens.length,
    sizeExportChecked,
  });

  const { isDirty, markClean } = useDirtySnapshot({
    key: detail.id,
    ready: rows.length > 0,
    getSnapshot: () => stableStringify(buildSavePayload()),
  });

  const updateRow = useCallback((index: number, patch: Record<string, unknown>) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  const setTitleAll = useCallback((title: string) => {
    setRows((prev) => prev.map((r) => ({ ...r, 标题: title })));
  }, []);

  const updateSharedRow = useCallback((patch: Record<string, unknown>) => {
    setRows((prev) => {
      const idx = sharedRowIndex(prev);
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const { commitSizeLines, commitColorLines } = useSkuAxesAndChecked({
    setRows,
    setSkuAxes,
    setSizeExportChecked,
    setColorExportChecked,
  });

  const save = async () => {
    setSaveErr('');
    setSaving(true);
    try {
      if (!isDirty()) {
        pushToast({
          tone: 'info',
          title: '无需保存',
          message: '未检测到数据变化',
          timeoutMs: 1800,
        });
        return;
      }
      const payload = buildSavePayload();
      await api.updateCollection(detail.id, payload);
      toastSuccess('采集内容已保存', '保存成功');
      markClean();
      onSaved();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const applyUserMark = async (value: string) => {
    setMarkSaving(true);
    setSaveErr('');
    try {
      const mark: CollectionUserMark | null =
        value === '' ? null : (value as CollectionUserMark);
      await api.setCollectionMark(detail.id, mark);
      const d = await api.collection(detail.id);
      onDetailReplace?.(d);
      onSaved();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : '更新标记失败');
    } finally {
      setMarkSaving(false);
    }
  };

  const showAiPending = detail.aiPostStatus === 'pending';

  useEffect(() => {
    if (!showAiPending || !onDetailReplace) return;
    const id = detail.id;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const d = await api.collection(id);
        if (cancelled) return;
        onDetailReplace(d);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [showAiPending, detail.id, onDetailReplace]);

  if (!rows.length) {
    return (
      <div className="relative min-h-[14rem]">
        <p className="text-sm text-slate-500">
          暂无采集数据，请检查插件上报格式（需含 rows 或单条对象）。
        </p>
      </div>
    );
  }

  const showLocalMain =
    detail.imagesStatus === 'done' && (detail.imagesManifest?.mainFiles?.length ?? 0) > 0;
  const localMainFiles = detail.imagesManifest?.mainFiles ?? [];
  const mainNobgList = detail.imagesManifest?.mainFilesNobg;
  const nobgDone = detail.imagesNobgStatus === 'done';
  const galleryLocalFiles = detail.imagesManifest?.galleryFiles ?? [];
  const galleryNobgFiles = detail.imagesManifest?.galleryFilesNobg ?? [];
  const headerActionsTarget =
    headerActionsTargetId && typeof document !== 'undefined' ? document.getElementById(headerActionsTargetId) : null;
  const headerActions = (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {showAiPending ? (
        <span
          className="text-sm font-medium text-slate-600"
          role="status"
          aria-live="polite"
          title="服务端正在执行 AI 后处理（标题、描述、颜色、详情、搜索关键字等），完成后可保存与手动 AI"
        >
          AI处理中…
        </span>
      ) : null}
      <div
        className="flex items-center gap-2 rounded-full border border-white/80 bg-white/60 px-2 py-1 shadow-sm ring-1 ring-teal-900/5 backdrop-blur"
        title={`采集 #${detail.id}，与列表「标记」列同步`}
      >
        <span className="rounded-full bg-teal-50/85 px-2 py-1 text-[11px] font-semibold leading-none tracking-wide text-teal-800 ring-1 ring-teal-100">
          标记
        </span>
        <CustomSelect
          value={detail.userMark ?? ''}
          onChange={(v) => void applyUserMark(v)}
          options={[
            { value: '', label: '未标记', dotClass: 'bg-slate-200' },
            ...DETAIL_MARK_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
              dotClass: o.dotClass,
            })),
          ]}
          disabled={markSaving || saving || showAiPending}
          aria-label={`标记（采集 ${detail.id}）`}
          className="!w-[7rem] max-w-[7rem] shrink-0 min-w-0"
          buttonClassName="flex h-8 w-full cursor-pointer items-center justify-center gap-1 rounded-full border border-teal-100 bg-white/80 px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-200 hover:bg-white hover:text-teal-800 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      <button
        type="button"
        disabled={saving || showAiPending}
        onClick={save}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col">
      <ImageLightbox state={lightbox} onClose={closeLightbox} />
      {headerActionsTarget ? createPortal(headerActions, headerActionsTarget) : null}
      <div className="relative flex min-h-[12rem] flex-col">
        <div className="flex flex-col">
        <div className="flex flex-col gap-4 pb-2">

          {saveErr ? <p className="text-sm text-red-600">{saveErr}</p> : null}

        <fieldset disabled={showAiPending} className="contents">
      <TitleSection
        titleValue={titleValue}
        translatedPreview={translatedPreview}
        tencentTranslateConfigured={tencentTranslateConfigured}
        onPreviewChange={handlePreviewChange}
        setTitleAll={setTitleAll}
        mimoConfigured={mimoConfigured}
        aiLoading={aiLoading}
        setAiLoading={setAiLoading}
        titleAiSystemPrompt={renderedTitleAiSystemPrompt}
        setSaveErr={setSaveErr}
      />

      <PriceSection
        value={String((sharedRow as any)['list_price'] ?? '')}
        onChange={(v) => updateSharedRow({ list_price: v })}
        placeholder={genericPluginPriceHint ? `插件「价格」参考：${genericPluginPriceHint}` : '例如：69'}
      />

      <SizeSection
        sizeTokens={sizeTokens}
        checked={sizeExportCheckedDisplay}
        onToggleChecked={toggleSizeExportChecked}
        value={sizeLinesDisplay}
        onChange={(v) => commitSizeLines(v)}
      />

      <ColorSection
        colorTokens={colorTokens}
        checked={colorExportCheckedDisplay}
        onToggleChecked={toggleColorExportChecked}
        value={colorLinesDisplay}
        onChange={(v) => commitColorLines(v)}
      />
      <MainImagesSection
        showLocalMain={showLocalMain}
        localMainFiles={localMainFiles}
        nobgDone={nobgDone}
        mainNobgList={mainNobgList}
        colorTokensLength={colorTokens.length}
        colorExportCheckedDisplay={colorExportCheckedDisplay}
        collectionId={detail.id}
        imageRev={imageRev}
        registerMainBlob={registerMainBlob}
        openMainLightbox={openMainLightbox}
        imagesStatus={detail.imagesStatus}
        imagesError={detail.imagesError}
        unified={unified}
        rows={rows}
        updateRow={updateRow}
        mainImageFieldEntries={mainImageFieldEntries}
        mainImageUrl={mainImageUrl}
        variantIdxs={variantIdxs}
      />

      <GallerySection
        galleryLen={galleryLen}
        checked={galleryCheckedDisplay}
        onToggleChecked={toggleGalleryChecked}
        galleryUrls={galleryUrls}
        hasLocalAt={(i) => detail.imagesStatus === 'done' && Boolean(galleryLocalFiles[i])}
        localFilenameAt={(i) => String(galleryLocalFiles[i] || '')}
        useNobgAt={(i) => Boolean(nobgDone && galleryNobgFiles[i])}
        nobgFilenameAt={(i) => String(galleryNobgFiles[i] || '')}
        collectionId={detail.id}
        imageRev={imageRev}
        registerGalleryBlob={registerGalleryBlob}
        openGalleryLightbox={openGalleryLightbox}
      />

      <DetailImagesSection
        detailLen={detailLen}
        showLocalDetail={showLocalDetail}
        detailLocalFiles={detailLocalFiles.map(String)}
        detailImageUrls={detailImageUrls.map(String)}
        detailPublicUrls={detailPublicUrls.map(String)}
        collectionId={detail.id}
        imageRev={imageRev}
        registerDetailBlob={registerDetailBlob}
        openDetailImagesLightbox={openDetailImagesLightbox}
      />

      <DescriptionsSection
        descBlocks={descBlocks}
        translatedPreview={translatedPreview}
        tencentTranslateConfigured={tencentTranslateConfigured}
        onPreviewChange={handlePreviewChange}
        mimoConfigured={mimoConfigured}
        aiLoading={aiLoading}
        onAiPolish={handleDescAiPolish}
        onChangeLines={(key, lines) => {
          setRows((prev) => {
            const next = [...prev];
            const base = { ...(next[sharedIdx] || {}) };
            (base as any)[key] = lines;
            next[sharedIdx] = base;
            return next;
          });
        }}
      />

      <DetailsSection
        detailBlocks={detailBlocks}
        translatedPreview={translatedPreview}
        tencentTranslateConfigured={tencentTranslateConfigured}
        onPreviewChange={handlePreviewChange}
        onChangeValue={(key, value) => {
          setRows((prev) => {
            const next = [...prev];
            const base = { ...(next[sharedIdx] || {}) };
            (base as any)[key] = value;
            next[sharedIdx] = base;
            return next;
          });
        }}
      />

      <SearchKeywordsSection
        sharedRowSearchKeywords={String((sharedRow as any)['搜索关键字'] ?? '')}
        translatedPreview={translatedPreview}
        tencentTranslateConfigured={tencentTranslateConfigured}
        onPreviewChange={handlePreviewChange}
        mimoConfigured={mimoConfigured}
        aiLoading={aiLoading}
        setAiLoading={setAiLoading}
        searchKeywordsAiSystemPrompt={renderedSearchKeywordsAiSystemPrompt}
        titleValue={titleValue}
        setSaveErr={setSaveErr}
        onChangeSearchKeywords={(value) => updateSharedRow({ 搜索关键字: value })}
      />

      </fieldset>

        </div>
        </div>
      </div>
    </div>
  );
}
