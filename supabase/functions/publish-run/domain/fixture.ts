import type { ImportPayload, ImportTrial } from "./types.ts";

const SKILL = "a".repeat(64);
const AGENTS = "b".repeat(64);
const GRADER = "c".repeat(64);

/** Synthetic records for the on-screen sample. No agent produced them. */
export function fixturePayload(): ImportPayload {
  return {
    name: "Sample instruction-file ablation",
    description: "Two tasks, two seeds, baseline against a skill file and an AGENTS.md file. These numbers are synthetic.",
    tasks: [
      {
        slug: "alpha",
        title: "Repair the failing parser",
        prompt: "Make the fixture parser accept a trailing comma and leave the other cases unchanged.",
      },
      {
        slug: "beta",
        title: "Keep the working exporter",
        prompt: "Leave the exporter output byte-for-byte the same while renaming the internal buffer.",
      },
    ],
    trials: [
      row("alpha", "baseline", 1, false, null, 0.02, 100, 40, "none"),
      row("alpha", "baseline", 2, false, null, 0.02, 100, 40, "none"),
      row("beta", "baseline", 1, true, null, 0.03, 90, 30, "none"),
      row("beta", "baseline", 2, true, null, 0.03, 90, 30, "none"),
      row("alpha", "skill", 1, true, true, 0.05, 180, 70, SKILL),
      row("alpha", "skill", 2, true, true, 0.05, 180, 70, SKILL),
      row("beta", "skill", 1, false, true, 0.04, 160, 50, SKILL),
      row("beta", "skill", 2, true, false, 0.04, 140, 40, SKILL),
      row("alpha", "agents", 1, true, true, 0.04, 150, 60, AGENTS),
      row("alpha", "agents", 2, false, true, 0.04, 150, 60, AGENTS),
      row("beta", "agents", 1, true, true, 0.03, 120, 40, AGENTS),
      row("beta", "agents", 2, true, true, 0.03, 120, 40, AGENTS),
    ],
  };
}

function row(
  task: string,
  condition: ImportTrial["condition"],
  seed: number,
  passed: boolean,
  loaded: boolean | null,
  cost: number,
  input: number,
  output: number,
  artifact: string,
): ImportTrial {
  return {
    task_slug: task,
    harness: "claude-code",
    condition,
    seed,
    passed,
    instruction_loaded: loaded,
    input_tokens: input,
    output_tokens: output,
    cost_usd: cost,
    cli_version: "claude 1.0.62-fixture",
    model_id: "claude-fixture-model",
    artifact_sha256: artifact,
    grader_id: "parser-export-checks",
    grader_sha256: GRADER,
  };
}
