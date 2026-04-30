import { AutosizeTextarea } from '../AutosizeTextarea';
import { SectionCard } from '../SectionCard';

export function PriceSection({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <SectionCard title="价格">
      <div>
        <AutosizeTextarea
          id="col-list-price"
          minHeightPx={40}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </div>
    </SectionCard>
  );
}

