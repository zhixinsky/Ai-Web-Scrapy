import { useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export type AutosizeTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  minHeightPx?: number;
};

/** 多行输入随内容增高（无固定 min-h-[Nrem]） */
export function AutosizeTextarea({
  className = '',
  minHeightPx = 40,
  style,
  onChange,
  ...props
}: AutosizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const adjust = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(minHeightPx, el.scrollHeight)}px`;
  }, [minHeightPx]);

  useLayoutEffect(() => {
    adjust();
  }, [adjust, props.value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      className={`resize-none overflow-hidden ${className}`.trim()}
      style={{ minHeight: minHeightPx, ...style }}
      {...props}
      onChange={onChange}
    />
  );
}

