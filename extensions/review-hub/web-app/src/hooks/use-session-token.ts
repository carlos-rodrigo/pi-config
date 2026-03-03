import { useEffect, useMemo, useRef } from "react";

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
    const token = readSessionTokenFromSearch(search);
    if (!token) {
      return {
        token: null,
        error: "Missing session token. Open the Review Hub URL from pi.",
      };
    }

    return { token, error: null };
  }, [search]);

  // Remove token from URL after capture to prevent leakage via history/referrer
  useEffect(() => {
    if (result.token && !cleanedRef.current) {
      cleanedRef.current = true;
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      } catch {
        // Silently ignore — URL cleanup is best-effort
      }
    }
  }, [result.token]);

  return result;
}
