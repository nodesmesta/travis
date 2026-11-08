import { getSupabaseBrowserClient } from "./supabase/browser";

/**
 * Email and password sign-in is for local development and the browser test scripts,
 * which cannot drive Google's consent screen. The form is rendered only when this flag
 * is "true". Without it (the production setup) the form is not shown, although its code
 * is still part of the page bundle. The deployed Supabase Auth server is what actually
 * refuses password sign-in, so hiding the form is a courtesy, not the protection.
 */
export const passwordLoginEnabled =
  process.env.NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN === "true";

/** Sends the browser to Google. On success the page navigates away. */
export async function startGoogleSignIn(): Promise<void> {
  const { error } = await getSupabaseBrowserClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/` },
  });
  if (error) throw error;
}

const MAX_DETAIL_LENGTH = 160;

/**
 * Supabase Auth sends the user back with `error`, `error_code` and
 * `error_description` when sign-in fails. They arrive in the query string (PKCE) or in
 * the hash (older flows). Returns a short message for the login screen, or null.
 */
export function readAuthRedirectError(href: string): string | null {
  const url = new URL(href);
  const hash = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  const pick = (name: string) =>
    url.searchParams.get(name) ?? hash.get(name) ?? null;

  const error = pick("error");
  const code = pick("error_code");
  const description = pick("error_description");
  if (!error && !code && !description) return null;

  if (error === "access_denied") {
    return "Google sign-in was cancelled. You can try again when you are ready.";
  }
  const detail = description?.trim().slice(0, MAX_DETAIL_LENGTH);
  return detail
    ? `Google sign-in did not complete: ${detail}`
    : "Google sign-in did not complete. Please try again.";
}
