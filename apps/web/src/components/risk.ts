export function prRiskColor(score: number): string {
  if (score >= 50) return "text-[var(--red)]";
  if (score >= 20) return "text-[var(--yellow)]";
  return "text-[var(--green)]";
}

export function riskLabel(score: number): string {
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}
