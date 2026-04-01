import { startTransition, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  calculateTargetMl,
  formatDisplayAmount,
  formatLiters,
  formatMl,
  formatOz,
  getCupCountLabel,
  getEncouragement,
  getKidQuickAddOptions,
  getQuickAddOptions,
  getRecentDailyTotals,
  getTargetBreakdown,
  getTodayProgress,
  ozToMl,
} from "./lib/hydration";
import { downloadFamilyCsv, downloadProfileCsv } from "./lib/export";
import { clearAllState, loadState, persistAccounts } from "./lib/storage";
import {
  getCloudSession,
  isSupabaseConfigured,
  loadRemoteAccount,
  saveRemoteAccount,
  signInWithCloud,
  signOutCloud,
  signUpWithCloud,
  subscribeToCloudAuthChanges,
} from "./lib/supabase";
import type {
  AccountRecord,
  ActivityLevel,
  AuthMode,
  AuthProvider,
  ChildLoggingPolicy,
  ClimateLevel,
  DisplayUnits,
  FlaggedLoggingEvent,
  GuardrailReason,
  HydrationLogEntry,
  MemberProfileRecord,
  ReminderSettings,
  Screen,
  UserProfile,
  WeightUnit,
} from "./types";
import { getLocalDateKey } from "./lib/date";

const activityLabels: Record<ActivityLevel, string> = {
  low: "Mostly desk or light movement",
  moderate: "Walking, workouts, busy days",
  high: "Training, outdoors, intense movement",
};

const climateLabels: Record<ClimateLevel, string> = {
  cool: "Cool or air-conditioned",
  warm: "Warm and active",
  hot: "Hot, humid, or sun-heavy",
};

const screens: { id: Screen; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "◌" },
  { id: "history", label: "History", icon: "△" },
  { id: "settings", label: "Settings", icon: "□" },
];

const initialProfile: UserProfile = {
  weight: 70,
  age: 30,
  weightUnit: "kg",
  activityLevel: "moderate",
  climateLevel: "warm",
  preferredDisplayUnits: "dual",
};

const initialAuthForm = {
  name: "",
  email: "",
  password: "",
};

const defaultChildLoggingPolicy: ChildLoggingPolicy = {
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
const maxFreemiumProfiles = 6;

function createLogEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]): HydrationLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    amountMl,
    sourceType,
  };
}

function createProfileRecord(name: string): MemberProfileRecord {
  return {
    id: `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    createdAt: new Date().toISOString(),
    profile: null,
    entries: [],
    childLoggingPolicy: defaultChildLoggingPolicy,
    flaggedEvents: [],
  };
}

function createAccountRecord({
  id,
  name,
  email,
  password,
  authProvider,
  remoteUserId,
}: {
  id: string;
  name: string;
  email: string;
  password?: string;
  authProvider: AuthProvider;
  remoteUserId?: string | null;
}): AccountRecord {
  const primaryProfile = createProfileRecord(name);

  return {
    id,
    name,
    email,
    password: password ?? "",
    createdAt: new Date().toISOString(),
    profiles: [primaryProfile],
    activeProfileId: primaryProfile.id,
    authProvider,
    remoteUserId: remoteUserId ?? null,
    reminderSettings: defaultReminderSettings,
  };
}

function createRipple(event: ReactMouseEvent<HTMLElement>) {
  const target = event.currentTarget;
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function sanitizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getKidQuickAddLabel(amountMl: number) {
  if (amountMl <= 120) {
    return { title: "Tiny sip", subtitle: "A few happy gulps" };
  }

  if (amountMl <= 180) {
    return { title: "Small cup", subtitle: "A regular little cup" };
  }

  if (amountMl <= 250) {
    return { title: "Big cup", subtitle: "A taller cup of water" };
  }

  return { title: "Bottle", subtitle: "A full bottle boost" };
}

function getFirstName(name?: string | null) {
  if (!name) {
    return "there";
  }

  return name.trim().split(/\s+/)[0] || "there";
}

function getPlanLabel() {
  return "Freemium";
}

function formatReminderLabel(time: string) {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return time;
  }

  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2020, 0, 1, hour, minute));
}

function getProfileMeta(profile: MemberProfileRecord) {
  if (!profile.profile) {
    return "Needs setup";
  }

  const targetMl = calculateTargetMl(profile.profile);
  return `${profile.profile.age < 12 ? "Kid" : "Profile"} • ${formatDisplayAmount(targetMl, "dual")}`;
}

function createFlaggedEvent(
  childProfileId: string,
  attemptedAmountMl: number,
  triggerReason: GuardrailReason,
  sourceType: HydrationLogEntry["sourceType"],
): FlaggedLoggingEvent {
  return {
    id: `flag-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    childProfileId,
    attemptedAmountMl,
    timestamp: new Date().toISOString(),
    triggerReason,
    resolution: "pending",
    sourceType,
  };
}

function upsertAccount(current: AccountRecord[], nextAccount: AccountRecord) {
  const existingIndex = current.findIndex(
    (account) =>
      account.id === nextAccount.id ||
      (nextAccount.remoteUserId && account.remoteUserId === nextAccount.remoteUserId) ||
      sanitizeEmail(account.email) === sanitizeEmail(nextAccount.email),
  );

  if (existingIndex === -1) {
    return [...current, nextAccount];
  }

  const next = [...current];
  next[existingIndex] = nextAccount;
  return next;
}

export default function App() {
  const stored = useMemo(() => loadState(), []);
  const cloudAuthEnabled = useMemo(() => isSupabaseConfigured(), []);
  const [accounts, setAccounts] = useState<AccountRecord[]>(stored.accounts);
  const [currentUserId, setCurrentUserId] = useState<string | null>(stored.currentUserId);
  const currentAccount = useMemo(
    () => accounts.find((account) => account.id === currentUserId) ?? null,
    [accounts, currentUserId],
  );
  const activeProfile = useMemo(() => {
    if (!currentAccount) {
      return null;
    }

    return (
      currentAccount.profiles.find((profile) => profile.id === currentAccount.activeProfileId) ??
      currentAccount.profiles[0] ??
      null
    );
  }, [currentAccount]);
  const [authMode, setAuthMode] = useState<AuthMode>(
    currentAccount ? "landing" : stored.accounts.length > 0 ? "login" : "landing",
  );
  const [authForm, setAuthForm] = useState(initialAuthForm);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [profileDraft, setProfileDraft] = useState<UserProfile>(activeProfile?.profile ?? initialProfile);
  const [onboardingStep, setOnboardingStep] = useState(activeProfile?.profile ? 3 : 0);
  const [activeScreen, setActiveScreen] = useState<Screen>("today");
  const [customAmount, setCustomAmount] = useState("");
  const [isPointerDevice, setIsPointerDevice] = useState(false);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null);
  const [pendingFlaggedEvent, setPendingFlaggedEvent] = useState<FlaggedLoggingEvent | null>(null);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileCreatorOpen, setProfileCreatorOpen] = useState(false);
  const [reminderError, setReminderError] = useState("");
  const [lastReminderKey, setLastReminderKey] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [syncError, setSyncError] = useState("");

  const todayKey = getLocalDateKey(new Date());
  const profile = activeProfile?.profile ?? null;
  const entries = activeProfile?.entries ?? [];
  const childLoggingPolicy = activeProfile?.childLoggingPolicy ?? defaultChildLoggingPolicy;
  const flaggedEvents = activeProfile?.flaggedEvents ?? [];
  const targetSource = profile ?? profileDraft;
  const targetMl = calculateTargetMl(targetSource);
  const targetBreakdown = getTargetBreakdown(targetSource);
  const reminderSettings = currentAccount?.reminderSettings ?? defaultReminderSettings;
  const isAuthenticated = Boolean(currentAccount);
  const needsOnboarding = isAuthenticated && !profile;
  const maxProfiles = maxFreemiumProfiles;
  const profileCount = currentAccount?.profiles.length ?? 0;

  const todayEntries = useMemo(
    () =>
      entries
        .filter((entry) => getLocalDateKey(new Date(entry.timestamp)) === todayKey)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [entries, todayKey],
  );
  const todayProgressMl = getTodayProgress(entries, todayKey);
  const progressRatio = targetMl > 0 ? Math.min(todayProgressMl / targetMl, 1.15) : 0;
  const remainingMl = Math.max(targetMl - todayProgressMl, 0);
  const history = useMemo(() => getRecentDailyTotals(entries), [entries]);
  const isKidMode = targetSource.age < 12;
  const quickAdds = isKidMode ? getKidQuickAddOptions() : getQuickAddOptions(targetSource.preferredDisplayUnits);
  const completionLabel = getEncouragement(progressRatio);
  const firstName = getFirstName(activeProfile?.name ?? currentAccount?.name);
  const recentFlaggedEvents = flaggedEvents.slice(-5).reverse();
  const weekTotalMl = history.slice(0, 7).reduce((sum, day) => sum + day.totalMl, 0);
  const averageDailyMl = history.length > 0 ? Math.round(weekTotalMl / history.slice(0, 7).length) : 0;
  const consistencyScore = targetMl > 0 && history.length > 0 ? Math.min(100, Math.round((averageDailyMl / targetMl) * 100)) : 0;
  const streakDays = history.findIndex((day) => day.totalMl < targetMl * 0.8) === -1 ? history.length : history.findIndex((day) => day.totalMl < targetMl * 0.8);

  useEffect(() => {
    persistAccounts(accounts, currentUserId);
  }, [accounts, currentUserId]);

  useEffect(() => {
    const media = window.matchMedia("(pointer: fine)");
    const update = () => setIsPointerDevice(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      document.documentElement.style.setProperty("--cursor-x", `${event.clientX}px`);
      document.documentElement.style.setProperty("--cursor-y", `${event.clientY}px`);
    };

    if (!isPointerDevice) {
      return undefined;
    }

    window.addEventListener("pointermove", handleMove, { passive: true });
    return () => window.removeEventListener("pointermove", handleMove);
  }, [isPointerDevice]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event);
      setInstallPromptVisible(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    if (!currentAccount) {
      setProfileDraft(initialProfile);
      setOnboardingStep(0);
      setPendingFlaggedEvent(null);
      setReminderError("");
      setLastReminderKey(null);
      setSyncState("idle");
      setSyncError("");
      return;
    }

    setProfileDraft(activeProfile?.profile ?? initialProfile);
    setOnboardingStep(activeProfile?.profile ? 3 : 0);
    setActiveScreen("today");
    setAuthError("");
  }, [currentAccount, activeProfile]);

  useEffect(() => {
    if (!reminderSettings.enabled || reminderSettings.permission !== "granted" || typeof Notification === "undefined") {
      return;
    }

    const tick = () => {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dayKey = getLocalDateKey(now);
      const nextKey = `${dayKey}-${currentTime}`;

      if (!reminderSettings.times.includes(currentTime) || lastReminderKey === nextKey) {
        return;
      }

      new Notification("HydraFlow reminder", {
        body: activeProfile
          ? `Time to check in for ${activeProfile.name}.`
          : "Time for another hydration check-in.",
      });
      setLastReminderKey(nextKey);
    };

    tick();
    const interval = window.setInterval(tick, 30000);
    return () => window.clearInterval(interval);
  }, [activeProfile, lastReminderKey, reminderSettings.enabled, reminderSettings.permission, reminderSettings.times]);

  useEffect(() => {
    if (!cloudAuthEnabled) {
      return;
    }

    let cancelled = false;

    const syncSession = async () => {
      const { data, error } = await getCloudSession();
      if (cancelled || error) {
        return;
      }

      if (data.session?.user) {
        const remoteUserId = data.session.user.id;
        const email = data.session.user.email ?? "";
        const fallbackName = String(data.session.user.user_metadata?.name ?? email.split("@")[0] ?? "HydraFlow User");
        await hydrateCloudAccount(remoteUserId, email, fallbackName);
        return;
      }

      if (currentAccount?.authProvider === "supabase") {
        setCurrentUserId(null);
      }
    };

    void syncSession().catch(() => undefined);

    const { data } = subscribeToCloudAuthChanges(async (_event, session) => {
      if (!session?.user) {
        if (!cancelled) {
          setCurrentUserId((current) => {
            if (!current) {
              return current;
            }

            const account = loadState().accounts.find((item) => item.id === current);
            return account?.authProvider === "supabase" ? null : current;
          });
        }
        return;
      }

      const remoteUserId = session.user.id;
      const email = session.user.email ?? "";
      const fallbackName = String(session.user.user_metadata?.name ?? email.split("@")[0] ?? "HydraFlow User");
      void hydrateCloudAccount(remoteUserId, email, fallbackName);
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [cloudAuthEnabled, currentAccount?.authProvider]);

  useEffect(() => {
    if (!cloudAuthEnabled || !currentAccount?.remoteUserId || currentAccount.authProvider !== "supabase") {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSyncState("syncing");
      setSyncError("");

      void saveRemoteAccount(currentAccount)
        .then(() => {
          if (!cancelled) {
            setSyncState("synced");
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setSyncState("error");
            setSyncError(error instanceof Error ? error.message : "Unable to sync this account.");
          }
        });
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cloudAuthEnabled, currentAccount]);

  function replaceCurrentAccount(nextAccount: AccountRecord) {
    setAccounts((current) => upsertAccount(current, nextAccount));
  }

  function updateCurrentAccount(patch: Partial<AccountRecord> | ((account: AccountRecord) => AccountRecord)) {
    if (!currentAccount) {
      return;
    }

    replaceCurrentAccount(typeof patch === "function" ? patch(currentAccount) : { ...currentAccount, ...patch });
  }

  function updateActiveProfile(updater: (profile: MemberProfileRecord) => MemberProfileRecord) {
    if (!currentAccount || !activeProfile) {
      return;
    }

    updateCurrentAccount((account) => ({
      ...account,
      profiles: account.profiles.map((profileItem) =>
        profileItem.id === activeProfile.id ? updater(profileItem) : profileItem,
      ),
    }));
  }

  async function hydrateCloudAccount(remoteUserId: string, email: string, fallbackName: string) {
    const remoteAccount = await loadRemoteAccount(remoteUserId).catch(() => null);
    const persistedExisting = loadState().accounts.find(
      (account) => account.remoteUserId === remoteUserId || sanitizeEmail(account.email) === sanitizeEmail(email),
    );
    let nextAccount: AccountRecord | null = null;

    setAccounts((current) => {
      const existing = current.find(
        (account) => account.remoteUserId === remoteUserId || sanitizeEmail(account.email) === sanitizeEmail(email),
      ) ?? persistedExisting;

      nextAccount = remoteAccount
        ? {
            ...remoteAccount,
            id: remoteAccount.id || existing?.id || `acct-cloud-${remoteUserId}`,
            email,
            name: remoteAccount.name || existing?.name || fallbackName,
            authProvider: "supabase",
            remoteUserId,
          }
        : existing
          ? {
              ...existing,
              email,
              authProvider: "supabase",
              remoteUserId,
            }
          : createAccountRecord({
              id: `acct-cloud-${remoteUserId}`,
              name: fallbackName,
              email,
              authProvider: "supabase",
              remoteUserId,
            });

      return upsertAccount(current, nextAccount);
    });

    if (!nextAccount) {
      throw new Error("Unable to hydrate the cloud account.");
    }

    const hydratedAccount = nextAccount as AccountRecord;

    setCurrentUserId(hydratedAccount.id);

    if (!remoteAccount) {
      await saveRemoteAccount(hydratedAccount).catch(() => undefined);
    }

    return hydratedAccount;
  }

  function updateDraft<Key extends keyof UserProfile>(key: Key, value: UserProfile[Key]) {
    setProfileDraft((current) => ({ ...current, [key]: value }));
  }

  function completeOnboarding() {
    if (!activeProfile) {
      return;
    }

    updateActiveProfile((profileItem) => ({ ...profileItem, profile: profileDraft }));
    startTransition(() => {
      setOnboardingStep(3);
      setActiveScreen("today");
    });
  }

  function addEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]) {
    if (!profile || Number.isNaN(amountMl) || amountMl <= 0 || !activeProfile) {
      return;
    }

    const nextEntry = createLogEntry(amountMl, sourceType);
    updateActiveProfile((profileItem) => ({
      ...profileItem,
      entries: [nextEntry, ...profileItem.entries].slice(0, 200),
    }));
    setCustomAmount("");
  }

  function attemptAddEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]) {
    if (!profile || Number.isNaN(amountMl) || amountMl <= 0 || !activeProfile) {
      return;
    }

    if (!isKidMode || !childLoggingPolicy.guardrailsEnabled) {
      addEntry(amountMl, sourceType);
      return;
    }

    const now = Date.now();
    const burstWindowMs = childLoggingPolicy.burstWindowMinutes * 60 * 1000;
    const recentCount = entries.filter((entry) => now - new Date(entry.timestamp).getTime() <= burstWindowMs).length;
    const triggerReason: GuardrailReason | null =
      amountMl > childLoggingPolicy.suspiciousEntryMl
        ? "entry_limit"
        : recentCount >= childLoggingPolicy.burstLimitCount
          ? "burst_limit"
          : null;

    if (!triggerReason) {
      addEntry(amountMl, sourceType);
      return;
    }

    const nextFlaggedEvent = createFlaggedEvent(activeProfile.id, amountMl, triggerReason, sourceType);
    updateActiveProfile((profileItem) => ({
      ...profileItem,
      flaggedEvents: [...(profileItem.flaggedEvents ?? []), nextFlaggedEvent].slice(-20),
    }));
    setPendingFlaggedEvent(nextFlaggedEvent);
  }

  function resolveFlaggedEvent(eventId: string, resolution: FlaggedLoggingEvent["resolution"], shouldCommit = false) {
    if (!activeProfile) {
      return;
    }

    const nextEvents = flaggedEvents.map((event) => (event.id === eventId ? { ...event, resolution } : event));
    const resolvedEvent = nextEvents.find((event) => event.id === eventId) ?? null;

    if (shouldCommit && resolvedEvent) {
      const nextEntry = createLogEntry(resolvedEvent.attemptedAmountMl, resolvedEvent.sourceType);
      updateActiveProfile((profileItem) => ({
        ...profileItem,
        flaggedEvents: nextEvents,
        entries: [nextEntry, ...profileItem.entries].slice(0, 200),
      }));
      setCustomAmount("");
    } else {
      updateActiveProfile((profileItem) => ({ ...profileItem, flaggedEvents: nextEvents }));
    }

    setPendingFlaggedEvent(null);
  }

  function handleCustomAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = Number(customAmount);
    if (!raw) {
      return;
    }

    const amountMl = targetSource.preferredDisplayUnits === "imperial" ? Math.round(ozToMl(raw)) : Math.round(raw);
    attemptAddEntry(amountMl, "custom");
  }

  async function syncCurrentAccountNow() {
    if (!currentAccount?.remoteUserId || currentAccount.authProvider !== "supabase") {
      return;
    }

    setSyncState("syncing");
    setSyncError("");

    try {
      await saveRemoteAccount(currentAccount);
      setSyncState("synced");
    } catch (error) {
      setSyncState("error");
      setSyncError(error instanceof Error ? error.message : "Unable to sync this account.");
    }
  }

  function resetAll() {
    clearAllState();
    if (cloudAuthEnabled) {
      void signOutCloud().catch(() => undefined);
    }
    setAccounts([]);
    setCurrentUserId(null);
    setAuthMode("landing");
    setAuthForm(initialAuthForm);
    setAuthError("");
    setProfileDraft(initialProfile);
    setOnboardingStep(0);
    setActiveScreen("today");
    setCustomAmount("");
    setSyncState("idle");
    setSyncError("");
  }

  function signOut() {
    if (currentAccount?.authProvider === "supabase") {
      void signOutCloud().catch(() => undefined);
    }
    persistAccounts(accounts, null);
    setCurrentUserId(null);
    setAuthMode("landing");
    setAuthForm(initialAuthForm);
    setAuthError("");
    setCustomAmount("");
    setSyncState("idle");
    setSyncError("");
  }

  async function triggerInstall() {
    const promptEvent = deferredPrompt as
      | (Event & { prompt: () => Promise<void> })
      | null;

    if (!promptEvent?.prompt) {
      return;
    }

    await promptEvent.prompt();
    setInstallPromptVisible(false);
    setDeferredPrompt(null);
  }

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = authForm.name.trim();
    const email = sanitizeEmail(authForm.email);
    const password = authForm.password;

    if (!name || !email || !password) {
      setAuthError("Enter your name, email, and password to create an account.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");

    try {
      if (cloudAuthEnabled) {
        const { data, error } = await signUpWithCloud(email, password, name);
        if (error || !data.user) {
          throw error ?? new Error("Unable to create your cloud account.");
        }

        const account = createAccountRecord({
          id: `acct-cloud-${data.user.id}`,
          name,
          email,
          authProvider: "supabase",
          remoteUserId: data.user.id,
        });

        setAccounts((current) => upsertAccount(current, account));
        setCurrentUserId(account.id);
        setAuthForm(initialAuthForm);
        setAuthMode("landing");

        if (data.session) {
          await saveRemoteAccount(account);
          setSyncState("synced");
        } else {
          setSyncState("idle");
          setAuthError("Cloud account created. If email confirmation is on, confirm your inbox before syncing on other devices.");
        }

        return;
      }

      if (accounts.some((account) => sanitizeEmail(account.email) === email)) {
        setAuthError("That email is already registered. Try logging in instead.");
        return;
      }

      const account = createAccountRecord({
        id: `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        email,
        password,
        authProvider: "local",
      });

      setAccounts((current) => upsertAccount(current, account));
      setCurrentUserId(account.id);
      setAuthForm(initialAuthForm);
      setAuthMode("landing");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to create your account.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = sanitizeEmail(authForm.email);
    const password = authForm.password.trim();

    setAuthBusy(true);
    setAuthError("");

    try {
      if (cloudAuthEnabled) {
        const { data, error } = await signInWithCloud(email, password);
        if (error || !data.user) {
          throw error ?? new Error("We could not log you into the cloud account.");
        }

        await hydrateCloudAccount(
          data.user.id,
          data.user.email ?? email,
          String(data.user.user_metadata?.name ?? email.split("@")[0] ?? "HydraFlow User"),
        );
        setAuthForm(initialAuthForm);
        return;
      }

      const match = loadState().accounts.find(
        (account) => sanitizeEmail(account.email) === email && (account.password ?? "") === password,
      );

      if (!match) {
        throw new Error("We could not match that email and password.");
      }

      persistAccounts(loadState().accounts, match.id);
      setCurrentUserId(match.id);
      setAuthForm(initialAuthForm);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to log in.");
    } finally {
      setAuthBusy(false);
    }
  }

  function switchActiveProfile(profileId: string) {
    if (!currentAccount || profileId === currentAccount.activeProfileId) {
      return;
    }

    updateCurrentAccount({ activeProfileId: profileId });
    setPendingFlaggedEvent(null);
    setActiveScreen("today");
  }

  function createFamilyProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!currentAccount) {
      return;
    }

    const name = profileNameDraft.trim();
    if (!name) {
      return;
    }

    if (currentAccount.profiles.length >= maxProfiles) {
      return;
    }

    const nextProfile = createProfileRecord(name);
    updateCurrentAccount((account) => ({
      ...account,
      profiles: [...account.profiles, nextProfile],
      activeProfileId: nextProfile.id,
    }));
    setProfileNameDraft("");
    setProfileCreatorOpen(false);
    setActiveScreen("today");
  }

  async function enableReminders() {
    if (!currentAccount) {
      return;
    }

    if (typeof Notification === "undefined") {
      setReminderError("This browser does not support notifications.");
      return;
    }

    const permission = await Notification.requestPermission();
    updateCurrentAccount({
      reminderSettings: {
        ...reminderSettings,
        enabled: permission === "granted",
        permission,
      },
    });
    setReminderError(permission === "granted" ? "" : "Notification permission was not granted.");
  }

  function toggleReminders() {
    if (!currentAccount) {
      return;
    }

    if (reminderSettings.permission !== "granted") {
      void enableReminders();
      return;
    }

    updateCurrentAccount({
      reminderSettings: {
        ...reminderSettings,
        enabled: !reminderSettings.enabled,
      },
    });
    setReminderError("");
  }

  function updateReminderTime(index: number, value: string) {
    updateCurrentAccount({
      reminderSettings: {
        ...reminderSettings,
        times: reminderSettings.times.map((time, timeIndex) => (timeIndex === index ? value : time)),
      },
    });
  }

  function exportSelectedProfile() {
    if (!activeProfile) {
      return;
    }

    downloadProfileCsv(activeProfile);
  }

  function exportAllProfiles() {
    if (!currentAccount) {
      return;
    }

    downloadFamilyCsv(currentAccount.profiles);
  }

  function renderProfileSwitcher(compact = false) {
    if (!currentAccount || currentAccount.profiles.length <= 1) {
      return null;
    }

    return (
      <div className={compact ? "profile-switcher compact-switcher" : "profile-switcher"}>
        {currentAccount.profiles.map((profileItem) => (
          <button
            key={profileItem.id}
            className={activeProfile?.id === profileItem.id ? "profile-chip is-active" : "profile-chip"}
            onClick={() => switchActiveProfile(profileItem.id)}
            type="button"
          >
            <strong>{profileItem.name}</strong>
            <span>{getProfileMeta(profileItem)}</span>
          </button>
        ))}
        {currentAccount.profiles.length < maxProfiles ? (
          <button className="profile-chip add-profile-chip" onClick={() => setProfileCreatorOpen(true)} type="button">
            <strong>Add profile</strong>
            <span>{currentAccount.profiles.length}/{maxProfiles} used</span>
          </button>
        ) : null}
      </div>
    );
  }

  function renderLanding() {
    return (
      <section className="landing-shell">
        <div className="panel landing-hero glass-panel">
          <span className="eyebrow">Catch your flow</span>
          <h1>HydraFlow turns daily hydration into a futuristic ritual you actually want to keep.</h1>
          <p className="hero-copy">
            Personalized targets, family-ready profiles, optional cloud sync, and a dashboard that keeps daily hydration
            obvious.
          </p>
          <div className="hero-actions">
            <button className="cta-button" onClick={() => setAuthMode("signup")} type="button">
              Sign Up
            </button>
            <button className="ghost-button" onClick={() => setAuthMode("login")} type="button">
              Log In
            </button>
          </div>
          <div className="landing-cards">
            <div className="mini-card">
              <span>Personal target</span>
              <strong>Weight + age + climate + activity</strong>
            </div>
            <div className="mini-card">
              <span>Family mode</span>
              <strong>Multiple profiles under one account</strong>
            </div>
            <div className="mini-card">
              <span>Sync path</span>
              <strong>{cloudAuthEnabled ? "Supabase auth + cloud state" : "Local-first until cloud is configured"}</strong>
            </div>
            <div className="mini-card premium-mini-card">
              <span>Freemium</span>
              <strong>Family tools, sync, reminders, export, and deeper insight</strong>
            </div>
          </div>
        </div>

        <div className="panel auth-preview glass-panel">
          <span className="eyebrow">How it works</span>
          <h2>Start outside the app, then step into a dashboard built for one person or a whole household.</h2>
          <ul className="feature-list">
            <li>Create an account and answer a short profile setup.</li>
            <li>Track one profile for free, or unlock family mode for multiple profiles.</li>
            <li>{cloudAuthEnabled ? "Cloud auth is live in this build for device sync." : "Add Supabase keys later to turn on cloud auth and sync."}</li>
          </ul>
        </div>
      </section>
    );
  }

  function renderAuthCard() {
    const isSignup = authMode === "signup";

    return (
      <section className="auth-shell">
        <div className="panel auth-hero glass-panel">
          <span className="eyebrow">{isSignup ? "Create account" : "Welcome back"}</span>
          <h1>{isSignup ? "Build your hydration identity." : "Step back into your water dashboard."}</h1>
          <p className="hero-copy">
            {cloudAuthEnabled
              ? isSignup
                ? "This build can create cloud-backed accounts for sync across devices."
                : "Log into your cloud-backed account to restore synced hydration data."
              : isSignup
                ? "Create a local-first account and HydraFlow will shape a target for you."
                : "Log in with your local account credentials to continue from this device."}
          </p>
        </div>

        <form className="panel auth-panel glass-panel" onSubmit={isSignup ? handleSignup : handleLogin}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">{isSignup ? "Sign Up" : "Log In"}</span>
              <h2>{isSignup ? "Create your account" : "Access your account"}</h2>
            </div>
            <span className="subtle-note">{cloudAuthEnabled ? "Cloud auth enabled" : "Local-first mode"}</span>
          </div>

          <div className="field-grid">
            {isSignup ? (
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  placeholder="Your name"
                  value={authForm.name}
                  onChange={(event) => setAuthForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
            ) : null}

            <label className="field">
              <span>Email</span>
              <input
                type="email"
                placeholder="you@example.com"
                value={authForm.email}
                onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                placeholder="••••••••"
                value={authForm.password}
                onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
          </div>

          {authError ? <p className="form-error">{authError}</p> : null}

          <div className="wizard-actions">
            <button className="cta-button" disabled={authBusy} type="submit">
              {authBusy ? "Working..." : isSignup ? "Sign Up" : "Log In"}
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                setAuthMode(isSignup ? "login" : "signup");
                setAuthError("");
              }}
              type="button"
            >
              {isSignup ? "I already have an account" : "I need an account"}
            </button>
            <button className="ghost-button" onClick={() => setAuthMode("landing")} type="button">
              Back to landing
            </button>
          </div>
        </form>
      </section>
    );
  }

  function renderOnboarding() {
    return (
      <section className="onboarding-shell">
        <div className="panel hero-panel glass-panel">
          <span className="eyebrow">Profile setup</span>
          <h1>
            {activeProfile?.name ? `Let’s build ${activeProfile.name}'s hydration dashboard.` : "Build your hydration dashboard."}
          </h1>
          <p className="hero-copy">
            A few answers are enough to estimate a practical daily water goal and prepare this profile’s dashboard.
          </p>
          <div className="hero-stats">
            <div>
              <strong>{formatLiters(targetMl)}</strong>
              <span>recommended target</span>
            </div>
            <div>
              <strong>{formatOz(targetMl)}</strong>
              <span>imperial view</span>
            </div>
            <div>
              <strong>{profileDraft.age}</strong>
              <span>age calibration</span>
            </div>
          </div>
        </div>

        <div className="panel wizard-panel glass-panel">
          <div className="wizard-progress">
            {[0, 1, 2].map((step) => (
              <span key={step} className={step <= onboardingStep ? "active" : ""} />
            ))}
          </div>

          {onboardingStep === 0 ? (
            <div className="wizard-step">
              <span className="eyebrow">Step 1</span>
              <h2>Tell HydraFlow who it is calibrating for.</h2>
              <div className="field-grid">
                <label className="field">
                  <span>Weight</span>
                  <div className="inline-input">
                    <input
                      type="number"
                      min="20"
                      max="300"
                      value={profileDraft.weight}
                      onChange={(event) => updateDraft("weight", Number(event.target.value))}
                    />
                    <div className="segmented">
                      {(["kg", "lb"] as WeightUnit[]).map((unit) => (
                        <button
                          key={unit}
                          className={profileDraft.weightUnit === unit ? "is-selected" : ""}
                          onClick={() => updateDraft("weightUnit", unit)}
                          type="button"
                        >
                          {unit}
                        </button>
                      ))}
                    </div>
                  </div>
                </label>

                <label className="field">
                  <span>Age</span>
                  <input
                    type="number"
                    min="3"
                    max="100"
                    value={profileDraft.age}
                    onChange={(event) => updateDraft("age", Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="wizard-actions">
                <button className="cta-button" onClick={() => setOnboardingStep(1)} type="button">
                  Continue
                </button>
              </div>
            </div>
          ) : null}

          {onboardingStep === 1 ? (
            <div className="wizard-step">
              <span className="eyebrow">Step 2</span>
              <h2>Now describe climate and movement level.</h2>
              <div className="field-grid">
                <label className="field">
                  <span>Climate</span>
                  <div className="chip-grid">
                    {(["cool", "warm", "hot"] as ClimateLevel[]).map((level) => (
                      <button
                        key={level}
                        className={profileDraft.climateLevel === level ? "chip is-selected" : "chip"}
                        onClick={() => updateDraft("climateLevel", level)}
                        type="button"
                      >
                        <strong>{level}</strong>
                        <small>{climateLabels[level]}</small>
                      </button>
                    ))}
                  </div>
                </label>

                <label className="field">
                  <span>Activity</span>
                  <div className="chip-grid">
                    {(["low", "moderate", "high"] as ActivityLevel[]).map((level) => (
                      <button
                        key={level}
                        className={profileDraft.activityLevel === level ? "chip is-selected" : "chip"}
                        onClick={() => updateDraft("activityLevel", level)}
                        type="button"
                      >
                        <strong>{level}</strong>
                        <small>{activityLabels[level]}</small>
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <div className="wizard-actions">
                <button className="ghost-button" onClick={() => setOnboardingStep(0)} type="button">
                  Back
                </button>
                <button className="cta-button" onClick={() => setOnboardingStep(2)} type="button">
                  Review target
                </button>
              </div>
            </div>
          ) : null}

          {onboardingStep === 2 ? (
            <div className="wizard-step">
              <span className="eyebrow">Step 3</span>
              <h2>
                {profileDraft.age < 12
                  ? `${activeProfile?.name ?? "This profile"} is in kid mode. Today’s goal is about ${getCupCountLabel(targetMl)}.`
                  : `${activeProfile?.name ?? "This profile"} will target ${formatDisplayAmount(targetMl, "dual")} each day.`}
              </h2>
              <p>
                Base hydration is {formatMl(targetBreakdown.base)}, with {formatMl(targetBreakdown.activity)} for
                activity, {formatMl(targetBreakdown.climate)} for climate, and {targetBreakdown.age >= 0 ? formatMl(targetBreakdown.age) : `-${formatMl(Math.abs(targetBreakdown.age))}`} from age tuning.
              </p>
              <div className="result-grid">
                <div className="mini-card">
                  <span>Weight</span>
                  <strong>
                    {profileDraft.weight} {profileDraft.weightUnit}
                  </strong>
                </div>
                <div className="mini-card">
                  <span>Age</span>
                  <strong>{profileDraft.age}</strong>
                </div>
                <div className="mini-card">
                  <span>Environment</span>
                  <strong>
                    {profileDraft.climateLevel} • {profileDraft.activityLevel}
                  </strong>
                </div>
              </div>
              <div className="wizard-actions">
                <button className="ghost-button" onClick={() => setOnboardingStep(1)} type="button">
                  Edit answers
                </button>
                <button className="cta-button" onClick={completeOnboarding} type="button">
                  Give me the dashboard
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  function renderToday() {
    const progressDash = Math.min(progressRatio, 1);
    const circumference = 2 * Math.PI * 88;
    const dashOffset = circumference - progressDash * circumference;
    const kidRemainingCups = getCupCountLabel(remainingMl);
    const kidDrankCups = getCupCountLabel(todayProgressMl);
    const suggestedAmountMl = quickAdds.reduce(
      (best, amount) => (Math.abs(amount - remainingMl) < Math.abs(best - remainingMl) ? amount : best),
      quickAdds[0],
    );
    const suggestedLabel = isKidMode ? `Add ${getKidQuickAddLabel(suggestedAmountMl).title.toLowerCase()}` : "Add one more glass";

    return (
      <section className={`dashboard-shell scene-block ${isKidMode ? "is-kid-mode" : ""}`}>
        <div className="dashboard-hello">
          <span className="eyebrow">{`Hi, ${firstName}`}</span>
          <h2>{isKidMode ? `${getCupCountLabel(targetMl)} today.` : `${formatDisplayAmount(targetMl, "dual")} today.`}</h2>
        </div>

        {renderProfileSwitcher()}

        <div className="family-overview-strip">
          <div className="mini-card">
            <span>Selected profile</span>
            <strong>{activeProfile?.name ?? "Profile"}</strong>
          </div>
          <div className="mini-card">
            <span>Mode</span>
            <strong>{isKidMode ? "Kid dashboard" : "Standard dashboard"}</strong>
          </div>
          <div className="mini-card">
            <span>Plan</span>
            <strong>{`${profileCount} of ${maxProfiles} family profiles available`}</strong>
          </div>
        </div>

        <div className="content-grid">
          <div className="panel spotlight-panel glass-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Dashboard</span>
                <h2>{isKidMode ? "Your water mission" : "Today’s dashboard"}</h2>
              </div>
              <span className="status-pill">{completionLabel}</span>
            </div>

            <div className="progress-layout">
              <div className="progress-visual">
                <svg viewBox="0 0 220 220" className="progress-ring" aria-hidden="true">
                  <defs>
                    <linearGradient id="progressGradient" x1="0%" x2="100%" y1="0%" y2="100%">
                      <stop offset="0%" stopColor="#00ffff" />
                      <stop offset="100%" stopColor="#00d4aa" />
                    </linearGradient>
                  </defs>
                  <circle cx="110" cy="110" r="88" className="progress-track" />
                  <circle
                    cx="110"
                    cy="110"
                    r="88"
                    className="progress-fill"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                  />
                </svg>
                <div className="progress-core">
                  <strong>{Math.round(progressRatio * 100)}%</strong>
                  <span>{isKidMode ? `${kidDrankCups} drank` : `${formatDisplayAmount(todayProgressMl, "dual")} drank`}</span>
                </div>
              </div>

              <div className="progress-copy">
                <div className="data-card">
                  <span>{isKidMode ? "You already drank" : "How much you drank"}</span>
                  <strong>{isKidMode ? kidDrankCups : formatDisplayAmount(todayProgressMl, "dual")}</strong>
                </div>
                <div className="data-card">
                  <span>{isKidMode ? "Still to drink" : "Still to go"}</span>
                  <strong>{isKidMode ? kidRemainingCups : formatDisplayAmount(remainingMl, "dual")}</strong>
                </div>
                <button
                  className="smart-action-button"
                  type="button"
                  onClick={(event) => {
                    createRipple(event);
                    attemptAddEntry(suggestedAmountMl, "quick_add");
                  }}
                >
                  <span>{isKidMode ? "Simple plan" : "Quick plan"}</span>
                  <strong>{suggestedLabel}</strong>
                  <small>
                    {isKidMode
                      ? `${getKidQuickAddLabel(suggestedAmountMl).subtitle} • ${formatMl(suggestedAmountMl)}`
                      : `${formatDisplayAmount(suggestedAmountMl, "dual")} now`}
                  </small>
                </button>
              </div>
            </div>

            {isKidMode ? (
              <div className="kid-banner">
                <strong>Kid mode is on</strong>
                <span>We show cups and bottle-sized actions so the dashboard feels easier to understand.</span>
              </div>
            ) : null}
          </div>

          <div className="panel actions-panel glass-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Log intake</span>
                <h2>{isKidMode ? "Tap what you drank." : "Add water to the dashboard."}</h2>
              </div>
            </div>

            <div className="quick-grid">
              {quickAdds.map((amountMl) => (
                <button
                  key={amountMl}
                  className="action-tile"
                  type="button"
                  onClick={(event) => {
                    createRipple(event);
                    attemptAddEntry(amountMl, "quick_add");
                  }}
                >
                  <strong>
                    {isKidMode ? getKidQuickAddLabel(amountMl).title : formatDisplayAmount(amountMl, targetSource.preferredDisplayUnits)}
                  </strong>
                  <span>
                    {isKidMode
                      ? `${getKidQuickAddLabel(amountMl).subtitle} • ${formatMl(amountMl)}`
                      : amountMl >= 350
                        ? "Bottle boost"
                        : "Glass boost"}
                  </span>
                </button>
              ))}
            </div>

            <form className="custom-form" onSubmit={handleCustomAdd}>
              <label className="field">
                <span>{isKidMode ? "Grown-up helper amount" : `Custom amount (${targetSource.preferredDisplayUnits === "imperial" ? "oz" : "ml"})`}</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder={targetSource.preferredDisplayUnits === "imperial" ? "12" : "300"}
                  value={customAmount}
                  onChange={(event) => setCustomAmount(event.target.value)}
                />
              </label>
              <button className="cta-button" type="submit">
                Add water
              </button>
            </form>
          </div>

          <div className="panel log-panel glass-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Today log</span>
                <h2>Everything logged today</h2>
              </div>
              <span className="subtle-note">{todayEntries.length} entries</span>
            </div>

            <div className="log-list">
              {todayEntries.length > 0 ? (
                todayEntries.map((entry) => (
                  <div key={entry.id} className="log-row">
                    <div>
                      <strong>{isKidMode ? `${getCupCountLabel(entry.amountMl)} • ${formatMl(entry.amountMl)}` : formatDisplayAmount(entry.amountMl, "dual")}</strong>
                      <span>{entry.sourceType === "quick_add" ? "Quick add" : "Custom log"}</span>
                    </div>
                    <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <strong>No water logged yet</strong>
                  <span>Tap a quick amount or enter a custom amount to start filling the dashboard.</span>
                </div>
              )}
            </div>
          </div>

          <div className="panel glass-panel premium-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Freemium</span>
                <h2>Everything is included in the freemium build</h2>
              </div>
              <span className="plan-pill is-freemium">{getPlanLabel()}</span>
            </div>

            <div className="premium-grid">
              <div className="mini-card">
                <span>Family hub</span>
                <strong>{profileCount} profiles on this account</strong>
              </div>
              <div className="mini-card">
                <span>Cloud sync</span>
                <strong>{currentAccount?.authProvider === "supabase" ? "Connected to Supabase" : "Ready when cloud auth is configured"}</strong>
              </div>
              <div className="mini-card">
                <span>Reminders</span>
                <strong>{reminderSettings.enabled ? `${reminderSettings.times.length} browser nudges active` : "Ready for browser nudges"}</strong>
              </div>
              <div className="mini-card">
                <span>Insights</span>
                <strong>Streaks, summaries, and full history tools are included</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderHistory() {
    return (
      <section className="content-grid compact-grid">
        <div className="panel glass-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">History</span>
              <h2>Recent hydration totals</h2>
            </div>
            <button className="ghost-button compact" onClick={exportSelectedProfile} type="button">
              Export CSV
            </button>
          </div>

          {renderProfileSwitcher(true)}

          <div className="history-bars">
            {history.length > 0 ? (
              history.map((day) => {
                const ratio = targetMl > 0 ? Math.min(day.totalMl / targetMl, 1) : 0;
                return (
                  <div key={day.dateKey} className="history-row">
                    <div className="history-meta">
                      <strong>{day.label}</strong>
                      <span>{formatDisplayAmount(day.totalMl, "dual")}</span>
                    </div>
                    <div className="bar-track">
                      <span className="bar-fill" style={{ width: `${Math.max(8, ratio * 100)}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <strong>History will appear after logging starts.</strong>
                <span>Your recent totals will show up here automatically for the selected profile.</span>
              </div>
            )}
          </div>
        </div>

        <div className="panel glass-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Insights</span>
              <h2>Weekly freemium readout</h2>
            </div>
            <span className="plan-pill is-freemium">{getPlanLabel()}</span>
          </div>

          <div className="premium-grid">
            <div className="mini-card">
              <span>7-day average</span>
              <strong>{averageDailyMl > 0 ? formatDisplayAmount(averageDailyMl, "dual") : "Waiting for data"}</strong>
            </div>
            <div className="mini-card">
              <span>Consistency score</span>
              <strong>{history.length > 0 ? `${consistencyScore}%` : "No score yet"}</strong>
            </div>
            <div className="mini-card">
              <span>Strong streak</span>
              <strong>{history.length > 0 ? `${streakDays} day${streakDays === 1 ? "" : "s"}` : "Start logging"}</strong>
            </div>
            <button className="action-tile premium-tile is-live export-tile" onClick={exportAllProfiles} type="button">
              <strong>Export family CSV</strong>
              <span>Download all profile logs for backup or analysis.</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderSettings() {
    if (!currentAccount || !activeProfile) {
      return null;
    }

    const current = profile ?? profileDraft;
    const policy = activeProfile.childLoggingPolicy ?? defaultChildLoggingPolicy;

    return (
      <section className="content-grid compact-grid">
        <div className="panel glass-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Settings</span>
              <h2>Update account, profiles, sync, and included tools</h2>
            </div>
          </div>

          <div className="subscription-card">
            <div className="subscription-copy">
              <span className="eyebrow">Plan</span>
              <h3>{getPlanLabel()}</h3>
              <p>All family profiles, reminders, export, and sync-ready tools are included in this freemium build.</p>
            </div>
            <div className="subscription-actions">
              <span className="plan-pill is-freemium">{getPlanLabel()}</span>
            </div>
          </div>

          <div className="family-card glass-subpanel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Family hub</span>
                <h3>Profiles on this account</h3>
              </div>
              <span className="subtle-note">
                {profileCount}/{maxProfiles}
              </span>
            </div>
            {renderProfileSwitcher()}
            <div className="profile-list">
              {currentAccount.profiles.map((profileItem) => (
                <button
                  key={profileItem.id}
                  className={activeProfile.id === profileItem.id ? "profile-row is-active" : "profile-row"}
                  onClick={() => switchActiveProfile(profileItem.id)}
                  type="button"
                >
                  <div>
                    <strong>{profileItem.name}</strong>
                    <span>{getProfileMeta(profileItem)}</span>
                  </div>
                  <span>{profileItem.entries.length} logs</span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="cta-button" onClick={() => setProfileCreatorOpen(true)} type="button">
                Add family profile
              </button>
              <span className="subtle-note">You can keep up to {maxProfiles} profiles in the freemium build.</span>
            </div>
          </div>

          <div className="sync-card glass-subpanel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Included tools</span>
                <h3>Reminders and export</h3>
              </div>
              <span className="subtle-note">Live</span>
            </div>
            <div className="tool-grid">
              <div className="mini-card">
                <span>Reminder status</span>
                <strong>{reminderSettings.enabled ? `${reminderSettings.times.length} nudges active` : reminderSettings.permission === "granted" ? "Ready to enable" : "Permission needed"}</strong>
              </div>
              <div className="mini-card">
                <span>Export</span>
                <strong>Profile CSV and family CSV</strong>
              </div>
            </div>
            <div className="reminder-grid">
              {reminderSettings.times.map((time, index) => (
                <label key={`${time}-${index}`} className="field">
                  <span>{`Reminder ${index + 1} • ${formatReminderLabel(time)}`}</span>
                  <input type="time" value={time} onChange={(event) => updateReminderTime(index, event.target.value)} />
                </label>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="ghost-button" onClick={() => void enableReminders()} type="button">
                {reminderSettings.permission === "granted" ? "Refresh permission" : "Enable browser reminders"}
              </button>
              <button className="ghost-button" onClick={toggleReminders} type="button">
                {reminderSettings.enabled ? "Pause reminders" : "Turn reminders on"}
              </button>
              <button className="ghost-button" onClick={exportSelectedProfile} type="button">
                Export current profile
              </button>
            </div>
            {reminderError ? <p className="form-error">{reminderError}</p> : null}
          </div>

          <div className="field-grid">
            <label className="field">
              <span>Account name</span>
              <input type="text" value={currentAccount.name} onChange={(event) => updateCurrentAccount({ name: event.target.value })} />
            </label>

            <label className="field">
              <span>Current profile name</span>
              <input type="text" value={activeProfile.name} onChange={(event) => updateActiveProfile((profileItem) => ({ ...profileItem, name: event.target.value }))} />
            </label>

            <label className="field">
              <span>Preferred display</span>
              <div className="segmented">
                {(["dual", "metric", "imperial"] as DisplayUnits[]).map((unit) => (
                  <button
                    key={unit}
                    className={current.preferredDisplayUnits === unit ? "is-selected" : ""}
                    onClick={() => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, preferredDisplayUnits: unit } }))}
                    type="button"
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span>Weight</span>
              <input type="number" min="20" max="300" value={current.weight} onChange={(event) => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, weight: Number(event.target.value) } }))} />
            </label>

            <label className="field">
              <span>Age</span>
              <input type="number" min="3" max="100" value={current.age} onChange={(event) => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, age: Number(event.target.value) } }))} />
            </label>

            <label className="field">
              <span>Weight unit</span>
              <div className="segmented">
                {(["kg", "lb"] as WeightUnit[]).map((unit) => (
                  <button
                    key={unit}
                    className={current.weightUnit === unit ? "is-selected" : ""}
                    onClick={() => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, weightUnit: unit } }))}
                    type="button"
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span>Activity</span>
              <div className="chip-grid">
                {(["low", "moderate", "high"] as ActivityLevel[]).map((level) => (
                  <button
                    key={level}
                    className={current.activityLevel === level ? "chip is-selected" : "chip"}
                    onClick={() => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, activityLevel: level } }))}
                    type="button"
                  >
                    <strong>{level}</strong>
                    <small>{activityLabels[level]}</small>
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span>Climate</span>
              <div className="chip-grid">
                {(["cool", "warm", "hot"] as ClimateLevel[]).map((level) => (
                  <button
                    key={level}
                    className={current.climateLevel === level ? "chip is-selected" : "chip"}
                    onClick={() => updateActiveProfile((profileItem) => ({ ...profileItem, profile: { ...current, climateLevel: level } }))}
                    type="button"
                  >
                    <strong>{level}</strong>
                    <small>{climateLabels[level]}</small>
                  </button>
                ))}
              </div>
            </label>

            {current.age < 12 ? (
              <div className="field full-width">
                <span>Child guardrails</span>
                <div className="guardrail-card">
                  <div className="guardrail-row">
                    <div>
                      <strong>Kid safety checks</strong>
                      <small>Friendly confirmations appear if entries look too big or too fast.</small>
                    </div>
                    <button
                      className={policy.guardrailsEnabled ? "toggle-button is-on" : "toggle-button"}
                      onClick={() =>
                        updateActiveProfile((profileItem) => ({
                          ...profileItem,
                          childLoggingPolicy: {
                            ...policy,
                            guardrailsEnabled: !policy.guardrailsEnabled,
                          },
                        }))
                      }
                      type="button"
                    >
                      {policy.guardrailsEnabled ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="guardrail-meta">
                    <div className="mini-card">
                      <span>Single entry check</span>
                      <strong>Over {policy.suspiciousEntryMl} ml</strong>
                    </div>
                    <div className="mini-card">
                      <span>Burst check</span>
                      <strong>
                        {policy.burstLimitCount} logs in {policy.burstWindowMinutes} mins
                      </strong>
                    </div>
                  </div>
                  <div className="guardrail-events">
                    <span>Recent suspicious events</span>
                    {recentFlaggedEvents.length > 0 ? (
                      recentFlaggedEvents.map((event) => (
                        <div key={event.id} className="guardrail-event-row">
                          <div>
                            <strong>{formatMl(event.attemptedAmountMl)}</strong>
                            <small>{event.triggerReason === "entry_limit" ? "Large custom amount" : "Very fast repeated logging"}</small>
                          </div>
                          <span className={`event-pill is-${event.resolution}`}>{event.resolution}</span>
                        </div>
                      ))
                    ) : (
                      <div className="empty-state compact-empty">
                        <strong>No flagged activity</strong>
                        <span>Suspicious kid logs will appear here for review.</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="sync-card glass-subpanel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Sync</span>
                <h3>{cloudAuthEnabled ? "Cloud auth + sync path" : "Local-first mode"}</h3>
              </div>
              <span className="subtle-note">{cloudAuthEnabled ? currentAccount.authProvider : "Offline-ready"}</span>
            </div>
            <p>
              {cloudAuthEnabled
                ? currentAccount.authProvider === "supabase"
                  ? "This account is connected to Supabase and can sync hydration state across devices."
                  : "Supabase is configured for this build, but this account is still local-only. Use cloud signup or login to sync new sessions."
                : "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud auth and account syncing."}
            </p>
            {currentAccount.authProvider === "supabase" ? (
              <div className="wizard-actions">
                <button className="ghost-button" disabled={syncState === "syncing"} onClick={() => void syncCurrentAccountNow()} type="button">
                  {syncState === "syncing" ? "Syncing..." : "Sync now"}
                </button>
                <span className="subtle-note">
                  {syncState === "synced"
                    ? "Cloud state is in sync."
                    : syncState === "error"
                      ? syncError || "Sync failed."
                      : "Changes sync automatically after edits."}
                </span>
              </div>
            ) : null}
          </div>

          <div className="sync-card glass-subpanel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Freemium</span>
                <h3>Everything is already included</h3>
              </div>
            </div>
            <p>HydraFlow now runs as a single freemium experience. Family mode, reminders, export, and sync-ready tools are available without upgrades.</p>
          </div>

          <div className="settings-footer">
            <div className="subtle-note">
              Recommended target updates instantly:
              <strong> {formatDisplayAmount(calculateTargetMl(current), "dual")}</strong>
            </div>
            <div className="wizard-actions">
              <button className="ghost-button" onClick={signOut} type="button">
                Sign out
              </button>
              <button className="ghost-button danger" onClick={resetAll} type="button">
                Clear all local data
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <div id="particles" aria-hidden="true">
        {Array.from({ length: 50 }, (_, index) => (
          <span
            key={index}
            className="particle"
            style={
              {
                "--left": `${(index * 17) % 100}%`,
                "--delay": `${(index % 10) * 1.9}s`,
                "--duration": `${20 + (index % 9) * 1.8}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      {isPointerDevice ? <div className="cursor-glow" aria-hidden="true" /> : null}

      <header className="top-bar glass-panel">
        <div className="brand-lockup">
          <span className="brand-mark">◈</span>
          <div>
            <strong>HydraFlow</strong>
            <span>{isAuthenticated ? `Account: ${currentAccount?.name}` : "Futuristic daily hydration"}</span>
          </div>
        </div>
        <div className="top-actions">
          {isAuthenticated ? <span className="plan-pill compact-pill is-freemium">{getPlanLabel()}</span> : null}
          {activeProfile ? <span className="subtle-note">Profile: {activeProfile.name}</span> : null}
          {profile ? <span className="subtle-note">Today target {formatLiters(targetMl)}</span> : null}
          {installPromptVisible ? (
            <button className="ghost-button compact" onClick={triggerInstall} type="button">
              Install
            </button>
          ) : null}
        </div>
      </header>

      <main className={profile ? "workspace is-ready" : "workspace"}>
        <aside className="desktop-rail glass-panel">
          <span className="eyebrow">Mission control</span>
          <h2>
            {!isAuthenticated
              ? "Landing first. Dashboard after account setup."
              : needsOnboarding
                ? "Answer a few questions to unlock the current profile."
                : "Your hydration rhythm is live."}
          </h2>
          <p>
            A playful cockpit for visitors, account creation, family profile onboarding, optional sync, and a dashboard
            that keeps daily intake obvious.
          </p>
          <div className="rail-card">
            <span>Flow</span>
            <strong>Landing → Account → Profiles → Dashboard</strong>
          </div>
          <div className="rail-card">
            <span>Selected profile</span>
            <strong>{activeProfile?.name ?? "Not selected"}</strong>
          </div>
          <div className="rail-card">
            <span>Progress today</span>
            <strong>{formatDisplayAmount(todayProgressMl, "dual")}</strong>
          </div>
          <div className="rail-card premium-rail-card">
            <span>Plan</span>
            <strong>{getPlanLabel()}</strong>
          </div>
        </aside>

        <div className="main-pane">
          {!isAuthenticated && authMode === "landing" ? renderLanding() : null}
          {!isAuthenticated && (authMode === "login" || authMode === "signup") ? renderAuthCard() : null}
          {needsOnboarding ? renderOnboarding() : null}
          {profile && activeScreen === "today" ? renderToday() : null}
          {profile && activeScreen === "history" ? renderHistory() : null}
          {profile && activeScreen === "settings" ? renderSettings() : null}
        </div>
      </main>

      {pendingFlaggedEvent ? (
        <div className="modal-overlay">
          <div className="modal-card glass-panel">
            <span className="eyebrow">Friendly check</span>
            <h2>
              {pendingFlaggedEvent.triggerReason === "entry_limit"
                ? "That amount looks bigger than usual."
                : "That was a lot of logging very quickly."}
            </h2>
            <p>
              {pendingFlaggedEvent.triggerReason === "entry_limit"
                ? `We noticed ${formatMl(pendingFlaggedEvent.attemptedAmountMl)} for a child entry. A parent can approve it if that amount is correct.`
                : "We paused this for a moment so a parent can confirm the child is not tapping random numbers."}
            </p>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => resolveFlaggedEvent(pendingFlaggedEvent.id, "dismissed")} type="button">
                Dismiss
              </button>
              <button className="cta-button" onClick={() => resolveFlaggedEvent(pendingFlaggedEvent.id, "approved", true)} type="button">
                Parent approve
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {profileCreatorOpen ? (
        <div className="modal-overlay">
          <form className="modal-card glass-panel" onSubmit={createFamilyProfile}>
            <span className="eyebrow">Family profile</span>
            <h2>Add another profile to this account.</h2>
            <label className="field">
              <span>Profile name</span>
              <input type="text" placeholder="Maya" value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} />
            </label>
            <p className="subtle-note">The new profile starts with its own onboarding, target, history, and guardrails.</p>
            <div className="modal-actions">
              <button className="cta-button" type="submit">
                Create profile
              </button>
              <button
                className="ghost-button"
                onClick={() => {
                  setProfileCreatorOpen(false);
                  setProfileNameDraft("");
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {profile ? (
        <nav className="bottom-nav glass-panel" aria-label="Primary">
          {screens.map((screen) => (
            <button
              key={screen.id}
              className={activeScreen === screen.id ? "nav-item is-selected" : "nav-item"}
              onClick={(event) => {
                createRipple(event);
                startTransition(() => setActiveScreen(screen.id));
              }}
              type="button"
            >
              <span>{screen.icon}</span>
              <strong>{screen.label}</strong>
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
