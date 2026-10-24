import { CONDITIONS, HARNESSES, TRIAL_CAP, type TrialRecord } from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export function validateTrial(trial: TrialRecord): string[] {
  const errors: string[] = [];
  const label = trial.id || "(missing id)";
  if (!trial.id) errors.push("a trial is missing an id");
  if (!trial.taskId) errors.push(`${label}: task id is required`);
  if (!trial.taskSlug) errors.push(`${label}: task slug is required`);
  if (!HARNESSES.includes(trial.harness)) errors.push(`${label}: harness must be claude-code or codex`);
  if (!CONDITIONS.includes(trial.condition)) errors.push(`${label}: condition is not supported`);
  if (!Number.isInteger(trial.seed) || trial.seed < 0) errors.push(`${label}: seed must be an integer >= 0`);
  if (typeof trial.passed !== "boolean") errors.push(`${label}: passed must be true or false`);
  if (!Number.isInteger(trial.inputTokens) || trial.inputTokens < 0) {
    errors.push(`${label}: input tokens must be an integer >= 0`);
  }
  if (!Number.isInteger(trial.outputTokens) || trial.outputTokens < 0) {
    errors.push(`${label}: output tokens must be an integer >= 0`);
  }
  if (!Number.isFinite(trial.costUsd) || trial.costUsd < 0) {
    errors.push(`${label}: cost_usd must be a finite number >= 0`);
  }
  if (!cleanPin(trial.cliVersion)) errors.push(`${label}: cli version is required`);
  if (!cleanPin(trial.modelId)) errors.push(`${label}: model id is required`);
  if (!cleanPin(trial.graderId)) errors.push(`${label}: grader id is required`);
  if (!SHA256.test(trial.graderSha256)) errors.push(`${label}: grader sha256 must be 64 hex characters`);

  if (trial.condition === "baseline") {
    if (trial.artifactSha256 !== "none") errors.push(`${label}: baseline artifact sha must be none`);
    if (trial.instructionLoaded !== null) errors.push(`${label}: baseline instructionLoaded must be null`);
  } else {
    if (!SHA256.test(trial.artifactSha256)) {
      errors.push(`${label}: treatment artifact sha must be 64 hex characters`);
    }
    if (typeof trial.instructionLoaded !== "boolean") {
      errors.push(`${label}: treatment instructionLoaded must be true or false`);
    }
  }
  return errors;
}

export function validateBatch(trials: TrialRecord[]): string[] {
  if (trials.length > TRIAL_CAP) return [`a comparison can include at most ${TRIAL_CAP} trials`];
  const errors = trials.flatMap((trial) => validateTrial(trial));
  const seen = new Set<string>();
  for (const trial of trials) {
    const key = `${trial.harness}\u0000${trial.condition}\u0000${trial.taskId}\u0000${trial.seed}`;
    if (seen.has(key)) {
      errors.push(`duplicate trial ${trial.harness} ${trial.condition} ${trial.taskSlug} seed ${trial.seed}`);
    }
    seen.add(key);
  }
  return errors;
}

function cleanPin(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
