import type {
  AccountRecord,
  ChildLoggingPolicy,
  FlaggedLoggingEvent,
  HydrationLogEntry,
  MemberProfileRecord,
  PersistedState,
  ReminderSettings,
  UserProfile,
} from "../types";

const STORAGE_KEY = "hydraflow-state-v1";
const VERSION = 5;

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

const defaultReminderSettings: ReminderSettings = {
  enabled: false,
  times: ["09:00", "13:00", "18:00"],
  permission: "default",
};

type LegacyAccountRecord = Partial<AccountRecord> & {
  profile?: UserProfile | null;
  entries?: HydrationLogEntry[];
  childLoggingPolicy?: ChildLoggingPolicy;
  flaggedEvents?: FlaggedLoggingEvent[];
  subscription?: {
    tier?: string;
  };
};

function createLegacyPrimaryProfile(account: LegacyAccountRecord): MemberProfileRecord {
  return {
    id: `profile-${account.id ?? Date.now()}`,
    name: account.name?.trim() || "Primary profile",
    createdAt: account.createdAt ?? new Date().toISOString(),
    profile: account.profile ?? null,
    entries: Array.isArray(account.entries) ? account.entries : [],
    childLoggingPolicy: {
      ...defaultPolicy,
      ...account.childLoggingPolicy,
    },
    flaggedEvents: Array.isArray(account.flaggedEvents) ? account.flaggedEvents : [],
  };
}

function normalizeAccount(account: LegacyAccountRecord): AccountRecord {
  const profiles = Array.isArray(account.profiles) && account.profiles.length > 0
    ? account.profiles.map((profile) => ({
        ...profile,
        name: profile.name?.trim() || "Profile",
        createdAt: profile.createdAt ?? new Date().toISOString(),
        profile: profile.profile ?? null,
        entries: Array.isArray(profile.entries) ? profile.entries : [],
        childLoggingPolicy: {
          ...defaultPolicy,
          ...profile.childLoggingPolicy,
        },
        flaggedEvents: Array.isArray(profile.flaggedEvents) ? profile.flaggedEvents : [],
      }))
    : [createLegacyPrimaryProfile(account)];
  const activeProfileId =
    typeof account.activeProfileId === "string" && profiles.some((profile) => profile.id === account.activeProfileId)
      ? account.activeProfileId
      : profiles[0]?.id ?? null;

  return {
    id: account.id ?? `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: account.name?.trim() || "HydraFlow User",
    email: account.email?.trim() || "",
    password: account.password ?? "",
    createdAt: account.createdAt ?? new Date().toISOString(),
    profiles,
    activeProfileId,
    authProvider: account.authProvider ?? (account.remoteUserId ? "supabase" : "local"),
    remoteUserId: account.remoteUserId ?? null,
    reminderSettings: {
      ...defaultReminderSettings,
      ...account.reminderSettings,
      times:
        Array.isArray(account.reminderSettings?.times) && account.reminderSettings.times.length > 0
          ? account.reminderSettings.times
          : defaultReminderSettings.times,
    },
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
