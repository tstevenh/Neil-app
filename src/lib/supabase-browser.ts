import { createClient } from "@supabase/supabase-js";

let client: ReturnType<typeof createClient> | null = null;
const SESSION_REQUEST_TIMEOUT_MS = 8_000;
const SESSION_REFRESH_TIMEOUT_MS = 10_000;
const SIGN_IN_REQUEST_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function getSupabaseBrowser() {
  if (client) {
    return client;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  client = createClient(url, anonKey);
  return client;
}

export async function getBrowserSession() {
  return withTimeout(getSupabaseBrowser().auth.getSession(), "Supabase session request", SESSION_REQUEST_TIMEOUT_MS);
}

export async function refreshBrowserSession() {
  return withTimeout(
    getSupabaseBrowser().auth.refreshSession(),
    "Supabase session refresh",
    SESSION_REFRESH_TIMEOUT_MS,
  );
}

export async function signInWithBrowserPassword(email: string, password: string) {
  return withTimeout(
    getSupabaseBrowser().auth.signInWithPassword({ email, password }),
    "Supabase sign-in request",
    SIGN_IN_REQUEST_TIMEOUT_MS,
  );
}
