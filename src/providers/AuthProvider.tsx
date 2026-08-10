"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

import {
  refreshDelayMs,
  refreshRetryDelayMs,
  shouldClearAuthState,
} from "./auth-core";

type User = { email: string; name: string; picture?: string };

type AuthContextType = {
  user: User | null;
  isReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextType>(null!);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [refreshAt, setRefreshAt] = useState<number | null>(null);

  const clearAuthState = useCallback(() => {
    setUser(null);
    setRefreshAt(null);
  }, []);

  const scheduleTransientRetry = useCallback(() => {
    const delay = refreshRetryDelayMs();
    if (delay !== null) setRefreshAt(Date.now() + delay);
  }, []);

  const terminateSession = useCallback(() => {
    clearAuthState();
    if (window.location.pathname !== "/login") {
      window.location.replace("/login");
    }
  }, [clearAuthState]);

  const fetchUser = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/profile");
      if (res.ok) {
        setUser((await res.json()) as User);
        return true;
      }
      if (shouldClearAuthState(res.status)) {
        terminateSession();
      } else {
        scheduleTransientRetry();
      }
      return false;
    } catch {
      // Keep the last known profile during transient provider failures.
      scheduleTransientRetry();
      return false;
    }
  }, [scheduleTransientRetry, terminateSession]);

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST" });
      if (!res.ok) {
        if (shouldClearAuthState(res.status)) {
          terminateSession();
        } else {
          scheduleTransientRetry();
        }
        return false;
      }
      const data = (await res.json()) as { expiresIn?: unknown };
      const refreshDelay = refreshDelayMs(data.expiresIn);
      if (refreshDelay === null) {
        scheduleTransientRetry();
        return false;
      }
      setRefreshAt(Date.now() + refreshDelay);
      await fetchUser();
      return true;
    } catch {
      scheduleTransientRetry();
      return false;
    }
  }, [fetchUser, scheduleTransientRetry, terminateSession]);

  // 앱 마운트 시 세션 복원
  useEffect(() => {
    (async () => {
      try {
        await refreshToken();
      } finally {
        setIsReady(true);
      }
    })();
  }, [refreshToken]);

  useEffect(() => {
    if (refreshAt === null) return;
    const timer = window.setTimeout(
      () => void refreshToken(),
      Math.max(0, refreshAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [refreshAt, refreshToken]);

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "로그인 실패");
    }

    const data = (await res.json()) as { expiresIn?: unknown };
    const refreshDelay = refreshDelayMs(data.expiresIn);
    if (refreshDelay === null) throw new Error("로그인 실패");
    setRefreshAt(Date.now() + refreshDelay);
    await fetchUser();
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      clearAuthState();
      window.location.href = "/login";
    }
  };

  if (!isReady) return null;

  return (
    <AuthContext.Provider
      value={{ user, isReady, login, logout, refreshToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}
