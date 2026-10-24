import { compareTrials, type CompareOptions } from "./compare.ts";
import { TRIAL_CAP, type ImportPayload, type Summary, type TrialRecord } from "./types.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function trialsFromImport(payload: ImportPayload): TrialRecord[] {
  return payload.trials.map((trial, index) => ({
    id: `local-${index + 1}`,
    taskId: trial.task_slug,
    taskSlug: trial.task_slug,
    harness: trial.harness,
    condition: trial.condition,
    seed: trial.seed,
    passed: trial.passed,
    instructionLoaded: trial.instruction_loaded,
    inputTokens: trial.input_tokens,
    outputTokens: trial.output_tokens,
    costUsd: trial.cost_usd,
    cliVersion: trial.cli_version,
    modelId: trial.model_id,
    artifactSha256: trial.artifact_sha256,
    graderId: trial.grader_id,
    graderSha256: trial.grader_sha256,
  }));
}

export function previewImport(
  payload: ImportPayload,
  options?: CompareOptions,
): { ok: true; trials: TrialRecord[]; summary: Summary } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object") return { ok: false, errors: ["payload must be an object"] };
  if (!payload.name?.trim()) errors.push("suite name is required");
  if ((payload.name ?? "").trim().length > 160) errors.push("suite name must be at most 160 characters");
  if ((payload.description ?? "").length > 4000) errors.push("description must be at most 4000 characters");
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) errors.push("at least one task is required");
  if (!Array.isArray(payload.trials) || payload.trials.length === 0) errors.push("at least one trial is required");
  if (Array.isArray(payload.trials) && payload.trials.length > TRIAL_CAP) {
    errors.push(`a comparison can include at most ${TRIAL_CAP} trials`);
  }

  const slugs = new Set<string>();
  for (const task of payload.tasks ?? []) {
    if (!SLUG.test(task.slug ?? "")) errors.push(`task slug '${task.slug ?? ""}' must be lowercase letters, numbers, and hyphens`);
    if (slugs.has(task.slug)) errors.push(`duplicate task slug ${task.slug}`);
    slugs.add(task.slug);
    if (!task.prompt?.trim()) errors.push(`task ${task.slug || "(missing slug)"} needs a prompt`);
    if ((task.title ?? "").trim().length > 200) errors.push(`task ${task.slug || "(missing slug)"} title is too long`);
    if ((task.prompt ?? "").length > 8000) errors.push(`task ${task.slug || "(missing slug)"} prompt is too long`);
  }
  for (const trial of payload.trials ?? []) {
    if (!slugs.has(trial.task_slug)) errors.push(`task_slug ${trial.task_slug} is not in tasks`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const trials = trialsFromImport(payload);
  const compared = compareTrials(trials, options);
  if (!compared.ok) return compared;
  return { ok: true, trials, summary: compared.summary };
}
