import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type CustomSelectOption = {
  value: string;
  label: string;
  /** 可选：选项前自定义图标（优先于 dotClass 展示） */
  icon?: ReactNode;
  /** 仅显示图标，label 仍用于无障碍名称、title 和内部值 */
  iconOnly?: boolean;
  /** 可选：选项前色点（Tailwind 背景类） */
  dotClass?: string;
  /** 可选：选项最左侧徽标（例如“共享”） */
  leftBadgeLabel?: string;
  leftBadgeClassName?: string;
  /** 可选：选项左侧勾选动作（例如“公开”开关） */
  toggleLabel?: string;
  toggleChecked?: boolean;
  onToggle?: (nextChecked: boolean) => void;
  /** 可选：选项右侧重命名动作 */
  onRename?: () => void;
  renameLabel?: string;
  /** 可选：选项右侧复制动作（用于“公开模板”快速复制为私有模板） */
  onCopy?: () => void;
  copyLabel?: string;
  /** 可选：选项右侧删除动作（用于“模板列表”这类场景） */
  onDelete?: () => void;
  deleteLabel?: string;
};

/**
 * 居中选项的自定义下拉（替代原生 select，避免系统下拉无法样式居中）。
 * 每个实例独立开关与点击外部关闭。
 * 菜单通过 Portal 挂到 body + fixed 定位，避免被 overflow 祖先裁剪导致「打不开」。
 */
export function CustomSelect({
  value,
  onChange,
  options,
  disabled,
  className,
  buttonClassName,
  menuClassName,
  'aria-label': ariaLabel,
  title,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  /** 外层容器；默认 inline-block + w-fit，避免在 flex 工具栏里被拉成整行 */
  className?: string;
  /** 触发按钮（建议含 flex、高度、边框等） */
  buttonClassName?: string;
  /** 追加到浮层 ul */
  menuClassName?: string;
  'aria-label'?: string;
  title?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuPos, setMenuPos] = useState<null | { top: number; left: number; minW: number }>(null);

  const layoutMenu = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, minW: r.width });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    layoutMenu();
    window.addEventListener('scroll', layoutMenu, true);
    window.addEventListener('resize', layoutMenu);
    return () => {
      window.removeEventListener('scroll', layoutMenu, true);
      window.removeEventListener('resize', layoutMenu);
    };
  }, [open, layoutMenu]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  const label = current?.label ?? (value || '—');
  const triggerIcon = current?.icon;
  const triggerDot = current?.dotClass;
  const triggerIconOnly = Boolean(current?.iconOnly);
  /** 无勾选/删除列时：浮层宽度与触发按钮一致，并去掉占位列，避免菜单比按钮更宽 */
  const hasAuxColumns = options.some((o) => o.onToggle || o.onRename || o.onCopy || o.onDelete);

  const defaultRoot = 'relative inline-block w-fit max-w-full align-middle';
  const defaultBtn =
    'inline-flex h-10 min-w-[8rem] max-w-full items-center justify-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-none outline-none ring-0 transition hover:border-slate-300 focus:border-teal-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

  const menuList = (
    <ul
      ref={menuRef}
      role="listbox"
      style={
        menuPos
          ? {
              position: 'fixed',
              top: menuPos.top,
              left: menuPos.left,
              minWidth: menuPos.minW,
              ...(hasAuxColumns
                ? {}
                : { width: menuPos.minW, boxSizing: 'border-box' as const }),
              maxWidth: 'min(36rem, calc(100vw - 1rem))',
              zIndex: 9999,
            }
          : undefined
      }
      className={`${
        hasAuxColumns ? 'w-max' : ''
      } app-context-menu max-h-[min(16rem,40vh)] overflow-y-auto rounded-2xl p-1.5 ${
        hasAuxColumns ? 'overflow-x-auto' : 'overflow-x-hidden'
      } ${menuClassName ?? ''}`}
    >
      {options.map((o) => (
        <li key={o.value === '' ? '__empty' : o.value}>
          {hasAuxColumns ? (
            <button
              type="button"
              role="option"
              aria-selected={value === o.value}
              className={`app-context-item flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-full px-3 py-2 text-center text-sm transition ${
                value === o.value ? 'bg-teal-50/80 font-medium text-teal-900' : 'text-slate-800'
              }`}
              onClick={() => {
                if (value === o.value) {
                  setOpen(false);
                  return;
                }
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center justify-start gap-2">
                <span className="flex w-[3.75rem] shrink-0 items-center justify-start">
                  {o.leftBadgeLabel ? (
                    <span
                      className={`inline-flex select-none items-center justify-center rounded-full border px-1.5 py-1 text-[11px] font-semibold ${
                        o.leftBadgeClassName || 'border-violet-200 bg-violet-50 text-violet-700'
                      }`}
                      aria-hidden
                    >
                      {o.leftBadgeLabel}
                    </span>
                  ) : o.onToggle ? (
                    <label
                      className="inline-flex cursor-pointer select-none items-center gap-1 rounded-full px-1.5 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-600"
                        checked={!!o.toggleChecked}
                        onChange={(e) => o.onToggle?.(e.target.checked)}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      />
                      <span className="font-medium">{o.toggleLabel || '勾选'}</span>
                    </label>
                  ) : (
                    <span className="h-6 w-full" aria-hidden />
                  )}
                </span>
                {o.icon ? (
                  <span className="flex shrink-0 items-center justify-center" aria-hidden>
                    {o.icon}
                  </span>
                ) : o.dotClass ? (
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${o.dotClass}`} aria-hidden />
                ) : null}
                <span className="min-w-0 truncate">{o.label}</span>
              </span>
              {o.onRename || o.onCopy || o.onDelete ? (
                <span className="flex shrink-0 items-center gap-1">
                  {o.onRename ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpen(false);
                        o.onRename?.();
                      }}
                      title={o.renameLabel || '重命名'}
                    >
                      {o.renameLabel || '重命名'}
                    </button>
                  ) : null}
                  {o.onCopy ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpen(false);
                        o.onCopy?.();
                      }}
                      title={o.copyLabel || '复制'}
                    >
                      {o.copyLabel || '复制'}
                    </button>
                  ) : null}
                  {o.onDelete ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpen(false);
                        o.onDelete?.();
                      }}
                      title={o.deleteLabel || '删除'}
                    >
                      {o.deleteLabel || '删除'}
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className="w-8 shrink-0" aria-hidden />
              )}
            </button>
          ) : (
            <button
              type="button"
              role="option"
              aria-selected={value === o.value}
              className={`app-context-item flex w-full min-w-0 items-center justify-center gap-1.5 rounded-full px-2 py-2 text-center text-sm transition ${
                value === o.value ? 'bg-teal-50/80 font-medium text-teal-900' : 'text-slate-800'
              }`}
              onClick={() => {
                if (value === o.value) {
                  setOpen(false);
                  return;
                }
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.icon ? (
                <span className="flex shrink-0 items-center justify-center" aria-hidden>
                  {o.icon}
                </span>
              ) : o.dotClass ? (
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${o.dotClass}`} aria-hidden />
              ) : null}
              {!o.iconOnly && <span className="min-w-0 flex-1 truncate">{o.label}</span>}
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={[defaultRoot, className].filter(Boolean).join(' ')} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={buttonClassName ?? defaultBtn}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        {triggerIcon ? (
          <span className="flex shrink-0 items-center justify-center" aria-hidden>
            {triggerIcon}
          </span>
        ) : triggerDot ? (
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${triggerDot}`}
            aria-hidden
          />
        ) : null}
        {!triggerIconOnly && <span className="min-w-0 flex-1 truncate text-center">{label}</span>}
        {!triggerIconOnly && (
          <span className="shrink-0 text-slate-400" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {open && menuPos != null ? createPortal(menuList, document.body) : null}
    </div>
  );
}
