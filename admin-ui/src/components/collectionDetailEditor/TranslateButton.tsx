import { useCallback, useRef, useState } from 'react';

import { api } from '../../api';
import { toastError } from '../../utils/toast';

export function TranslateButton({
  disabled,
  title,
  tencentConfigured,
  fieldKey,
  originalValue,
  previewMap,
  onPreviewChange,
}: {
  disabled?: boolean;
  title: string;
  /** null=尚未拉取状态；false=已知未配置；true=已配置 */
  tencentConfigured: boolean | null;
  /** 字段标识，用于 previewMap 的 key */
  fieldKey: string;
  /** 原始英文文本 */
  originalValue: string | (() => string);
  /** 当前所有翻译预览 */
  previewMap: Record<string, string>;
  /** 更新翻译预览：传 null 表示清除该字段预览 */
  onPreviewChange: (key: string, value: string | null) => void;
}) {
  const [translating, setTranslating] = useState(false);
  // 缓存：同一 fieldKey + 同一原文（trim 后）只翻译一次（仅会话内，不落库）
  const cacheRef = useRef<Record<string, string>>({});

  const showingChinese = Boolean(previewMap[fieldKey]);

  const getOriginalValue = useCallback(() => {
    return typeof originalValue === 'function' ? originalValue() : originalValue;
  }, [originalValue]);

  // 恢复原文
  const restoreOriginal = useCallback(() => {
    onPreviewChange(fieldKey, null);
  }, [fieldKey, onPreviewChange]);

  // 点击切换
  const handleClick = useCallback(async () => {
    if (disabled || translating || tencentConfigured === false) return;

    // 如果正在显示中文，点击恢复原文
    if (showingChinese) {
      restoreOriginal();
      return;
    }

    const cur = getOriginalValue().trim();
    if (!cur) return;

    const cacheKey = `${fieldKey}::${cur}`;
    const cached = cacheRef.current[cacheKey];
    if (cached && cached.trim()) {
      onPreviewChange(fieldKey, cached.trim());
      return;
    }

    setTranslating(true);

    try {
      const res = await api.tencentTranslate(cur);
      const t = typeof res?.text === 'string' ? res.text : String(res?.text ?? '');
      if (t.trim()) {
        const out = t.trim();
        cacheRef.current[cacheKey] = out;
        onPreviewChange(fieldKey, out);
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : '翻译失败');
    } finally {
      setTranslating(false);
    }
  }, [
    disabled,
    translating,
    tencentConfigured,
    showingChinese,
    getOriginalValue,
    fieldKey,
    onPreviewChange,
    restoreOriginal,
  ]);

  const hint =
    tencentConfigured === false
      ? '服务端未配置腾讯云翻译密钥（TENCENT_SECRET_ID / TENCENT_SECRET_KEY）'
      : showingChinese
        ? '点击显示原文'
        : title;

  return (
    <button
      type="button"
      className={`inline-flex h-7 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-semibold leading-none shadow-sm disabled:cursor-not-allowed disabled:opacity-45 ${
        showingChinese
          ? 'border-orange-300 bg-orange-100 text-orange-800'
          : 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
      }`}
      title={hint}
      disabled={disabled || translating || tencentConfigured === false}
      onClick={handleClick}
    >
      {showingChinese ? '显示原文' : '查看中文'}
    </button>
  );
}

