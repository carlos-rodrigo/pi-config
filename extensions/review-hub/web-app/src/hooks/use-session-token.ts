import { useMemo } from "react";

export function readSessionTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  return token ? token : null;
}

export function useSessionToken(search: string = window.location.search): {
  token: string | null;
  error: string | null;
} {
  return useMemo(() => {
    const token = readSessionTokenFromSearch(search);
    if (!token) {
      return {
        token: null,
        error: "Missing session token. Open the Review Hub URL from pi.",
      };
    }

    return { token, error: null };
  }, [search]);
}
