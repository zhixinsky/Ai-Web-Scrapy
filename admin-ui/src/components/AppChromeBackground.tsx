/** 与登录页一致的底纹与光晕，供登录后布局复用 */
export default function AppChromeBackground() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,#eef8f3_0%,#f8fbff_42%,#f6f7ef_100%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(#7aa99a_0.55px,transparent_0.55px)] [background-size:22px_22px] opacity-[0.22]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-32 top-20 h-72 w-72 rounded-full bg-teal-300/30 blur-3xl app-orb-drift"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-24 bottom-24 h-80 w-80 rounded-full bg-sky-300/25 blur-3xl app-orb-drift app-orb-drift-slow"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-200/20 blur-3xl app-orb-pulse"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-8 top-8 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"
        aria-hidden
      />
    </>
  );
}
