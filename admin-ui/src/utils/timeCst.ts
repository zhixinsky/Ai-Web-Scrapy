function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/**
 * 固定东八区（UTC+8）时间，不依赖浏览器/系统时区。
 * 返回 ISO-like：YYYY-MM-DDTHH:mm:ss+08:00
 */
export function nowCstIsoLike(): string {
  const ms = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}+08:00`;
}

/** 用于文件名：YYYYMMDD */
export function cstDateCompact(): string {
  const iso = nowCstIsoLike();
  return iso.slice(0, 10).replace(/-/g, '');
}

function parseToDateAssumeCst(input: string): Date | null {
  const s = String(input || '').trim();
  if (!s) return null;
  // date-only: keep as-is (display layer may not need Date)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+08:00`);
  // sqlite default: YYYY-MM-DD HH:mm:ss  (we treat as CST local time)
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T') + '+08:00');
  }
  // ISO-like without timezone: assume CST
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s + '+08:00');
  }
  // ISO with timezone (Z / ±hh:mm)
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function formatDateToCstYmdHms(d: Date): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const y = get('year');
  const m = get('month');
  const day = get('day');
  const hh = get('hour');
  const mm = get('minute');
  const ss = get('second');
  if (!y || !m || !day) return fmt.format(d);
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/** 任意时间字符串 → 东八区展示（YYYY-MM-DD HH:mm:ss）；无法解析则原样返回 */
export function formatCstDisplay(input: string | null | undefined): string {
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';
  // date-only: keep
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = parseToDateAssumeCst(s);
  if (!d) return s;
  return formatDateToCstYmdHms(d);
}

/** 任意时间字符串 → 仅显示东八区日期（YYYY-MM-DD）；无法解析则尽力截取日期 */
export function formatCstDateOnly(input: string | null | undefined): string {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const full = formatCstDisplay(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(full)) return full;
  const m = /^(\d{4}-\d{2}-\d{2})\b/.exec(full);
  return m ? m[1] : full;
}

