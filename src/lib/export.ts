import type { HydrationLogEntry, MemberProfileRecord } from "../types";

function escapeCsv(value: string | number) {
  const text = String(value);
  if (text.includes(",") || text.includes("\n") || text.includes('"')) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function buildEntryRows(profile: MemberProfileRecord) {
  const header = ["profile_name", "timestamp", "amount_ml", "source_type"];
  const rows = profile.entries.map((entry: HydrationLogEntry) => [
    profile.name,
    entry.timestamp,
    entry.amountMl,
    entry.sourceType,
  ]);

  return [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function downloadProfileCsv(profile: MemberProfileRecord) {
  const blob = new Blob([buildEntryRows(profile)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = profile.name.trim().toLowerCase().replace(/\s+/g, "-") || "profile";
  link.href = url;
  link.download = `${safeName}-hydration-log.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadFamilyCsv(profiles: MemberProfileRecord[]) {
  const sections = profiles.map((profile) => buildEntryRows(profile));
  const blob = new Blob([sections.join("\n\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "hydraflow-family-export.csv";
  link.click();
  URL.revokeObjectURL(url);
}
