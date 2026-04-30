import { Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  api,
  canAccessModule,
  getToken,
  homePathForUser,
  setToken,
  type UserInfo,
} from './api';
import LoginPage from './pages/LoginPage';
import AppShell from './layout/AppShell';
import AppChromeBackground from './components/AppChromeBackground';
import CollectionsPage from './pages/CollectionsPage';
import RulesPage from './pages/RulesPage';
import RuleEditPage from './pages/RuleEditPage';
import UsersPage from './pages/UsersPage';
import ImagesPage from './pages/ImagesPage';
import ExportMappingPage from './pages/ExportMappingPage';
import AccountPage from './pages/AccountPage';
import AppToastHost from './components/AppToastHost';

function NoModuleAccess() {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-amber-200/80 bg-amber-50/90 p-6 text-sm leading-relaxed text-amber-950 shadow-sm">
      <p className="font-medium">暂无可用的功能模块</p>
      <p className="mt-2 text-amber-900/90">
        请联系管理员在「用户权限管理」中为您的账号勾选需要使用的模块。
      </p>
    </div>
  );
}

function normalizeUser(u: UserInfo): UserInfo {
  return {
    ...u,
    allowedModules: Array.isArray(u.allowedModules)
      ? u.allowedModules
      : ['collections', 'images'],
  };
}

function ModuleRoute({
  user,
  mod,
  children,
}: {
  user: UserInfo;
  mod: string;
  children: React.ReactNode;
}) {
  if (!canAccessModule(user, mod)) {
    return <Navigate to={homePathForUser(user)} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    const onExpire = () => setUser(null);
    window.addEventListener('auth-expired', onExpire);
    return () => window.removeEventListener('auth-expired', onExpire);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((u) => setUser(normalizeUser(u)))
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function onLogin(token: string, u: UserInfo) {
    setToken(token);
    setUser(null);
    setLoading(true);
    try {
      const full = await api.me();
      setUser(normalizeUser(full));
    } catch {
      // 登录接口返回的 user 可能缺少 planId 等字段，这里兜底用它先进入系统
      setUser(normalizeUser(u));
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  if (loading) {
    return (
      <>
        <AppToastHost />
        <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7faf9] text-slate-500">
          <AppChromeBackground />
          <span className="relative z-10 text-sm">加载中…</span>
        </div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <AppToastHost />
        <LoginPage onLogin={onLogin} />
      </>
    );
  }

  const home = homePathForUser(user);

  return (
    <>
      <AppToastHost />
      <AppShell user={user} onLogout={logout}>
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/no-access" element={<NoModuleAccess />} />
          <Route
            path="/collections"
            element={
              <ModuleRoute user={user} mod="collections">
                <CollectionsPage user={user} mode="active" />
              </ModuleRoute>
            }
          />
          <Route
            path="/archives"
            element={
              <ModuleRoute user={user} mod="collections">
                <CollectionsPage user={user} mode="archived" />
              </ModuleRoute>
            }
          />
          <Route
            path="/images"
            element={
              <ModuleRoute user={user} mod="images">
                <ImagesPage user={user} />
              </ModuleRoute>
            }
          />
          <Route
            path="/rules"
            element={
              <ModuleRoute user={user} mod="rules">
                <RulesPage />
              </ModuleRoute>
            }
          />
          <Route
            path="/rules/new"
            element={
              <ModuleRoute user={user} mod="rules">
                <RuleEditPage />
              </ModuleRoute>
            }
          />
          <Route
            path="/rules/:id"
            element={
              <ModuleRoute user={user} mod="rules">
                <RuleEditPage />
              </ModuleRoute>
            }
          />
          <Route
            path="/export-mapping"
            element={
              <ModuleRoute user={user} mod="export-mapping">
                <ExportMappingPage user={user} />
              </ModuleRoute>
            }
          />
          <Route
            path="/users"
            element={user.role === 'admin' ? <UsersPage /> : <Navigate to={home} replace />}
          />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </AppShell>
    </>
  );
}
