import type { ReactNode } from 'react';

export function SectionCard({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-slate-800">{title}</h3>
        {action ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

