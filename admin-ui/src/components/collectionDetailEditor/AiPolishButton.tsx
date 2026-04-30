export function AiPolishButton({
  mimoConfig,
  loading,
  disabled,
  title,
  onClick,
}: {
  /** null=尚未拉取状态，仍可点击重试；false=已知未配置；true=已配置 */
  mimoConfig: boolean | null;
  loading: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void | Promise<void>;
}) {
  const hint =
    mimoConfig === false
      ? '服务端未配置当前默认 AI Provider 的 API Key，请在 server/.env 配置后重试'
      : mimoConfig === null
        ? '正在检测 AI 配置，可直接点击生成（若失败请检查网络与登录状态）'
        : title;
  return (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-violet-200 bg-violet-50 px-2 text-xs font-semibold leading-none text-violet-800 shadow-sm hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-45"
      title={hint}
      disabled={disabled || loading}
      onClick={() => void onClick()}
    >
      {loading ? '…' : 'AI处理'}
    </button>
  );
}

