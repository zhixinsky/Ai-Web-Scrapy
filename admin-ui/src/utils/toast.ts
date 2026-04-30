export type AppToastTone = 'error' | 'warning' | 'info' | 'success';

export type AppToastDetail = {
  tone: AppToastTone;
  title?: string;
  message: string;
  timeoutMs?: number;
};

const EVENT_NAME = 'app-toast';

export function pushToast(detail: AppToastDetail) {
  if (typeof window === 'undefined') return;
  const message = String(detail.message || '').trim();
  if (!message) return;

  const payload = { ...detail, message };
  try {
    // Some embedded/legacy browsers don't support `new CustomEvent()`.
    if (typeof (window as any).CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
      return;
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof document !== 'undefined' && typeof document.createEvent === 'function') {
      const ev = document.createEvent('CustomEvent');
      ev.initCustomEvent(EVENT_NAME, false, false, payload);
      window.dispatchEvent(ev);
    }
  } catch {
    /* ignore */
  }
}

export function toastError(message: string, title = '操作失败', timeoutMs = 3500) {
  pushToast({ tone: 'error', title, message, timeoutMs });
}

export function toastSuccess(message: string, title = '完成', timeoutMs = 2400) {
  pushToast({ tone: 'success', title, message, timeoutMs });
}
