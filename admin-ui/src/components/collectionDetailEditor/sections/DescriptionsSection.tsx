import { AutosizeTextarea } from '../AutosizeTextarea';
import { TranslateButton } from '../TranslateButton';
import { AiPolishButton } from '../AiPolishButton';
import { SectionCard } from '../SectionCard';

export function DescriptionsSection({
  descBlocks,
  translatedPreview,
  tencentTranslateConfigured,
  onPreviewChange,
  mimoConfigured,
  aiLoading,
  onAiPolish,
  onChangeLines,
}: {
  descBlocks: { key: string; lines: string[] }[];
  translatedPreview: Record<string, string>;
  tencentTranslateConfigured: boolean | null;
  onPreviewChange: (key: string, value: string | null) => void;
  mimoConfigured: boolean | null;
  aiLoading: string | null;
  onAiPolish: (b: { key: string; lines: string[] }) => void | Promise<void>;
  onChangeLines: (key: string, lines: string[]) => void;
}) {
  if (!descBlocks.length) return null;
  return (
    <SectionCard
      title="描述"
      action={
        <>
          {descBlocks.map((b) => (
            <TranslateButton
              key={`translate-${b.key}`}
              tencentConfigured={tencentTranslateConfigured}
              title={`将英文描述「${b.key}」翻译成中文`}
              fieldKey={`desc:${b.key}`}
              originalValue={() => b.lines.join('\n')}
              previewMap={translatedPreview}
              onPreviewChange={onPreviewChange}
            />
          ))}
          {descBlocks.map((b) => (
            <AiPolishButton
              key={b.key}
              mimoConfig={mimoConfigured}
              loading={aiLoading === `desc:${b.key}`}
              title={`亚马逊五点描述优化（MiMo）—「${b.key}」`}
              onClick={() => onAiPolish(b)}
            />
          ))}
        </>
      }
    >
      <div className="space-y-4">
        {descBlocks.map((b) => {
          const previewKey = `desc:${b.key}`;
          const isPreviewing = Boolean(translatedPreview[previewKey]);
          const displayValue = translatedPreview[previewKey] ?? b.lines.join('\n');
          return (
            <div key={b.key}>
              <AutosizeTextarea
                id={`desc-${b.key}`}
                aria-label={b.key}
                minHeightPx={48}
                className={`w-full rounded-lg border border-slate-200 px-3 py-2 text-sm ${
                  isPreviewing ? 'bg-slate-50 text-slate-500' : 'bg-white text-slate-800'
                }`}
                value={displayValue}
                onChange={(e) => {
                  const lines = e.target.value.split('\n');
                  onChangeLines(b.key, lines);
                }}
                disabled={isPreviewing}
              />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

