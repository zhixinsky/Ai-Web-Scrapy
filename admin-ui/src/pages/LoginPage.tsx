import { useEffect, useState } from 'react';
import { api, type UserInfo } from '../api';
import AppChromeBackground from '../components/AppChromeBackground';
import BrandLogo from '../components/BrandLogo';
import { toastError } from '../utils/toast';

export default function LoginPage({
  onLogin,
}: {
  onLogin: (token: string, user: UserInfo) => void | Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!err) return;
    toastError(err, '登录失败');
    setErr('');
  }, [err]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const res = await api.login(username.trim(), password);
      await onLogin(res.token, res.user);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#f7faf9]">
      <AppChromeBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-[400px]">
          <div className="rounded-3xl border border-white/80 bg-white/85 px-8 py-10 shadow-[0_20px_50px_-12px_rgba(15,118,110,0.12),0_8px_24px_-8px_rgba(15,23,42,0.08)] backdrop-blur-sm ring-1 ring-teal-950/[0.04]">
            <div className="mx-auto flex justify-center">
              <BrandLogo className="h-14 w-auto max-w-[220px] object-contain" />
            </div>
            <h1 className="mt-6 text-center text-[1.35rem] font-semibold tracking-tight text-slate-800">
              AI数据采集系统
            </h1>
            <p className="mt-1.5 text-center text-sm font-normal text-slate-500">
              使用已开通的账号登录系统
            </p>

            <form className="mt-8 space-y-5" onSubmit={submit}>
              <div className="space-y-1.5">
                <label htmlFor="login-username" className="block text-xs font-medium text-slate-600">
                  用户名
                </label>
                <input
                  id="login-username"
                  className="w-full rounded-xl border border-slate-200/90 bg-white/90 px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-teal-300/90 focus:ring-2 focus:ring-teal-100"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="请输入用户名"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="login-password" className="block text-xs font-medium text-slate-600">
                  密码
                </label>
                <input
                  id="login-password"
                  type="password"
                  className="w-full rounded-xl border border-slate-200/90 bg-white/90 px-3.5 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-teal-300/90 focus:ring-2 focus:ring-teal-100"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                />
              </div>
              {/* errors are shown as toasts (top-right) */}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 py-3 text-sm font-semibold text-white shadow-md shadow-teal-600/20 transition hover:from-teal-500 hover:to-emerald-500 hover:shadow-lg hover:shadow-teal-600/25 disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none"
              >
                {loading ? '登录中…' : '登 录'}
              </button>
            </form>
          </div>

          <div className="mt-8 space-y-2 px-1 text-center text-[11px] leading-relaxed text-slate-500/95 sm:text-xs">
            <p className="text-slate-500">本系统账号仅供授权人员使用，请勿转借、共享或用于非授权用途。</p>
            <p className="text-slate-400">
              开通账号、权限变更、有效期与密码问题，请联系系统管理员处理。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
