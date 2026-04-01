import type { AccountRecord } from "../types";

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error((data as { error?: string }).error || "Request failed.");
  }

  return data;
}

export async function loadServerSession() {
  const response = await fetch("/api/auth/session", {
    credentials: "include",
  });

  if (response.status === 401) {
    return null;
  }

  return readJson<{ account: AccountRecord }>(response);
}

export async function signUpWithServer(payload: { name: string; email: string; password: string }) {
  const response = await fetch("/api/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  return readJson<{ account: AccountRecord }>(response);
}

export async function signInWithServer(payload: { email: string; password: string }) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  return readJson<{ account: AccountRecord }>(response);
}

export async function signOutServer() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("Unable to sign out.");
  }
}

export async function saveServerAccount(account: AccountRecord) {
  const response = await fetch("/api/account", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ account }),
  });

  return readJson<{ account: AccountRecord }>(response);
}
