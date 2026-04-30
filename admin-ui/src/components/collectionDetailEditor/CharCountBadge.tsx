export function CharCountBadge({ value }: { value: unknown }) {
  return (
    <div className="mt-1 flex justify-end text-[11px] font-medium leading-none text-slate-400">
      {String(value ?? '').length} 字符
    </div>
  );
}

