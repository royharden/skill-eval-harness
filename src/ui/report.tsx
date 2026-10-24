import { isSummary, type ConditionReport, type HarnessReport, type Summary } from "../../supabase/functions/publish-run/domain/types.ts";

const CONDITION_LABEL: Record<string, string> = {
  baseline: "Baseline",
  skill: "SKILL.md",
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
};

const HARNESS_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function Report({ summary, title }: { summary: Summary; title: string }) {
  if (!isSummary(summary)) return <p className="warning">This snapshot is not a version 1 comparison.</p>;
  return (
    <section className="report">
      <h2>{title}</h2>
      <p className="banner">
        Attestation: owner-supplied. These figures were recomputed from the records in view. This page did not execute
        Claude Code or Codex.
      </p>
      <p className="meta">
        Bootstrap {summary.bootstrapDraws.toLocaleString("en-US")} draws, seed {summary.bootstrapSeed}. Pins:{" "}
        {summary.pins.cliVersions.join(", ") || "none"} / {summary.pins.modelIds.join(", ") || "none"}.
      </p>
      {summary.harnesses.map((harness) => (
        <HarnessTable key={harness.harness} harness={harness} />
      ))}
    </section>
  );
}

function HarnessTable({ harness }: { harness: HarnessReport }) {
  return (
    <article>
      <h3>{HARNESS_LABEL[harness.harness] ?? harness.harness}</h3>
      <div className="table-wrap">
        <table>
          <caption>{HARNESS_LABEL[harness.harness] ?? harness.harness} against baseline</caption>
          <thead>
            <tr>
              <th>Condition</th>
              <th>Pass rate</th>
              <th>Wilson 95%</th>
              <th>Paired difference</th>
              <th>Verdict</th>
              <th>USD / pass</th>
              <th>Tokens / pass</th>
              <th>Loaded</th>
            </tr>
          </thead>
          <tbody>
            {harness.baseline ? (
              <tr>
                <th scope="row">Baseline</th>
                <td className="num">{rate(harness.baseline.passes, harness.baseline.trials, harness.baseline.passRate)}</td>
                <td className="num">{interval(harness.baseline.wilson)}</td>
                <td>reference</td>
                <td>—</td>
                <td className="num">{money(harness.baseline.cost.usdPerPass)}</td>
                <td className="num">{count(harness.baseline.cost.tokensPerPass)}</td>
                <td>—</td>
              </tr>
            ) : null}
            {harness.conditions.map((condition) => (
              <ConditionRow key={condition.condition} condition={condition} />
            ))}
          </tbody>
        </table>
      </div>
      <WarningList warnings={[...harness.warnings, ...harness.conditions.flatMap((condition) => condition.warnings)]} />
      {harness.conditions.map((condition) => (
        <details key={`${condition.condition}-flips`} open>
          <summary>
            Flips for {CONDITION_LABEL[condition.condition] ?? condition.condition} ({condition.pairedTrials} paired)
          </summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Seed</th>
                  <th>Baseline</th>
                  <th>Treatment</th>
                  <th>Loaded</th>
                </tr>
              </thead>
              <tbody>
                {condition.flips.map((flip) => (
                  <tr key={`${flip.taskId}-${flip.seed}`}>
                    <td>{flip.taskSlug}</td>
                    <td className="num">{flip.seed}</td>
                    <td>{flip.baselinePassed ? "pass" : "fail"}</td>
                    <td>{flip.treatmentPassed ? "pass" : "fail"}</td>
                    <td>{flip.treatmentLoaded === true ? "yes" : flip.treatmentLoaded === false ? "no" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="meta">
            Both pass {condition.counts.bothPass}, both fail {condition.counts.bothFail}, baseline only{" "}
            {condition.counts.baselineOnly}, treatment only {condition.counts.treatmentOnly}. McNemar discordant{" "}
            {condition.mcnemar.discordant}, p {pvalue(condition.mcnemar.pValue)}.
            {condition.unpairedTrialIds.length > 0
              ? ` Unpaired trials: ${condition.unpairedTrialIds.join(", ")}.`
              : ""}
          </p>
        </details>
      ))}
    </article>
  );
}

function ConditionRow({ condition }: { condition: ConditionReport }) {
  return (
    <tr>
      <th scope="row">{CONDITION_LABEL[condition.condition] ?? condition.condition}</th>
      <td className="num">{rate(condition.passes, condition.trials, condition.passRate)}</td>
      <td className="num">{interval(condition.wilson)}</td>
      <td className="num">
        {points(condition.pairedDifference.estimate)}
        <span className="muted"> ({points(condition.pairedDifference.low)} to {points(condition.pairedDifference.high)})</span>
      </td>
      <td data-verdict={condition.verdict} data-winner={condition.winner ?? "none"}>
        {verdictLabel(condition.verdict, condition.winner)}
      </td>
      <td className="num">{money(condition.cost.usdPerPass)}</td>
      <td className="num">{count(condition.cost.tokensPerPass)}</td>
      <td className="num">
        {condition.loaded.loaded}/{condition.loaded.applicable}
        {condition.loaded.notLoaded > 0 ? `, ${condition.loaded.notLoaded} missed` : ""}
      </td>
    </tr>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  const unique = [...new Set(warnings)];
  if (unique.length === 0) return null;
  return (
    <ul className="warnings">
      {unique.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

function verdictLabel(verdict: string, winner: string | null): string {
  if (verdict === "winner" && winner === "treatment") return "treatment wins";
  if (verdict === "winner" && winner === "baseline") return "baseline wins";
  if (verdict === "no-winner") return "no winner";
  return "uninformative";
}

function rate(passes: number, trials: number, value: number | null): string {
  if (value === null) return "—";
  return `${passes}/${trials} · ${percent(value)}`;
}

function interval(value: { low: number; high: number } | null): string {
  if (!value) return "unavailable";
  return `${percent(value.low)} to ${percent(value.high)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function points(value: number | null): string {
  if (value === null) return "unavailable";
  const pp = value * 100;
  const sign = pp > 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)} pp`;
}

function money(value: number | null): string {
  if (value === null) return "undefined";
  return `$${value.toFixed(4)}`;
}

function count(value: number | null): string {
  if (value === null) return "undefined";
  return value.toFixed(0);
}

function pvalue(value: number | null): string {
  if (value === null) return "not defined";
  if (value < 0.0001) return value.toExponential(2);
  return value.toFixed(4);
}
