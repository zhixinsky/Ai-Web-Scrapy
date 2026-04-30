import { AutosizeTextarea } from '../AutosizeTextarea';
import { CharCountBadge } from '../CharCountBadge';
import { TranslateButton } from '../TranslateButton';
import { SectionCard } from '../SectionCard';

export function DetailsSection({
  detailBlocks,
  translatedPreview,
  tencentTranslateConfigured,
  onPreviewChange,
  onChangeValue,
}: {
  detailBlocks: { key: string; value: string }[];
  translatedPreview: Record<string, string>;
  tencentTranslateConfigured: boolean | null;
  onPreviewChange: (key: string, value: string | null) => void;
  onChangeValue: (key: string, value: string) => void;
}) {
  if (!detailBlocks.length) {
    return (
      <SectionCard title="详情">
        <p className="text-xs text-slate-400">当前汇总行无详情字段</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="详情"
      action={
        <>
          {detailBlocks.map((b) => (
            <TranslateButton
              key={`translate-${b.key}`}
              tencentConfigured={tencentTranslateConfigured}
              title={`将英文详情「${b.key}」翻译成中文`}
              fieldKey={`detail:${b.key}`}
              originalValue={b.value}
              previewMap={translatedPreview}
              onPreviewChange={onPreviewChange}
            />
          ))}
        </>
      }
    >
      <div className="space-y-4">
        {detailBlocks.map((b) => {
          const previewKey = `detail:${b.key}`;
          const isPreviewing = Boolean(translatedPreview[previewKey]);
          const displayValue = translatedPreview[previewKey] ?? b.value;
          return (
            <div key={b.key}>
              <AutosizeTextarea
                id={`det-${b.key}`}
                aria-label={b.key}
                minHeightPx={56}
                className={`w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-relaxed ${
                  isPreviewing ? 'bg-slate-50 text-slate-500' : 'bg-white text-slate-800'
                }`}
                value={displayValue}
                onChange={(e) => onChangeValue(b.key, e.target.value)}
                disabled={isPreviewing}
              />
              <CharCountBadge value={displayValue} />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

