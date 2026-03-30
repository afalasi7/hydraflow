export type WeightUnit = "kg" | "lb";
export type DisplayUnits = "dual" | "metric" | "imperial";
export type ActivityLevel = "low" | "moderate" | "high";
export type ClimateLevel = "cool" | "warm" | "hot";
export type SourceType = "quick_add" | "custom";
export type Screen = "today" | "history" | "settings";
export type AuthMode = "landing" | "login" | "signup";
export type GuardrailReason = "entry_limit" | "burst_limit";
export type GuardrailResolution = "pending" | "approved" | "dismissed" | "expired";

export interface UserProfile {
  weight: number;
  age: number;
  weightUnit: WeightUnit;
  activityLevel: ActivityLevel;
  climateLevel: ClimateLevel;
  preferredDisplayUnits: DisplayUnits;
}

export interface HydrationLogEntry {
  id: string;
  timestamp: string;
  amountMl: number;
  sourceType: SourceType;
}

export interface ChildLoggingPolicy {
  guardrailsEnabled: boolean;
  suspiciousEntryMl: number;
  burstLimitCount: number;
  burstWindowMinutes: number;
}

export interface FlaggedLoggingEvent {
  id: string;
  childProfileId: string;
  attemptedAmountMl: number;
  timestamp: string;
  triggerReason: GuardrailReason;
  resolution: GuardrailResolution;
  sourceType: SourceType;
}

export interface AccountRecord {
  id: string;
  name: string;
  email: string;
  password: string;
  createdAt: string;
  profile: UserProfile | null;
  entries: HydrationLogEntry[];
  childLoggingPolicy?: ChildLoggingPolicy;
  flaggedEvents?: FlaggedLoggingEvent[];
}

export interface PersistedState {
  version: number;
  currentUserId: string | null;
  accounts: AccountRecord[];
}
