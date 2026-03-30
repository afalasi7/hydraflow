import type {
  AccountRecord,
  ChildLoggingPolicy,
  FlaggedLoggingEvent,
  HydrationLogEntry,
  PersistedState,
  UserProfile,
} from "../types";

const STORAGE_KEY = "hydraflow-state-v1";
const VERSION = 1;

const defaultState: PersistedState = {
  version: VERSION,
  currentUserId: null,
  accounts: [],
};

const defaultPolicy: ChildLoggingPolicy = {
  guardrailsEnabled: true,
  suspiciousEntryMl: 500,
  burstLimitCount: 3,
  burstWindowMinutes: 2,
};

function normalizeAccount(account: AccountRecord): AccountRecord {
  return {
    ...account,
    childLoggingPolicy: {
      ...defaultPolicy,
      ...account.childLoggingPolicy,
    },
    flaggedEvents: Array.isArray(account.flaggedEvents) ? (account.flaggedEvents as FlaggedLoggingEvent[]) : [],
  };
}

function isBrowser() {
  return typeof window !== "undefined";
}

export function loadState(): PersistedState {
  if (!isBrowser()) {
    return defaultState;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultState;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (Array.isArray(parsed.accounts)) {
      return {
        version: VERSION,
        currentUserId: parsed.currentUserId ?? null,
        accounts: parsed.accounts.map((account) => normalizeAccount(account as AccountRecord)),
      };
    }

    return {
      version: VERSION,
      currentUserId: null,
      accounts: [],
    };
  } catch {
    return defaultState;
  }
}

export function saveState(next: PersistedState) {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function persistProfile(profile: UserProfile | null) {
  const current = loadState();
  if (!current.currentUserId) {
    return;
  }

  saveState({
    ...current,
    version: VERSION,
    accounts: current.accounts.map((account) =>
      account.id === current.currentUserId ? { ...account, profile } : account,
    ),
  });
}

export function persistEntries(entries: HydrationLogEntry[]) {
  const current = loadState();
  if (!current.currentUserId) {
    return;
  }

  saveState({
    ...current,
    version: VERSION,
    accounts: current.accounts.map((account) =>
      account.id === current.currentUserId ? { ...account, entries } : account,
    ),
  });
}

export function persistAccounts(accounts: AccountRecord[], currentUserId: string | null) {
  saveState({
    version: VERSION,
    accounts,
    currentUserId,
  });
}

export function clearAllState() {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}
