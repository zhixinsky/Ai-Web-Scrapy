import { api } from '../../../api';
import { normalizeTitleText } from '../../../utils/aiResponseNormalize';
import type { Dispatch, SetStateAction } from 'react';
import { pushToast, toastError, toastSuccess } from '../../../utils/toast';
import { AutosizeTextarea } from '../AutosizeTextarea';
import { CharCountBadge } from '../CharCountBadge';
import { TranslateButton } from '../TranslateButton';
import { AiPolishButton } from '../AiPolishButton';
import { SectionCard } from '../SectionCard';

function comparableTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function clampTitleToLength(value: string, maxLength = 120): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length <= maxLength) return title;
  const cut = title.slice(0, maxLength).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= 80 ? cut.slice(0, lastSpace) : cut).replace(/[,\-–—:;]+$/, '').trim();
}

export function TitleSection({
  titleValue,
  translatedPreview,
  tencentTranslateConfigured,
  onPreviewChange,
  setTitleAll,
  mimoConfigured,
  aiLoading,
  setAiLoading,
  titleAiSystemPrompt,
  setSaveErr,
}: {
  titleValue: string;
  translatedPreview: Record<string, string>;
  tencentTranslateConfigured: boolean | null;
  onPreviewChange: (key: string, value: string | null) => void;
  setTitleAll: (title: string) => void;
  mimoConfigured: boolean | null;
  aiLoading: string | null;
  setAiLoading: Dispatch<SetStateAction<string | null>>;
  titleAiSystemPrompt: string;
  setSaveErr: (v: string) => void;
}) {
  const titlePromptReady = titleAiSystemPrompt.trim().length > 0;

  return (
    <SectionCard
      title="标题"
      action={
        <>
          <TranslateButton
            tencentConfigured={tencentTranslateConfigured}
            title="将英文标题翻译成中文"
            fieldKey="title"
            originalValue={titleValue}
            previewMap={translatedPreview}
            onPreviewChange={onPreviewChange}
          />
          <AiPolishButton
            mimoConfig={mimoConfigured}
            loading={aiLoading === 'title'}
            disabled={!titlePromptReady}
            title={titlePromptReady ? '按亚马逊标题规范优化（MiMo）' : '服务端标题提示词尚未加载，请稍后重试'}
            onClick={async () => {
               const cur = titleValue.trim();
               if (!cur) {
                 const msg = '标题为空，无法润色';
                 toastError(msg);
                 return;
               }
               if (mimoConfigured === false) {
                 const msg =
                   '服务端未配置当前默认 AI Provider 的 API Key，请在 server/.env 配置后重试';
                 toastError(msg, 'AI 不可用');
                 return;
               }
               if (!titlePromptReady) {
                 const msg = '服务端标题提示词尚未加载，无法执行 AI 处理。请刷新页面或检查提示词接口。';
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
               setAiLoading('title');
               setSaveErr('');
               try {
                 pushToast({
                   tone: 'info',
                   title: 'AI 处理中',
                   message: '正在优化标题…',
                   timeoutMs: 1600,
                 });
                 const res = await api.mimoChat({
                   messages: [
                     { role: 'system', content: titleAiSystemPrompt },
                     { role: 'user', content: cur },
                   ],
                   max_completion_tokens: 180,
                   temperature: 0.6,
                 });
                 let t = normalizeTitleText(
                   typeof res?.text === 'string' ? res.text : String(res?.text ?? '')
                 );
                 const needsRetry =
                   t.trim() &&
                   (t.trim().length < 80 ||
                     t.trim().length > 120 ||
                     comparableTitle(t) === comparableTitle(cur));
                 if (needsRetry) {
                   const retryReason =
                     t.trim().length < 80
                       ? `Too-short draft:\n${t.trim()}`
                       : t.trim().length > 120
                         ? `Too-long draft (${t.trim().length} characters):\n${t.trim()}`
                       : `The previous draft is identical to the current title and must be rewritten:\n${t.trim()}`;
                   const retry = await api.mimoChat({
                     messages: [
                       { role: 'system', content: titleAiSystemPrompt },
                       {
                         role: 'user',
                         content:
                            `Rewrite the product title into a different Amazon-ready English title, 80-120 characters long, natural, and SEO-friendly. ` +
                            `Preserve the same product facts, do not invent new claims, but change wording/order so the output is not identical to the current title. ` +
                            `Only output the final title.\n\nCurrent title:\n${cur}\n\n${retryReason}`,
                       },
                     ],
                     max_completion_tokens: 180,
                     temperature: 0.85,
                   });
                   const retryTitle = normalizeTitleText(
                     typeof retry?.text === 'string' ? retry.text : String(retry?.text ?? '')
                   );
                   if (retryTitle.trim().length >= 80) t = retryTitle;
                 }
                 t = clampTitleToLength(t, 120);
                 if (!t.trim()) {
                   const msg =
                     'MiMo 未返回有效标题，请重试。若仍失败，请稍后再试或检查 API 额度。';
                   toastError(msg, 'AI 返回为空');
                   return;
                 }
                 if (comparableTitle(t) === comparableTitle(cur)) {
                   const msg = 'AI 返回的标题仍与当前标题一致，未写入。请调整提示词或手动改动标题后再试。';
                   toastError(msg, '未生成不同标题');
                   return;
                 }
                 setTitleAll(t);
                 onPreviewChange('title', null);
                 toastSuccess('标题已更新', 'AI 处理完成');
               } catch (e) {
                 const msg = e instanceof Error ? e.message : 'AI 润色失败';
                 toastError(msg);
               } finally {
                 setAiLoading((prev) => (prev === 'title' ? null : prev));
               }
             }}
           />
         </>
       }
    >
      <div>
        <AutosizeTextarea
          id="col-title"
          minHeightPx={40}
          className={`mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm ${
            translatedPreview['title'] ? 'bg-slate-50 text-slate-500' : 'bg-white text-slate-800'
          }`}
          value={translatedPreview['title'] ?? titleValue}
          onChange={(e) => setTitleAll(e.target.value)}
          placeholder="标题"
          disabled={Boolean(translatedPreview['title'])}
        />
        <CharCountBadge value={translatedPreview['title'] ?? titleValue} />
      </div>
    </SectionCard>
  );
}

