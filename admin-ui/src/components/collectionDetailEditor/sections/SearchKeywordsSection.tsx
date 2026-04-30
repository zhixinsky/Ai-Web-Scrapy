import { api } from '../../../api';
import { normalizeAmazonSearchKeywordsText } from '../../../utils/aiResponseNormalize';
import type { Dispatch, SetStateAction } from 'react';
import { pushToast, toastError, toastSuccess } from '../../../utils/toast';
import { AutosizeTextarea } from '../AutosizeTextarea';
import { CharCountBadge } from '../CharCountBadge';
import { TranslateButton } from '../TranslateButton';
import { AiPolishButton } from '../AiPolishButton';
import { SectionCard } from '../SectionCard';

export function SearchKeywordsSection({
  sharedRowSearchKeywords,
  translatedPreview,
  tencentTranslateConfigured,
  onPreviewChange,
  mimoConfigured,
  aiLoading,
  setAiLoading,
  searchKeywordsAiSystemPrompt,
  titleValue,
  setSaveErr,
  onChangeSearchKeywords,
}: {
  sharedRowSearchKeywords: string;
  translatedPreview: Record<string, string>;
  tencentTranslateConfigured: boolean | null;
  onPreviewChange: (key: string, value: string | null) => void;
  mimoConfigured: boolean | null;
  aiLoading: string | null;
  setAiLoading: Dispatch<SetStateAction<string | null>>;
  searchKeywordsAiSystemPrompt: string;
  titleValue: string;
  setSaveErr: (v: string) => void;
  onChangeSearchKeywords: (value: string) => void;
}) {
  const previewing = Boolean(translatedPreview['searchKw']);
  const displayValue = translatedPreview['searchKw'] ?? sharedRowSearchKeywords;
  const searchKeywordsPromptReady = searchKeywordsAiSystemPrompt.trim().length > 0;
  return (
    <SectionCard
      title="搜索关键字"
      action={
        <>
          <TranslateButton
            tencentConfigured={tencentTranslateConfigured}
            title="将英文搜索关键字翻译成中文"
            fieldKey="searchKw"
            originalValue={sharedRowSearchKeywords}
            previewMap={translatedPreview}
            onPreviewChange={onPreviewChange}
          />
          <AiPolishButton
            mimoConfig={mimoConfigured}
            loading={aiLoading === 'searchKw'}
            disabled={!searchKeywordsPromptReady}
            title={
              searchKeywordsPromptReady
                ? '根据当前标题用 MiMo 生成亚马逊搜索关键字（英文；分号分隔；6–8 组；≤100 字符）'
                : '服务端搜索关键字提示词尚未加载，请稍后重试'
            }
            onClick={async () => {
              const cur = titleValue.trim();
              if (!cur) {
                const msg = '请先在上方填写商品标题，再生成搜索关键字';
                toastError(msg);
                return;
              }
              if (mimoConfigured === false) {
                const msg =
                  '服务端未配置当前默认 AI Provider 的 API Key，请在 server/.env 配置后重试';
                toastError(msg, 'AI 不可用');
                return;
              }
              if (!searchKeywordsPromptReady) {
                const msg = '服务端搜索关键字提示词尚未加载，无法执行 AI 处理。请刷新页面或检查提示词接口。';
                toastError(msg, '提示词未加载');
                return;
              }

              if (aiLoading !== null) {
                pushToast({
                  tone: 'info',
                  title: 'AI 正在处理',
                  message: '已有一个 AI 任务在执行中，请稍候…',
                  timeoutMs: 1800,
                });
                return;
              }
              setAiLoading('searchKw');
              setSaveErr('');
              try {
                pushToast({
                  tone: 'info',
                  title: 'AI 处理中',
                  message: '正在生成搜索关键字…',
                  timeoutMs: 1600,
                });
                const res = await api.mimoChat({
                  messages: [
                    { role: 'system', content: searchKeywordsAiSystemPrompt },
                    { role: 'user', content: cur },
                  ],
                  max_completion_tokens: 512,
                });
                const raw = typeof res?.text === 'string' ? res.text : String(res?.text ?? '');
                const line = normalizeAmazonSearchKeywordsText(raw);
                if (!line) {
                  const msg = 'MiMo 未返回有效关键字，请重试。';
                  toastError(msg, 'AI 返回为空');
                  return;
                }
                onChangeSearchKeywords(line);
                onPreviewChange('searchKw', null);
                toastSuccess('搜索关键字已更新', 'AI 处理完成');
              } catch (e) {
                const msg = e instanceof Error ? e.message : 'AI 生成失败';
                toastError(msg);
              } finally {
                setAiLoading((prev) => (prev === 'searchKw' ? null : prev));
              }
            }}
          />
        </>
      }
    >
      <div>
        <AutosizeTextarea
          id="col-search-kw"
          minHeightPx={40}
          maxLength={100}
          className={`mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm ${
            previewing ? 'bg-slate-50 text-slate-500' : 'bg-white text-slate-800'
          }`}
          value={displayValue}
          onChange={(e) => onChangeSearchKeywords(e.target.value.slice(0, 100))}
          placeholder="例如：Men Shirt Cotton Casual Short Sleeve"
          disabled={previewing}
        />
        <CharCountBadge value={displayValue} />
      </div>
    </SectionCard>
  );
}

