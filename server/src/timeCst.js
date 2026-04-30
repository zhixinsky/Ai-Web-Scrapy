function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 固定东八区（UTC+8）时间，不依赖容器/系统时区。
 * 返回 ISO-like：YYYY-MM-DDTHH:mm:ss+08:00
 */
export function nowCstIso() {
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

