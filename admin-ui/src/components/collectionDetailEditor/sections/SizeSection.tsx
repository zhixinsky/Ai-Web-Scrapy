import { AutosizeTextarea } from '../AutosizeTextarea';
import { SectionCard } from '../SectionCard';

export function SizeSection({
  sizeTokens,
  checked,
  onToggleChecked,
  value,
  onChange,
}: {
  sizeTokens: string[];
  checked: boolean[];
  onToggleChecked: (index: number) => void;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SectionCard title="尺码">
      <div className="space-y-2">
        {sizeTokens.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {sizeTokens.map((label, i) => (
              <label
                key={`size-${i}-${label.slice(0, 24)}`}
                className="inline-flex max-w-[11rem] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm hover:border-teal-200"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600"
                  checked={Boolean(checked[i])}
                  onChange={() => onToggleChecked(i)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="min-w-0 truncate" title={label}>
                  {label}
                </span>
              </label>
            ))}
          </div>
        ) : null}
        <AutosizeTextarea
          id="col-size"
          minHeightPx={40}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'每行一个尺码，例如：\nM\nL\nXL'}
        />
      </div>
    </SectionCard>
  );
}

