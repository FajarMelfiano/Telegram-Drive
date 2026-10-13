import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Api, ApiError, clearToken, getToken, setToken, setRefreshToken } from './api';
import { loadSession as loadLocalSession, unloadSession as unloadLocalSession } from './tg/localApi';
import {
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  deleteSession as deleteStoredSession,
  type StoredSession,
} from './tg/session';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  token: string | null;
  /** Nama tampilan dari Telegram (firstName). */
  me: string;
  /** Login sukses. `session` hanya diisi mode native; web (QR) hanya kirim refreshToken. */
  signIn: (token: string, refreshToken?: string, session?: StoredSession) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Menjaga satu sesi login: pulihkan token dari penyimpanan, validasi ke /me,
 * dan bersihkan bila token sudah ditolak (401).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [token, setTokenState] = useState<string | null>(null);
  const [me, setMe] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getToken();
      if (!stored) {
        if (!cancelled) setStatus('signedOut');
        return;
      }
      // Native: pulihkan sesi Telegram dari SecureStore → hidupkan gateway lokal
      // dulu, karena Api.me di native memanggil localApi (butuh gateway aktif).
      const savedSession = await loadStoredSession();
      if (savedSession) {
        await loadLocalSession(savedSession.apiId, savedSession.apiHash, savedSession.session)
          .catch(() => undefined);
      }
      try {
        const res = await Api.me(stored);
        if (!cancelled) {
          setTokenState(stored);
          setMe(res.me.firstName);
          setStatus('signedIn');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) await clearToken();
        if (!cancelled) setStatus('signedOut');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (next: string, refreshToken?: string, session?: StoredSession) => {
    await setToken(next);
    if (refreshToken) await setRefreshToken(refreshToken);
    if (session) {
      // Persistensi: simpan session string + hidupkan gateway lokal.
      await saveStoredSession(session);
      await loadLocalSession(session.apiId, session.apiHash, session.session).catch(() => undefined);
    }
    const res = await Api.me(next);
    setTokenState(next);
    setMe(res.me.firstName);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    try { await Api.logout(token); } catch { /* sesi mungkin sudah ditutup server */ }
    unloadLocalSession();
    await deleteStoredSession();
    await clearToken();
    setTokenState(null);
    setMe('');
    setStatus('signedOut');
  }, [token]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, token, me, signIn, signOut }),
    [status, token, me, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}
