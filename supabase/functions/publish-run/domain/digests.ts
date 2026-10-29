// Experiment, arm and ledger digests (PLAN.md §4–§5). No self-hash cycles:
// arm_digest excludes itself; experiment_digest excludes arms, its own field and the free-text notes label.

import { digestOf, sortTasks } from "./canonical.ts";
import type { ArmDescriptor, Digest, ExperimentSpec, LedgerEdition, Sha256Port } from "./contracts.ts";

export type UnsealedArm = Omit<ArmDescriptor, "arm_digest">;
export type UnsealedSpec = Omit<ExperimentSpec, "experiment_digest" | "arms"> & { arms: [UnsealedArm, UnsealedArm] };

export function armDigestInput(arm: UnsealedArm | ArmDescriptor): UnsealedArm {
  return {
    arm_id: arm.arm_id,
    artifact_kind: arm.artifact_kind,
    artifact_digest: arm.artifact_digest,
    bundle_files_digest: arm.bundle_files_digest,
    exposure_mode: arm.exposure_mode,
    prompt_overlay_digest: arm.prompt_overlay_digest,
    config_differences: [...arm.config_differences],
  };
}

export async function computeArmDigest(arm: UnsealedArm | ArmDescriptor, sha256: Sha256Port): Promise<Digest> {
  return digestOf(armDigestInput(arm), sha256);
}

export function experimentDigestInput(spec: UnsealedSpec | ExperimentSpec): Record<string, unknown> {
  return {
    schema_version: spec.schema_version,
    experiment_id: spec.experiment_id,
    suite: spec.suite,
    tasks: sortTasks(spec.tasks),
    harness_id: spec.harness_id,
    supported_cli_version_range: spec.supported_cli_version_range,
    pinned_cli_version: spec.pinned_cli_version,
    requested_model_id: spec.requested_model_id,
    resolved_model_policy: spec.resolved_model_policy,
    effort: spec.effort,
    base_tool_permission_config: spec.base_tool_permission_config,
    environment_allowlist_names: [...spec.environment_allowlist_names].sort(),
    ambient_context_digest: spec.ambient_context_digest,
    repeats: spec.repeats,
    scheduling_seed: spec.scheduling_seed,
    retry_policy: spec.retry_policy,
    limits: spec.limits,
    intervention: spec.intervention,
  };
}

export async function computeExperimentDigest(spec: UnsealedSpec | ExperimentSpec, sha256: Sha256Port): Promise<Digest> {
  return digestOf(experimentDigestInput(spec), sha256);
}

export async function sealSpec(spec: UnsealedSpec, sha256: Sha256Port): Promise<ExperimentSpec> {
  const baseline = { ...spec.arms[0], arm_digest: await computeArmDigest(spec.arms[0], sha256) };
  const treatment = { ...spec.arms[1], arm_digest: await computeArmDigest(spec.arms[1], sha256) };
  return { ...spec, arms: [baseline, treatment], experiment_digest: await computeExperimentDigest(spec, sha256) };
}

/** Recomputes digests and reports any mismatch with the declared values. */
export async function verifySpecDigests(spec: ExperimentSpec, sha256: Sha256Port): Promise<string[]> {
  const errors: string[] = [];
  const experiment = await computeExperimentDigest(spec, sha256);
  if (experiment !== spec.experiment_digest) errors.push("experiment_digest does not match the invariant configuration");
  for (const arm of spec.arms) {
    if ((await computeArmDigest(arm, sha256)) !== arm.arm_digest) errors.push(`${arm.arm_id} arm_digest does not match its descriptor`);
  }
  return errors;
}

export async function ledgerDigest(ledger: LedgerEdition, sha256: Sha256Port): Promise<Digest> {
  return digestOf(ledger, sha256);
}
