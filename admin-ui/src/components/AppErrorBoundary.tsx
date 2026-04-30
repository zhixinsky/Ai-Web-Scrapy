import React from 'react';

export default class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error) {
    // Keep it simple: show on screen, and also log to console for debugging.
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary]', err);
  }

  render() {
    if (!this.state.err) return this.props.children;
    const msg = this.state.err?.message || 'Unknown error';
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7faf9] px-4 text-slate-700">
        <div className="w-full max-w-xl rounded-3xl border border-rose-200/80 bg-white/90 p-6 shadow-sm ring-1 ring-rose-100 backdrop-blur">
          <div className="text-sm font-semibold text-rose-800">页面发生错误</div>
          <div className="mt-2 break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-900 ring-1 ring-rose-100">
            {msg}
          </div>
          <button
            type="button"
            className="mt-4 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

