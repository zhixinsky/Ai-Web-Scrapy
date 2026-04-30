import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { canAccessModule, type UserInfo } from '../api';
import AppChromeBackground from '../components/AppChromeBackground';
import BrandLogo from '../components/BrandLogo';

const SIDEBAR_COLLAPSED_KEY = 'admin-sidebar-collapsed';

function linkStyle(isActive: boolean, collapsed: boolean) {
  const layout = collapsed
    ? 'group relative flex items-center justify-center overflow-hidden rounded-2xl px-2 py-3 text-sm font-semibold transition-all duration-300 ease-out'
    : 'group relative flex items-center gap-3 overflow-hidden rounded-2xl px-3 py-2.5 text-sm font-semibold transition-all duration-300 ease-out';
  const state = isActive
    ? 'bg-gradient-to-r from-teal-600 via-emerald-600 to-cyan-600 text-white shadow-lg shadow-teal-700/20 ring-1 ring-white/45'
    : 'text-slate-600 hover:-translate-y-0.5 hover:bg-white/70 hover:text-teal-900 hover:shadow-md hover:shadow-teal-900/5 hover:ring-1 hover:ring-teal-100/80';
  return `${layout} ${state}`;
}

function navIconCls(isActive: boolean, collapsed: boolean) {
  const size = collapsed ? 'h-6 w-6' : 'h-5 w-5';
  return `${size} shrink-0 ${
    isActive ? 'text-white' : 'text-teal-600 opacity-90 group-hover:text-teal-700'
  }`;
}

function navActiveGlow(isActive: boolean) {
  return isActive ? (
    <span
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_15%,rgba(255,255,255,0.42),transparent_34%)]"
      aria-hidden
    />
  ) : null;
}

function IconImages({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
      />
    </svg>
  );
}

function IconCollections({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function IconArchive({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.25 7.5H3.75m15.75 0l-1.06 11.119A2.25 2.25 0 0116.45 20.7H7.55a2.25 2.25 0 01-2.24-2.081L4.25 7.5m15.75 0V5.625A1.125 1.125 0 0018.875 4.5H5.125A1.125 1.125 0 004 5.625V7.5m5.25 4.5h5.5"
      />
    </svg>
  );
}

function IconRules({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.438.985s.145.745.438.985l1.003.827c.424.35.534.954.26 1.431l-1.296 2.247a1.125 1.125 0 01-1.37.49l-1.217-.456c-.355-.133-.75-.072-1.076.124-.072.044-.146.087-.22.127-.332.183-.582.495-.645.87l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a9.52 9.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.437-.985s-.145-.745-.437-.985l-1.004-.827a1.125 1.125 0 01-.26-1.431l1.297-2.247a1.125 1.125 0 011.37-.49l1.216.456c.356.133.751.072 1.076-.124.072-.044.145-.087.22-.127.332-.183.582-.495.644-.87l.213-1.281z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconMapping({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 6.75h9m-9 4.5h9m-9 4.5h4.5M19.5 7.5l2.25 2.25M21.75 9.75l-6.75 6.75H12v-3l6.75-6.75a2.121 2.121 0 013 0z"
      />
    </svg>
  );
}

function IconUsers({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
      />
    </svg>
  );
}

function IconLogout({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
      />
    </svg>
  );
}

function IconAccount({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) {
  return (
    <svg
      className={navIconCls(isActive, collapsed)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 20.25a7.5 7.5 0 0115 0" />
    </svg>
  );
}

function membershipBadgeMeta(
  planIdRaw: unknown,
  isAdmin: boolean
): { text: string; className: string } {
  if (isAdmin) {
    return { text: '管理员', className: 'bg-violet-100 text-violet-900 ring-1 ring-violet-200' };
  }
  const pid = String(planIdRaw || '').trim().toLowerCase();
  if (pid === 'lite') return { text: '轻享会员', className: 'bg-sky-100 text-sky-900 ring-1 ring-sky-200' };
  if (pid === 'pro') return { text: '专业会员', className: 'bg-amber-100 text-amber-900 ring-1 ring-amber-200' };
  if (pid === 'studio') return { text: '工作室会员', className: 'bg-rose-100 text-rose-900 ring-1 ring-rose-200' };
  return { text: '体验会员', className: 'bg-emerald-100 text-emerald-900 ring-1 ring-emerald-200' };
}

export default function AppShell({
  user,
  onLogout,
  children,
}: {
  user: UserInfo;
  onLogout: () => void;
  children: ReactNode;
}) {
  const isAdmin = user.role === 'admin';
  const can = (mod: string) => canAccessModule(user, mod);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  const collapsed = sidebarCollapsed;
  const location = useLocation();

  return (
    <div className="relative flex h-[100dvh] min-h-0 w-full overflow-hidden bg-[#edf7f4]">
      <AppChromeBackground />

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside
          className={`m-3 mr-0 flex shrink-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/65 bg-white/55 shadow-[0_24px_70px_-34px_rgba(15,118,110,0.55)] ring-1 ring-teal-900/5 backdrop-blur-2xl transition-[width,transform,box-shadow] duration-300 ease-out ${
            collapsed ? 'w-[4.5rem]' : 'w-56'
          }`}
        >
          <div
            className={`shrink-0 border-b border-white/60 bg-white/25 ${collapsed ? 'px-2 py-3' : 'px-4 py-4'}`}
          >
            {collapsed ? (
              <div className="flex flex-col items-center gap-2">
                <div title="AI数据采集系统">
                  <BrandLogo className="h-7 w-7 object-contain" />
                </div>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  className="rounded-xl p-1.5 text-slate-400 transition hover:-translate-y-0.5 hover:bg-white/70 hover:text-teal-700 hover:shadow-sm"
                  title="展开侧边栏"
                  aria-label="展开侧边栏"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="relative px-1 pb-1 pt-0.5">
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="absolute right-0 top-0 rounded-xl p-1 text-slate-400 transition hover:-translate-y-0.5 hover:bg-white/70 hover:text-teal-700 hover:shadow-sm"
                  title="收起侧边栏（仅显示图标）"
                  aria-label="收起侧边栏"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                  </svg>
                </button>
                <div className="flex items-center justify-start gap-2 pl-1 pr-7">
                  <BrandLogo className="h-6 w-6 shrink-0 object-contain sm:h-7 sm:w-7" />
                  <h1 className="bg-gradient-to-r from-teal-950 via-teal-800 to-emerald-700 bg-clip-text text-center text-xs font-black leading-snug tracking-tight text-transparent sm:text-[13px]">
                    AI数据采集系统
                  </h1>
                </div>
              </div>
            )}
          </div>

          <nav className={`min-h-0 flex-1 overflow-y-auto ${collapsed ? 'p-2' : 'p-3'}`}>
            <div className="flex flex-col gap-2">
              {can('collections') && (
                <NavLink
                  to="/collections"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '采集数据' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconCollections isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">采集数据</span>}
                    </>
                  )}
                </NavLink>
              )}
              {can('images') && (
                <NavLink
                  to="/images"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '图片资源' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconImages isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">图片资源</span>}
                    </>
                  )}
                </NavLink>
              )}
              {can('collections') && (
                <NavLink
                  to="/archives"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '数据归档' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconArchive isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">数据归档</span>}
                    </>
                  )}
                </NavLink>
              )}
              {can('rules') && (
                <NavLink
                  to="/rules"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '采集规则' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconRules isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">采集规则</span>}
                    </>
                  )}
                </NavLink>
              )}
              {can('export-mapping') && (
                <NavLink
                  to="/export-mapping"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '导出映射' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconMapping isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">导出映射</span>}
                    </>
                  )}
                </NavLink>
              )}
              {isAdmin && (
                <NavLink
                  to="/users"
                  className={({ isActive }) => linkStyle(isActive, collapsed)}
                  title={collapsed ? '用户权限' : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {navActiveGlow(isActive)}
                      <IconUsers isActive={isActive} collapsed={collapsed} />
                      {!collapsed && <span className="relative truncate tracking-[2px]">用户权限</span>}
                    </>
                  )}
                </NavLink>
              )}
              <NavLink
                to="/account"
                className={({ isActive }) => linkStyle(isActive, collapsed)}
                title={collapsed ? '个人信息' : undefined}
              >
                {({ isActive }) => (
                  <>
                    {navActiveGlow(isActive)}
                    <IconAccount isActive={isActive} collapsed={collapsed} />
                    {!collapsed && <span className="relative truncate tracking-[2px]">个人信息</span>}
                  </>
                )}
              </NavLink>
            </div>
          </nav>

          <div
            className={`shrink-0 space-y-3 border-t border-white/60 bg-white/25 ${collapsed ? 'p-2' : 'p-3'}`}
          >
            {!collapsed ? (
              <div className="space-y-0.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 truncate font-medium text-slate-800" title={user.username}>
                    {user.username}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${membershipBadgeMeta((user as any).planId, isAdmin).className}`}
                    title={membershipBadgeMeta((user as any).planId, isAdmin).text}
                  >
                    {membershipBadgeMeta((user as any).planId, isAdmin).text}
                  </span>
                </div>
                <div className="leading-relaxed text-slate-500">
                  {isAdmin ? '管理员' : '普通用户'}
                  {user.validTo && <span className="ml-1">· 至 {user.validTo}</span>}
                </div>
              </div>
            ) : (
              <div
                className="px-0.5 text-center"
                title={`${user.username} · ${membershipBadgeMeta((user as any).planId, isAdmin).text} · ${isAdmin ? '管理员' : '普通用户'}${
                  user.validTo ? ` · 至 ${user.validTo}` : ''
                }`}
              >
                <div className="truncate text-[11px] font-medium leading-tight text-slate-800">{user.username}</div>
                <div
                  className={`mt-1 inline-flex max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${membershipBadgeMeta((user as any).planId, isAdmin).className}`}
                >
                  {membershipBadgeMeta((user as any).planId, isAdmin).text}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={onLogout}
              title="退出登录"
              className={`flex w-full items-center justify-center rounded-2xl border border-white/70 bg-white/55 text-sm text-slate-600 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-teal-200 hover:bg-white/80 hover:text-teal-800 hover:shadow-md ${
                collapsed ? 'p-2.5' : 'gap-2 px-3 py-2'
              }`}
            >
              <IconLogout className={`shrink-0 text-teal-600/80 ${collapsed ? 'h-6 w-6' : 'h-5 w-5'}`} />
              {!collapsed && <span>退出登录</span>}
            </button>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
          <div
            key={location.pathname}
            className="app-page-enter relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2rem] border border-white/65 bg-white/45 p-4 shadow-[0_28px_90px_-48px_rgba(15,23,42,0.55)] ring-1 ring-teal-900/5 backdrop-blur-2xl sm:p-5"
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
