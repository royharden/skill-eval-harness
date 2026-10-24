import type { TrialRecord } from "./types.ts";

export interface StoredTrialRow {
  id: string;
  task_id: string;
  task_slug: string;
  harness: string;
  condition: string;
  seed: number | string;
  passed: boolean;
  instruction_loaded: boolean | null;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_usd: number | string;
  cli_version: string;
  model_id: string;
  artifact_sha256: string;
  grader_id: string;
  grader_sha256: string;
}

export function trialFromStoredRow(row: StoredTrialRow): TrialRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskSlug: row.task_slug,
    harness: row.harness as TrialRecord["harness"],
    condition: row.condition as TrialRecord["condition"],
    seed: asInt(row.seed, "seed"),
    passed: row.passed,
    instructionLoaded: row.instruction_loaded,
    inputTokens: asInt(row.input_tokens, "input_tokens"),
    outputTokens: asInt(row.output_tokens, "output_tokens"),
    costUsd: asFloat(row.cost_usd, "cost_usd"),
    cliVersion: row.cli_version,
    modelId: row.model_id,
    artifactSha256: row.artifact_sha256,
    graderId: row.grader_id,
    graderSha256: row.grader_sha256,
  };
}

function asInt(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} is not an integer`);
  return parsed;
}

function asFloat(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a finite number`);
  return parsed;
}
