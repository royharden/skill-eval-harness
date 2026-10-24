export const HARNESSES = ["claude-code", "codex"] as const;
export const CONDITIONS = ["baseline", "skill", "agents", "claude"] as const;
export const TREATMENT_CONDITIONS = ["skill", "agents", "claude"] as const;

export const Z95 = 1.959963984540054;
export const TRIAL_CAP = 2000;
export const DEFAULT_DRAWS = 2000;
export const DEFAULT_SEED = 20261023;

export type Harness = (typeof HARNESSES)[number];
export type Condition = (typeof CONDITIONS)[number];
export type TreatmentCondition = (typeof TREATMENT_CONDITIONS)[number];
export type VerdictKind = "winner" | "no-winner" | "uninformative";
export type WinnerSide = "treatment" | "baseline" | null;

export interface TrialRecord {
  id: string;
  taskId: string;
  taskSlug: string;
  harness: Harness;
  condition: Condition;
  seed: number;
  passed: boolean;
  instructionLoaded: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cliVersion: string;
  modelId: string;
  artifactSha256: string;
  graderId: string;
  graderSha256: string;
}

export interface ImportTask {
  slug: string;
  title: string;
  prompt: string;
}

export interface ImportTrial {
  task_slug: string;
  harness: Harness;
  condition: Condition;
  seed: number;
  passed: boolean;
  instruction_loaded: boolean | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cli_version: string;
  model_id: string;
  artifact_sha256: string;
  grader_id: string;
  grader_sha256: string;
}

export interface ImportPayload {
  name: string;
  description: string;
  tasks: ImportTask[];
  trials: ImportTrial[];
}

export interface PairFlip {
  taskId: string;
  taskSlug: string;
  seed: number;
  baselinePassed: boolean;
  treatmentPassed: boolean;
  treatmentLoaded: boolean | null;
}

export interface CostReport {
  totalUsd: number;
  usdPerPass: number | null;
  totalTokens: number;
  tokensPerPass: number | null;
  passes: number;
}

export interface ConditionReport {
  condition: TreatmentCondition;
  baseline: "baseline";
  trials: number;
  passes: number;
  passRate: number | null;
  wilson: { low: number; high: number } | null;
  baselineTrials: number;
  baselinePasses: number;
  baselinePassRate: number | null;
  baselineWilson: { low: number; high: number } | null;
  pairedTrials: number;
  unpairedTrialIds: string[];
  flips: PairFlip[];
  counts: {
    bothPass: number;
    bothFail: number;
    baselineOnly: number;
    treatmentOnly: number;
  };
  mcnemar: { discordant: number; pValue: number | null };
  pairedDifference: {
    estimate: number | null;
    low: number | null;
    high: number | null;
    method: "task-bootstrap" | "unavailable";
    draws: number;
    seed: number;
    degenerate: boolean;
  };
  verdict: VerdictKind;
  winner: WinnerSide;
  cost: CostReport;
  baselineCost: CostReport;
  loaded: { applicable: number; loaded: number; notLoaded: number };
  warnings: string[];
}

export interface ArmReport {
  trials: number;
  passes: number;
  passRate: number | null;
  wilson: { low: number; high: number } | null;
  cost: CostReport;
  warnings: string[];
}

export interface HarnessReport {
  harness: Harness;
  baseline: ArmReport | null;
  conditions: ConditionReport[];
  warnings: string[];
}

export interface Summary {
  schemaVersion: 1;
  attestation: "owner-supplied";
  generatedBy: "publish-run";
  bootstrapDraws: number;
  bootstrapSeed: number;
  harnesses: HarnessReport[];
  pins: {
    cliVersions: string[];
    modelIds: string[];
    artifactShas: string[];
    graderIds: string[];
    graderShas: string[];
  };
  warnings: string[];
}

export function isSummary(value: unknown): value is Summary {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Summary>;
  return record.schemaVersion === 1 && record.attestation === "owner-supplied" && Array.isArray(record.harnesses);
}
