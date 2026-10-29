import type { RunRecords } from "../../supabase/functions/publish-run/domain/contracts.ts";
import type { RunManifest } from "../../supabase/functions/publish-run/domain/manifest.ts";
import type { ArmSummary, RunSummary } from "../../supabase/functions/publish-run/domain/summary.ts";
import { coverageText, interval, money, percent, points, pvalue, whole } from "./format.ts";

const DIRECTION_TEXT: Record<RunSummary["effect"]["direction"], string> = {
  "favors-treatment": "Observed delta favors the treatment",
  "favors-baseline": "Observed delta favors the baseline",
  tie: "Observed delta is a tie",
  unavailable: "Effect unavailable",
};

const ATTESTATION_TEXT: Record<string, string> = {
  runner: "runner (claimed origin: local runner)",
  "replay-synthetic": "replay-synthetic (fabricated or replayed events, not a live agent)",
  imported: "imported (owner claim, not execution proof)",
};

export function RunReport({ summary, records, manifest, idPrefix = "report" }: { summary: RunSummary; records: RunRecords; manifest: RunManifest | null; idPrefix?: string }) {
  const c = summary.counts;
  const u = summary.uncertainty;
  const treatment = records.spec.arms[1];
  return (
    <section className="report" aria-labelledby={`${idPrefix}-title`}>
      <h2 id={`${idPrefix}-title`}>{records.spec.experiment_id}</h2>
      {records.spec.notes ? <p className="banner">{records.spec.notes}</p> : null}
      <ul className="badges" aria-label="Provenance and capability">
        {summary.attestations.map((a) => (
          <li key={a}>Attestation: {ATTESTATION_TEXT[a] ?? a}</li>
        ))}
        <li>Harness: {summary.harness_id}</li>
        <li>
          Treatment: {treatment.artifact_kind}, exposure mode {treatment.exposure_mode}
        </li>
        <li>Manifest: {manifest ? `${manifest.manifest_kind}, verified against supplied bytes` : "none (in-memory sample)"}</li>
        <li>Method: {summary.method_version}</li>
      </ul>
      <p className="meta">
        Matching hashes prove integrity against the supplied manifest only. They do not prove agent execution, honesty, or that a rerun
        would reproduce these stochastic outcomes. Results apply only to this suite and recorded environment.
      </p>

      <h3>Coverage</h3>
      <dl className="counts">
        <div><dt>Planned sides</dt><dd>{c.planned_sides}</dd></div>
        <div><dt>Attempted sides</dt><dd>{c.attempted_sides}</dd></div>
        <div><dt>Not started</dt><dd>{c.not_started_sides}</dd></div>
        {c.pending_sides > 0 ? <div><dt>Still planned</dt><dd>{c.pending_sides}</dd></div> : null}
        <div><dt>Finalized attempts</dt><dd>{c.finalized_attempts}</dd></div>
        <div><dt>Complete pairs</dt><dd>{c.complete_pairs}</dd></div>
        <div><dt>Contributing tasks</dt><dd>{c.contributing_tasks} of {c.tasks}</dd></div>
        <div><dt>Repeats</dt><dd>{c.repeats}</dd></div>
        <div><dt>Incomplete blocks</dt><dd>{c.incomplete_blocks}</dd></div>
        <div><dt>Excluded (pin mismatch)</dt><dd>{c.excluded_attempts}</dd></div>
      </dl>

      <h3>Paired effect</h3>
      <div className="effect">
        <p>
          <strong>{DIRECTION_TEXT[summary.effect.direction]}</strong>
          {summary.effect.primary_task_mean !== null ? `: ${points(summary.effect.primary_task_mean)} (task-weighted mean of per-task deltas).` : "."}
        </p>
        <p>
          Pooled descriptive effect: {points(summary.effect.pooled_descriptive)} ((helpful − harmful) / complete pairs). It weights tasks by
          how many pairs they contributed.
        </p>
        <p>
          Empirical 95% task-cluster bootstrap: {u.low === null || u.high === null ? "unavailable" : `${points(u.low)} to ${points(u.high)}`}.{" "}
          {u.note} <span className="muted">({u.resamples.toLocaleString("en-US")} resamples, seed {u.seed}, {u.prng}, {u.percentile}.)</span>
        </p>
        <p>
          Exact McNemar on repeat 0 only: {summary.mcnemar_repeat0.pairs} pair(s), discordant {summary.mcnemar_repeat0.discordant} (
          {summary.mcnemar_repeat0.n01} helpful, {summary.mcnemar_repeat0.n10} harmful), two-sided p {pvalue(summary.mcnemar_repeat0.p_value)}.{" "}
          {summary.mcnemar_repeat0.note}
          {summary.mcnemar_repeat0.tasks_without_repeat0_pair.length > 0
            ? ` Tasks without a repeat-0 pair: ${summary.mcnemar_repeat0.tasks_without_repeat0_pair.join(", ")}.`
            : ""}
        </p>
        <p className="muted">No winner label is computed. Arm intervals overlapping or not is not a paired test.</p>
      </div>

      <div className="table-wrap">
        <table>
          <caption>Complete pairs</caption>
          <thead>
            <tr><th scope="col"></th><th scope="col">Treatment pass</th><th scope="col">Treatment fail</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Baseline pass</th><td className="num">{summary.table.n11}</td><td className="num">{summary.table.n10} harmful</td></tr>
            <tr><th scope="row">Baseline fail</th><td className="num">{summary.table.n01} helpful</td><td className="num">{summary.table.n00}</td></tr>
          </tbody>
        </table>
      </div>

      <h3>Arms</h3>
      <div className="table-wrap">
        <table>
          <caption>Per-arm outcomes, operations and cost</caption>
          <thead>
            <tr>
              <th scope="col">Arm</th>
              <th scope="col">Pass rate (eligible)</th>
              <th scope="col">Wilson 95% (descriptive)</th>
              <th scope="col">Operational success</th>
              <th scope="col">Status counts</th>
              <th scope="col">Known USD</th>
              <th scope="col">USD / passing attempt</th>
              <th scope="col">USD / task solved</th>
              <th scope="col">Tokens / passing attempt</th>
            </tr>
          </thead>
          <tbody>
            <ArmRow arm={summary.arms.baseline} />
            <ArmRow arm={summary.arms.treatment} />
          </tbody>
        </table>
      </div>
      {[summary.arms.baseline, summary.arms.treatment]
        .filter((a) => a.cost.ratio_note)
        .map((a) => (
          <p key={`ratio-${a.arm_id}`} className="meta">
            {a.arm_id}: {a.cost.ratio_note}
          </p>
        ))}
      <p className="meta">
        Wilson intervals pool correlated repeats and are descriptive. Cost totals include every executed attempt; ratios use selected attempts
        and are suppressed when any executed attempt has unknown cost or nothing passed.
      </p>

      <h3>Exposure (descriptive only)</h3>
      <p className="meta">
        Observed means the artifact was accessed or injected, not that it was used correctly. Missing events are unknown. These rows are never
        the primary effect.
      </p>
      <ul>
        {summary.exposure_descriptive.map((row) => (
          <li key={row.status}>
            Treatment exposure {row.status}: {row.passes}/{row.selected} selected attempts passed
          </li>
        ))}
      </ul>

      <h3>Tasks</h3>
      {summary.effect.per_task.map((task) => (
        <details key={task.task_id}>
          <summary>
            {task.display_label} <span className="muted">({task.task_id})</span>: k/n baseline {task.baseline_passes}/{task.complete_pairs}, treatment{" "}
            {task.treatment_passes}/{task.complete_pairs}, d<sub>t</sub> {points(task.d_t)}, {task.helpful} helpful, {task.harmful} harmful
          </summary>
          <TaskPairs records={records} taskId={task.task_id} summary={summary} />
        </details>
      ))}

      {summary.excluded.length > 0 ? (
        <>
          <h3>Excluded attempts</h3>
          <ul className="warnings">
            {summary.excluded.map((e, i) => (
              <li key={`${e.attempt_id}-${i}`}>
                {e.attempt_id}: {e.reasons.join("; ")}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {summary.notes.length > 0 ? (
        <ul className="warnings">
          {summary.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ArmRow({ arm }: { arm: ArmSummary }) {
  const statuses = Object.entries(arm.status_counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`);
  if (arm.not_started_sides > 0) statuses.push(`not_started ${arm.not_started_sides}`);
  return (
    <tr>
      <th scope="row">{arm.arm_id}</th>
      <td className="num">
        {arm.passes}/{arm.eligible_denominator} · {percent(arm.pass_rate)}
      </td>
      <td className="num">{interval(arm.wilson_descriptive)}</td>
      <td className="num">
        {arm.passes}/{arm.planned_sides} · {percent(arm.operational_success)}
      </td>
      <td>{statuses.join(", ") || "—"}</td>
      <td className="num">
        {money(arm.cost.known_total)}
        <span className="muted">
          {" "}
          ({coverageText(arm.cost.known_attempts, arm.cost.executed_attempts)}; reported {money(arm.cost.reported_usd)}, estimated {money(arm.cost.estimated_usd)})
        </span>
      </td>
      <td className="num" title={arm.cost.ratio_note ?? undefined}>
        {money(arm.cost.usd_per_passing_attempt)}
      </td>
      <td className="num" title={arm.cost.ratio_note ?? undefined}>
        {money(arm.cost.usd_per_task_solved)}
      </td>
      <td className="num">
        {whole(arm.tokens.per_passing_attempt)}
        <span className="muted"> ({coverageText(arm.tokens.known_attempts, arm.tokens.executed_attempts)})</span>
      </td>
    </tr>
  );
}

function TaskPairs({ records, taskId, summary }: { records: RunRecords; taskId: string; summary: RunSummary }) {
  const rows = Array.from({ length: records.spec.repeats }, (_, repeat) => {
    const side = (arm: "baseline" | "treatment") => records.ledger.sides.find((s) => s.task_id === taskId && s.repeat_id === repeat && s.arm_id === arm);
    const attempt = (arm: "baseline" | "treatment") => {
      const id = side(arm)?.selected_attempt_id;
      return id ? records.attempts.find((a) => a.attempt_id === id) : undefined;
    };
    const b = attempt("baseline");
    const t = attempt("treatment");
    const gap = summary.incomplete.find((x) => x.task_id === taskId && x.repeat_id === repeat);
    return (
      <tr key={repeat}>
        <td className="num">{repeat}</td>
        <td>{b ? b.status : side("baseline")?.state ?? "missing"}</td>
        <td>{t ? t.status : side("treatment")?.state ?? "missing"}</td>
        <td>{t ? `${t.exposure.status} (${t.exposure.mechanism})` : "—"}</td>
        <td>{gap ? `not paired: ${gap.reasons.join("; ")}` : "complete pair"}</td>
      </tr>
    );
  });
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Repeat</th>
            <th scope="col">Baseline</th>
            <th scope="col">Treatment</th>
            <th scope="col">Treatment exposure</th>
            <th scope="col">Pairing</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
