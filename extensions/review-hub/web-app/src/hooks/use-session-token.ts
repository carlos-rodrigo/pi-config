import { useEffect, useMemo, useRef } from "react";

const SESSION_TOKEN_KEY = "review-hub-session-token";

export function readSessionTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  return token ? token : null;
}

export function useSessionToken(search: string = window.location.search): {
  token: string | null;
  error: string | null;
} {
  const cleanedRef = useRef(false);

  const result = useMemo(() => {
    // 1. Try URL query param first (fresh open from pi)
    const urlToken = readSessionTokenFromSearch(search);
    if (urlToken) {
      // Persist to sessionStorage so it survives URL cleanup + refresh
      try { sessionStorage.setItem(SESSION_TOKEN_KEY, urlToken); } catch { /* noop */ }
      return { token: urlToken, error: null };
    }

    // 2. Fallback to sessionStorage (page refresh after URL cleanup)
    try {
      const stored = sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim();
      if (stored) {
        return { token: stored, error: null };
      }
    } catch { /* noop */ }

    return {
      token: null,
      error: "Missing session token. Open the Review Hub URL from pi.",
    };
  }, [search]);

  // Remove token from URL after capture to prevent leakage via history/referrer
  useEffect(() => {
    if (result.token && !cleanedRef.current) {
      cleanedRef.current = true;
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          window.history.replaceState({}, "", url.pathname + url.search + url.hash);
        }
      } catch {
        // Silently ignore — URL cleanup is best-effort
      }
    }
  }, [result.token]);

  return result;
}
