export function percent(value: number | null): string {
  if (value === null) return "unavailable";
  return `${(value * 100).toFixed(1)}%`;
}

export function points(value: number | null): string {
  if (value === null) return "unavailable";
  const pp = value * 100;
  return `${pp > 0 ? "+" : ""}${pp.toFixed(1)} pp`;
}

export function interval(value: { low: number; high: number } | null): string {
  if (!value) return "unavailable";
  return `${percent(value.low)} to ${percent(value.high)}`;
}

export function money(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

export function whole(value: number | null): string {
  if (value === null) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function pvalue(value: number | null): string {
  if (value === null) return "undefined";
  if (value < 0.0001) return value.toExponential(2);
  return value.toFixed(4);
}

export function coverageText(known: number, executed: number): string {
  return `${known}/${executed} attempts known`;
}
