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
import { clearAllState, loadState, persistAccounts } from "./lib/storage";
import type {
  AccountRecord,
  ActivityLevel,
  AuthMode,
  ChildLoggingPolicy,
  ClimateLevel,
  DisplayUnits,
  FlaggedLoggingEvent,
  GuardrailReason,
  HydrationLogEntry,
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

function createLogEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]): HydrationLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    amountMl,
    sourceType,
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

export default function App() {
  const stored = useMemo(() => loadState(), []);
  const [accounts, setAccounts] = useState<AccountRecord[]>(stored.accounts);
  const [currentUserId, setCurrentUserId] = useState<string | null>(stored.currentUserId);
  const currentAccount = useMemo(
    () => accounts.find((account) => account.id === currentUserId) ?? null,
    [accounts, currentUserId],
  );
  const [authMode, setAuthMode] = useState<AuthMode>(
    currentAccount ? "signup" : stored.accounts.length > 0 ? "login" : "landing",
  );
  const [authForm, setAuthForm] = useState(initialAuthForm);
  const [authError, setAuthError] = useState("");
  const [profileDraft, setProfileDraft] = useState<UserProfile>(currentAccount?.profile ?? initialProfile);
  const [onboardingStep, setOnboardingStep] = useState(currentAccount?.profile ? 3 : 0);
  const [activeScreen, setActiveScreen] = useState<Screen>("today");
  const [customAmount, setCustomAmount] = useState("");
  const [isPointerDevice, setIsPointerDevice] = useState(false);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null);
  const [pendingFlaggedEvent, setPendingFlaggedEvent] = useState<FlaggedLoggingEvent | null>(null);

  const todayKey = getLocalDateKey(new Date());
  const profile = currentAccount?.profile ?? null;
  const entries = currentAccount?.entries ?? [];
  const childLoggingPolicy = currentAccount?.childLoggingPolicy ?? defaultChildLoggingPolicy;
  const flaggedEvents = currentAccount?.flaggedEvents ?? [];
  const targetSource = profile ?? profileDraft;
  const targetMl = calculateTargetMl(targetSource);
  const targetBreakdown = getTargetBreakdown(targetSource);

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
  const firstName = getFirstName(currentAccount?.name);
  const recentFlaggedEvents = flaggedEvents.slice(-5).reverse();

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
      return;
    }

    setProfileDraft(currentAccount.profile ?? initialProfile);
    setOnboardingStep(currentAccount.profile ? 3 : 0);
    setActiveScreen("today");
    setAuthError("");
  }, [currentAccount]);

  function updateDraft<Key extends keyof UserProfile>(key: Key, value: UserProfile[Key]) {
    setProfileDraft((current) => ({ ...current, [key]: value }));
  }

  function updateCurrentAccount(patch: Partial<AccountRecord>) {
    if (!currentAccount) {
      return;
    }

    setAccounts((current) => {
      const nextAccounts = current.map((account) =>
        account.id === currentAccount.id ? { ...account, ...patch } : account,
      );
      persistAccounts(nextAccounts, currentUserId);
      return nextAccounts;
    });
  }

  function completeOnboarding() {
    if (!currentAccount) {
      return;
    }

    updateCurrentAccount({ profile: profileDraft });
    startTransition(() => {
      setOnboardingStep(3);
      setActiveScreen("today");
    });
  }

  function addEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]) {
    if (!profile || Number.isNaN(amountMl) || amountMl <= 0 || !currentAccount) {
      return;
    }

    const nextEntry = createLogEntry(amountMl, sourceType);
    updateCurrentAccount({ entries: [nextEntry, ...entries].slice(0, 200) });
    setCustomAmount("");
  }

  function attemptAddEntry(amountMl: number, sourceType: HydrationLogEntry["sourceType"]) {
    if (!profile || Number.isNaN(amountMl) || amountMl <= 0 || !currentAccount) {
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

    const nextFlaggedEvent = createFlaggedEvent(currentAccount.id, amountMl, triggerReason, sourceType);
    updateCurrentAccount({
      flaggedEvents: [...flaggedEvents, nextFlaggedEvent].slice(-20),
    });
    setPendingFlaggedEvent(nextFlaggedEvent);
  }

  function resolveFlaggedEvent(
    eventId: string,
    resolution: FlaggedLoggingEvent["resolution"],
    shouldCommit = false,
  ) {
    if (!currentAccount) {
      return;
    }

    const nextEvents = flaggedEvents.map((event) =>
      event.id === eventId ? { ...event, resolution } : event,
    );
    const resolvedEvent = nextEvents.find((event) => event.id === eventId) ?? null;

    if (shouldCommit && resolvedEvent) {
      const nextEntry = createLogEntry(resolvedEvent.attemptedAmountMl, resolvedEvent.sourceType);
      updateCurrentAccount({
        flaggedEvents: nextEvents,
        entries: [nextEntry, ...entries].slice(0, 200),
      });
      setCustomAmount("");
    } else {
      updateCurrentAccount({ flaggedEvents: nextEvents });
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

  function resetAll() {
    clearAllState();
    setAccounts([]);
    setCurrentUserId(null);
    setAuthMode("landing");
    setAuthForm(initialAuthForm);
    setAuthError("");
    setProfileDraft(initialProfile);
    setOnboardingStep(0);
    setActiveScreen("today");
    setCustomAmount("");
  }

  function signOut() {
    persistAccounts(accounts, null);
    setCurrentUserId(null);
    setAuthMode("landing");
    setAuthForm(initialAuthForm);
    setAuthError("");
    setCustomAmount("");
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

  function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = authForm.name.trim();
    const email = sanitizeEmail(authForm.email);
    const password = authForm.password;

    if (!name || !email || !password) {
      setAuthError("Enter your name, email, and password to create an account.");
      return;
    }

    if (accounts.some((account) => sanitizeEmail(account.email) === email)) {
      setAuthError("That email is already registered. Try logging in instead.");
      return;
    }

    const account: AccountRecord = {
      id: `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      email,
      password,
      createdAt: new Date().toISOString(),
      profile: null,
      entries: [],
      childLoggingPolicy: defaultChildLoggingPolicy,
      flaggedEvents: [],
    };

    setAccounts((current) => {
      const nextAccounts = [...current, account];
      persistAccounts(nextAccounts, account.id);
      return nextAccounts;
    });
    setCurrentUserId(account.id);
    setAuthForm(initialAuthForm);
    setAuthError("");
    setAuthMode("landing");
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = sanitizeEmail(authForm.email);
    const password = authForm.password.trim();
    const match = loadState().accounts.find(
      (account) => sanitizeEmail(account.email) === email && account.password === password,
    );

    if (!match) {
      setAuthError("We could not match that email and password.");
      return;
    }

    persistAccounts(loadState().accounts, match.id);
    setCurrentUserId(match.id);
    setAuthForm(initialAuthForm);
    setAuthError("");
  }

  function renderLanding() {
    return (
      <section className="landing-shell">
        <div className="panel landing-hero glass-panel">
          <span className="eyebrow">Catch your flow</span>
          <h1>HydraFlow turns daily hydration into a futuristic ritual you actually want to keep.</h1>
          <p className="hero-copy">
            Personalized water targets, a clean sign-up flow, and a dashboard that shows how much you should drink and
            how much you already have.
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
              <span>Daily dashboard</span>
              <strong>Goal, intake, remaining, history</strong>
            </div>
            <div className="mini-card">
              <span>User journey</span>
              <strong>Landing → account → profile → dashboard</strong>
            </div>
          </div>
        </div>

        <div className="panel auth-preview glass-panel">
          <span className="eyebrow">How it works</span>
          <h2>Start outside the app, then step straight into your hydration dashboard.</h2>
          <ul className="feature-list">
            <li>Choose Log In or Sign Up from the public website.</li>
            <li>Create a local account and answer a short set of profile questions.</li>
            <li>Open a live dashboard showing your daily target and current intake.</li>
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
            {isSignup
              ? "Create a profile-first account, answer a few questions, and HydraFlow will shape a target for you."
              : "Log in with your email and password to continue from your last saved hydration state."}
          </p>
        </div>

        <form className="panel auth-panel glass-panel" onSubmit={isSignup ? handleSignup : handleLogin}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">{isSignup ? "Sign Up" : "Log In"}</span>
              <h2>{isSignup ? "Create your account" : "Access your account"}</h2>
            </div>
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
            <button className="cta-button" type="submit">
              {isSignup ? "Sign Up" : "Log In"}
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
          <h1>{currentAccount?.name ? `${currentAccount.name}, let’s build your hydration dashboard.` : "Build your hydration dashboard."}</h1>
          <p className="hero-copy">
            A few answers are enough to estimate a practical daily water goal and prepare your personal dashboard.
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
                    min="8"
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
              <h2>Now describe your climate and movement level.</h2>
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
                  ? `Kid mode is ready. Today’s goal is about ${getCupCountLabel(targetMl)}.`
                  : `Your dashboard will target ${formatDisplayAmount(targetMl, "dual")} each day.`}
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
                  Give me my dashboard
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
    const suggestedAmountMl = quickAdds.reduce((best, amount) =>
      Math.abs(amount - remainingMl) < Math.abs(best - remainingMl) ? amount : best,
    quickAdds[0]);
    const suggestedLabel = isKidMode
      ? `Add ${getKidQuickAddLabel(suggestedAmountMl).title.toLowerCase()}`
      : "Add one more glass";

    return (
      <section className={`dashboard-shell scene-block ${isKidMode ? "is-kid-mode" : ""}`}>
        <div className="dashboard-hello">
          <span className="eyebrow">{`Hi, ${firstName}`}</span>
          <h2>
            {isKidMode
              ? `${getCupCountLabel(targetMl)} today.`
              : `${formatDisplayAmount(targetMl, "dual")} today.`}
          </h2>
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
                <small>{isKidMode ? `${getKidQuickAddLabel(suggestedAmountMl).subtitle} • ${formatMl(suggestedAmountMl)}` : `${formatDisplayAmount(suggestedAmountMl, "dual")} now`}</small>
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
              <h2>{isKidMode ? "Tap what you drank." : "Add water to your dashboard."}</h2>
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
                  {isKidMode ? `${getKidQuickAddLabel(amountMl).subtitle} • ${formatMl(amountMl)}` : amountMl >= 350 ? "Bottle boost" : "Glass boost"}
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
              <h2>Everything you have had today</h2>
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
          </div>

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
                <strong>History will appear after you start logging.</strong>
                <span>Your recent totals will show up here automatically.</span>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderSettings() {
    if (!currentAccount) {
      return null;
    }

    const current = profile ?? profileDraft;
    const policy = currentAccount.childLoggingPolicy ?? defaultChildLoggingPolicy;

    return (
      <section className="content-grid compact-grid">
        <div className="panel glass-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Settings</span>
              <h2>Update your account and intake profile</h2>
            </div>
          </div>

          <div className="field-grid">
            <label className="field">
              <span>Name</span>
              <input
                type="text"
                value={currentAccount.name}
                onChange={(event) => updateCurrentAccount({ name: event.target.value })}
              />
            </label>

            <label className="field">
              <span>Preferred display</span>
              <div className="segmented">
                {(["dual", "metric", "imperial"] as DisplayUnits[]).map((unit) => (
                  <button
                    key={unit}
                    className={current.preferredDisplayUnits === unit ? "is-selected" : ""}
                    onClick={() => updateCurrentAccount({ profile: { ...current, preferredDisplayUnits: unit } })}
                    type="button"
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span>Weight</span>
              <input
                type="number"
                min="20"
                max="300"
                value={current.weight}
                onChange={(event) => updateCurrentAccount({ profile: { ...current, weight: Number(event.target.value) } })}
              />
            </label>

            <label className="field">
              <span>Age</span>
              <input
                type="number"
                min="8"
                max="100"
                value={current.age}
                onChange={(event) => updateCurrentAccount({ profile: { ...current, age: Number(event.target.value) } })}
              />
            </label>

            <label className="field">
              <span>Weight unit</span>
              <div className="segmented">
                {(["kg", "lb"] as WeightUnit[]).map((unit) => (
                  <button
                    key={unit}
                    className={current.weightUnit === unit ? "is-selected" : ""}
                    onClick={() => updateCurrentAccount({ profile: { ...current, weightUnit: unit } })}
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
                    onClick={() => updateCurrentAccount({ profile: { ...current, activityLevel: level } })}
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
                    onClick={() => updateCurrentAccount({ profile: { ...current, climateLevel: level } })}
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
                      <small>
                        Friendly confirmations appear if entries look too big or too fast.
                      </small>
                    </div>
                    <button
                      className={policy.guardrailsEnabled ? "toggle-button is-on" : "toggle-button"}
                      onClick={() =>
                        updateCurrentAccount({
                          childLoggingPolicy: {
                            ...policy,
                            guardrailsEnabled: !policy.guardrailsEnabled,
                          },
                        })
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
                            <small>
                              {event.triggerReason === "entry_limit"
                                ? "Large custom amount"
                                : "Very fast repeated logging"}
                            </small>
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

  const isAuthenticated = Boolean(currentAccount);
  const needsOnboarding = isAuthenticated && !profile;

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
            <span>{isAuthenticated ? `Logged in as ${currentAccount?.name}` : "Futuristic daily hydration"}</span>
          </div>
        </div>
        <div className="top-actions">
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
                ? "Answer a few questions to unlock your dashboard."
                : "Your hydration rhythm is live."}
          </h2>
          <p>
            A playful cockpit for visitors, account creation, profile onboarding, and a dashboard that keeps today’s
            water intake obvious.
          </p>
          <div className="rail-card">
            <span>Flow</span>
            <strong>Landing → Account → Profile → Dashboard</strong>
          </div>
          <div className="rail-card">
            <span>Current recommendation</span>
            <strong>{formatDisplayAmount(targetMl, "dual")}</strong>
          </div>
          <div className="rail-card">
            <span>Progress today</span>
            <strong>{formatDisplayAmount(todayProgressMl, "dual")}</strong>
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
              <button
                className="ghost-button"
                onClick={() => resolveFlaggedEvent(pendingFlaggedEvent.id, "dismissed")}
                type="button"
              >
                Dismiss
              </button>
              <button
                className="cta-button"
                onClick={() => resolveFlaggedEvent(pendingFlaggedEvent.id, "approved", true)}
                type="button"
              >
                Parent approve
              </button>
            </div>
          </div>
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
