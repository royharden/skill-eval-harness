import type { LegacyComparison, LegacyView } from "../../supabase/functions/publish-run/domain/legacy.ts";
import { money, points } from "./format.ts";

const CONDITION_LABEL: Record<string, string> = { skill: "SKILL.md", agents: "AGENTS.md", claude: "CLAUDE.md" };

export function LegacyReport({ view }: { view: LegacyView }) {
  return (
    <section className="report" aria-labelledby="legacy-title">
      <h2 id="legacy-title">{view.name}</h2>
      <p className="banner">
        Legacy v1 record, attestation imported. Pairing on (task, seed) is unverified: these rows carry no prompt, fixture, configuration or
        ambient pins, and their seed is not a predeclared repeat. Only descriptive counts are shown; no interval or test is computed.
      </p>
      <details>
        <summary>Unavailable in legacy records</summary>
        <ul>
          {view.unavailable_fields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
      {view.comparisons.map((c) => (
        <LegacyTable key={`${c.harness}-${c.treatment}`} comparison={c} />
      ))}
    </section>
  );
}

function LegacyTable({ comparison: c }: { comparison: LegacyComparison }) {
  const helpful = c.pairs.filter((p) => !p.baseline_pass && p.treatment_pass).length;
  const harmful = c.pairs.filter((p) => p.baseline_pass && !p.treatment_pass).length;
  const byTask = new Map<string, number[]>();
  for (const p of c.pairs) byTask.set(p.task_id, [...(byTask.get(p.task_id) ?? []), Number(p.treatment_pass) - Number(p.baseline_pass)]);
  const taskMeans = [...byTask.values()].map((d) => d.reduce((s, x) => s + x, 0) / d.length);
  const taskMean = taskMeans.length === 0 ? null : taskMeans.reduce((s, x) => s + x, 0) / taskMeans.length;
  return (
    <article>
      <h3>
        {c.harness}: baseline vs {CONDITION_LABEL[c.treatment] ?? c.treatment}
      </h3>
      <p>
        {c.pairs.length} unverified pairs, {helpful} helpful, {harmful} harmful, {c.unpaired_trials} unpaired trial(s). Observed task-weighted
        delta {points(taskMean)}; pooled {points(c.pairs.length === 0 ? null : (helpful - harmful) / c.pairs.length)}.
      </p>
      <p className="meta">
        Owner-supplied totals: baseline {c.baseline.passes}/{c.baseline.trials} passed, {money(c.baseline.owner_usd_total)}; treatment{" "}
        {c.treatment_arm.passes}/{c.treatment_arm.trials} passed, {money(c.treatment_arm.owner_usd_total)}.
      </p>
      {c.pin_warnings.length > 0 ? (
        <ul className="warnings">
          {c.pin_warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
