import { createClient } from "@supabase/supabase-js";
import type { AccountRecord } from "../types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";
const supabaseClientKey = supabasePublishableKey || supabaseAnonKey;

let client: ReturnType<typeof createClient> | null = null;

function normalizeSupabaseError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PGRST205"
  ) {
    return new Error("Supabase is connected, but the HydraFlow table is missing. Run supabase/schema.sql in the Supabase SQL editor.");
  }

  return error instanceof Error ? error : new Error("Supabase request failed.");
}

function getClient() {
  if (!supabaseUrl || !supabaseClientKey) {
    throw new Error("Supabase is not configured for this build.");
  }

  client ??= createClient(supabaseUrl, supabaseClientKey);
  return client;
}

function sanitizeAccountForSync(account: AccountRecord): AccountRecord {
  return {
    ...account,
    password: "",
  };
}

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseClientKey);
}

export function subscribeToCloudAuthChanges(
  callback: Parameters<ReturnType<typeof getClient>["auth"]["onAuthStateChange"]>[0],
) {
  return getClient().auth.onAuthStateChange(callback);
}

export async function signUpWithCloud(email: string, password: string, name: string) {
  return getClient().auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
      },
    },
  });
}

export async function signInWithCloud(email: string, password: string) {
  return getClient().auth.signInWithPassword({ email, password });
}

export async function signOutCloud() {
  return getClient().auth.signOut();
}

export async function getCloudSession() {
  return getClient().auth.getSession();
}

export async function loadRemoteAccount(remoteUserId: string) {
  const { data, error } = await getClient()
    .from("account_states")
    .select("payload")
    .eq("user_id", remoteUserId)
    .maybeSingle();

  if (error) {
    throw normalizeSupabaseError(error);
  }

  if (!data || typeof data !== "object" || !("payload" in data)) {
    return null;
  }

  return (data as { payload: AccountRecord }).payload;
}

export async function saveRemoteAccount(account: AccountRecord) {
  if (!account.remoteUserId) {
    throw new Error("A remote user id is required before syncing.");
  }

  const { error } = await getClient().from("account_states").upsert({
    user_id: account.remoteUserId,
    payload: sanitizeAccountForSync(account),
    updated_at: new Date().toISOString(),
  } as never);

  if (error) {
    throw normalizeSupabaseError(error);
  }
}
