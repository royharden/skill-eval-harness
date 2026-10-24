const EXACT_LIMIT = 50;

/** Two-sided exact McNemar test. Probability mass at least as small as the observed discordant split. */
export function mcnemarExact(
  treatmentOnly: number,
  baselineOnly: number,
): { discordant: number; pValue: number | null } {
  if (
    !Number.isInteger(treatmentOnly) ||
    !Number.isInteger(baselineOnly) ||
    treatmentOnly < 0 ||
    baselineOnly < 0
  ) {
    throw new Error("McNemar counts must be non-negative integers");
  }
  const n = treatmentOnly + baselineOnly;
  if (n === 0) return { discordant: 0, pValue: null };
  if (n <= EXACT_LIMIT) {
    const observed = binom(n, treatmentOnly);
    let favor = 0;
    for (let k = 0; k <= n; k += 1) {
      const coeff = binom(n, k);
      if (coeff <= observed + 1e-9) favor += coeff;
    }
    return { discordant: n, pValue: favor / 2 ** n };
  }
  return { discordant: n, pValue: logSpaceP(n, treatmentOnly) };
}

function binom(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) {
    result = (result * (n - kk + i)) / i;
  }
  return result;
}

function logChoose(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let sum = 0;
  for (let i = 1; i <= kk; i += 1) {
    sum += Math.log(n - kk + i) - Math.log(i);
  }
  return sum;
}

function logSpaceP(n: number, observedK: number): number {
  const logObserved = logChoose(n, observedK) - n * Math.LN2;
  let p = 0;
  for (let k = 0; k <= n; k += 1) {
    const logPk = logChoose(n, k) - n * Math.LN2;
    if (logPk <= logObserved + 1e-12) p += Math.exp(logPk);
  }
  return Math.min(1, p);
}
