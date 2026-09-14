import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, get } from './api';
import { t, type Lang } from './i18n';

export interface Me {
  administrator: { id: string; name: string; email: string; language: Lang; timezone: string };
  second_factor_complete: boolean;
  permissions: string[];
  environment: 'production' | 'sandbox';
  permission_catalogue: Record<string, string>;
}

interface SessionState { me: Me | null; loading: boolean; refresh: () => Promise<void>; has: (p: string) => boolean; lang: Lang; setLang: (l: Lang) => void }

const Ctx = createContext<SessionState>({ me: null, loading: true, refresh: async () => undefined, has: () => false, lang: 'en', setLang: () => undefined });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLangState] = useState<Lang>((localStorage.getItem('pp_lang') as Lang) || 'en');
  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>('/auth/me');
      setMe(m);
      if (m.administrator.language) { setLangState(m.administrator.language); localStorage.setItem('pp_lang', m.administrator.language); }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const setLang = (l: Lang) => { setLangState(l); localStorage.setItem('pp_lang', l); };
  return <Ctx.Provider value={{ me, loading, refresh, has: (p) => me?.permissions.includes(p) ?? false, lang, setLang }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
export const useT = () => { const { lang } = useSession(); return (key: string, vars?: Record<string, string | number>) => t(lang, key, vars); };
