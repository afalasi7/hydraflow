import type {
  ActivityLevel,
  ClimateLevel,
  DisplayUnits,
  HydrationLogEntry,
  UserProfile,
  WeightUnit,
} from "../types";
import { formatDayLabel, getLocalDateKey, isSameLocalDate } from "./date";

const ML_PER_KG = 33;

const activityBonus: Record<ActivityLevel, number> = {
  low: 0,
  moderate: 350,
  high: 700,
};

const climateBonus: Record<ClimateLevel, number> = {
  cool: 0,
  warm: 250,
  hot: 500,
};

export function convertWeightToKg(weight: number, unit: WeightUnit): number {
  return unit === "kg" ? weight : weight * 0.45359237;
}

export function calculateTargetMl(profile: UserProfile): number {
  const weightKg = convertWeightToKg(profile.weight, profile.weightUnit);
  const baselineMl = Math.round(weightKg * ML_PER_KG);
  const ageAdjustment = profile.age >= 56 ? -150 : profile.age <= 18 ? 180 : 0;
  return baselineMl + activityBonus[profile.activityLevel] + climateBonus[profile.climateLevel] + ageAdjustment;
}

export function mlToLiters(ml: number): number {
  return ml / 1000;
}

export function mlToOz(ml: number): number {
  return ml / 29.5735;
}

export function ozToMl(oz: number): number {
  return oz * 29.5735;
}

export function formatMl(ml: number): string {
  return `${Math.round(ml).toLocaleString()} ml`;
}

export function formatLiters(ml: number): string {
  return `${mlToLiters(ml).toFixed(1)} L`;
}

export function formatOz(ml: number): string {
  return `${Math.round(mlToOz(ml))} oz`;
}

export function formatDisplayAmount(ml: number, units: DisplayUnits): string {
  if (units === "metric") {
    return `${formatLiters(ml)} • ${formatMl(ml)}`;
  }

  if (units === "imperial") {
    return formatOz(ml);
  }

  return `${formatLiters(ml)} • ${formatOz(ml)}`;
}

export function getQuickAddOptions(units: DisplayUnits): number[] {
  if (units === "imperial") {
    return [237, 355, 473, 710];
  }

  return [150, 250, 350, 500];
}

export function getKidQuickAddOptions(): number[] {
  return [120, 180, 250, 350];
}

export function getCupCountLabel(totalMl: number): string {
  const cups = Math.max(0, Math.round(totalMl / 180));
  if (cups === 1) {
    return "1 cup";
  }

  return `${cups} cups`;
}

export function getTodayProgress(entries: HydrationLogEntry[], todayKey: string): number {
  return entries
    .filter((entry) => isSameLocalDate(entry.timestamp, todayKey))
    .reduce((sum, entry) => sum + entry.amountMl, 0);
}

export function getRecentDailyTotals(entries: HydrationLogEntry[], days = 5) {
  const buckets = new Map<string, number>();

  for (const entry of entries) {
    const key = getLocalDateKey(new Date(entry.timestamp));
    buckets.set(key, (buckets.get(key) ?? 0) + entry.amountMl);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-days)
    .map(([dateKey, totalMl]) => ({
      dateKey,
      label: formatDayLabel(dateKey),
      totalMl,
    }));
}

export function getTargetBreakdown(profile: UserProfile) {
  const weightKg = convertWeightToKg(profile.weight, profile.weightUnit);
  const base = Math.round(weightKg * ML_PER_KG);
  const activity = activityBonus[profile.activityLevel];
  const climate = climateBonus[profile.climateLevel];
  const age = profile.age >= 56 ? -150 : profile.age <= 18 ? 180 : 0;
  const total = base + activity + climate + age;

  return { base, activity, climate, age, total };
}

export function getEncouragement(progressRatio: number): string {
  if (progressRatio >= 1) {
    return "Target met. You can coast from here.";
  }

  if (progressRatio >= 0.75) {
    return "Strong pace. One more refill should do it.";
  }

  if (progressRatio >= 0.5) {
    return "You are right in the hydration groove.";
  }

  if (progressRatio >= 0.25) {
    return "Good start. Keep the rhythm steady.";
  }

  return "Fresh day. Stack easy sips and build momentum.";
}
