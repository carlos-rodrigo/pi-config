import { useEffect, useMemo, useRef } from "react";

const SESSION_TOKEN_KEY = "review-hub-session-token";

export function readSessionTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  return token ? token : null;
}

export function readSessionTokenFromPath(pathname: string): string | null {
  // Supports /t/<token> URL form
  const match = pathname.match(/^\/t\/([^/]+)$/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]).trim();
  return token ? token : null;
}

export function readSessionTokenFromHash(hash: string): string | null {
  // Supports #token=<token> as an additional fallback
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(value);
  const token = params.get("token")?.trim();
  return token ? token : null;
}

export function useSessionToken(search: string = window.location.search): {
  token: string | null;
  error: string | null;
} {
  const cleanedRef = useRef(false);

  const result = useMemo(() => {
    // 1. Try URL-provided token forms (query, path, hash)
    const urlToken =
      readSessionTokenFromSearch(search) ||
      readSessionTokenFromPath(window.location.pathname) ||
      readSessionTokenFromHash(window.location.hash);

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
        let changed = false;

        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          changed = true;
        }

        if (readSessionTokenFromPath(url.pathname)) {
          url.pathname = "/";
          changed = true;
        }

        if (readSessionTokenFromHash(url.hash)) {
          url.hash = "";
          changed = true;
        }

        if (changed) {
          window.history.replaceState({}, "", url.pathname + url.search + url.hash);
        }
      } catch {
        // Silently ignore — URL cleanup is best-effort
      }
    }
  }, [result.token]);

  return result;
}
