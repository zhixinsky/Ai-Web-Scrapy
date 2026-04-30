import { useEffect, useRef, useState } from 'react';
import AppAlert from './AppAlert';
import type { AppToastDetail } from '../utils/toast';

type ToastItem = AppToastDetail & {
  id: string;
};

const EVENT_NAME = 'app-toast';

function nextId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export default function AppToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timeoutsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const onToast = (e: Event) => {
      const ce = e as CustomEvent<AppToastDetail>;
      const d = ce.detail;
      if (!d || typeof d.message !== 'string') return;
      const message = d.message.trim();
      if (!message) return;

      const id = nextId();
      const item: ToastItem = {
        id,
        tone: d.tone,
        title: d.title,
        message,
        timeoutMs: d.timeoutMs,
      };

      setItems((prev) => {
        const next = [...prev, item];
        // keep the newest few toasts
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      const ms = typeof d.timeoutMs === 'number' && d.timeoutMs > 0 ? d.timeoutMs : 3200;
      const t = window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== id));
        timeoutsRef.current.delete(id);
      }, ms);
      timeoutsRef.current.set(id, t);
    };

    window.addEventListener(EVENT_NAME, onToast as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, onToast as EventListener);
      for (const t of timeoutsRef.current.values()) window.clearTimeout(t);
      timeoutsRef.current.clear();
    };
  }, []);

  function close(id: string) {
    const t = timeoutsRef.current.get(id);
    if (typeof t === 'number') window.clearTimeout(t);
    timeoutsRef.current.delete(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[320] w-[min(26rem,calc(100vw-1rem))] space-y-3">
      {items.map((it) => (
        <div key={it.id} className="pointer-events-auto">
          <AppAlert
            tone={it.tone}
            title={it.title}
            onClose={() => close(it.id)}
            compact
            className="shadow-md"
          >
            {it.message}
          </AppAlert>
        </div>
      ))}
    </div>
  );
}

