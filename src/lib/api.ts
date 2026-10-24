import type { SupabaseClient } from "@supabase/supabase-js";
import { isSummary, type ImportPayload, type Summary } from "../../supabase/functions/publish-run/domain/types.ts";

export async function importSuite(
  client: SupabaseClient,
  payload: ImportPayload,
): Promise<{ suiteId: string; trialIds: string[] }> {
  const imported = await client.rpc("import_suite", { payload });
  if (imported.error || typeof imported.data !== "string") {
    throw new Error(imported.error?.message ?? "The suite was not saved.");
  }
  const trialIds: string[] = [];
  const pageSize = 1000;
  for (let from = 0; from <= 2000; from += pageSize) {
    const trials = await client.from("trials").select("id").eq("suite_id", imported.data).range(from, from + pageSize - 1);
    if (trials.error || !trials.data) {
      throw new Error(trials.error?.message ?? "The suite was saved, but its trials could not be read.");
    }
    trialIds.push(...trials.data.map((row) => String(row.id)));
    if (trials.data.length < pageSize) break;
  }
  if (trialIds.length > 2000) {
    throw new Error("The suite returned more trials than the 2000 trial cap.");
  }
  return { suiteId: imported.data, trialIds };
}

export async function publishSuite(
  client: SupabaseClient,
  suiteId: string,
  trialIds: string[],
  isPublic: boolean,
): Promise<{ ok: true; id: string; summary: Summary } | { ok: false; error: string }> {
  const invoked = await client.functions.invoke("publish-run", {
    body: { suiteId, trialIds, isPublic },
  });
  if (invoked.error) return { ok: false, error: await readInvokeError(invoked.error) };
  const data = invoked.data as { publication?: { id?: unknown; summary?: unknown } } | null;
  const publication = data?.publication;
  if (!publication || typeof publication.id !== "string" || !isSummary(publication.summary)) {
    return { ok: false, error: "The function response did not include a version 1 summary." };
  }
  return { ok: true, id: publication.id, summary: publication.summary };
}

export async function loadPublicPublication(client: SupabaseClient, id: string): Promise<Summary | null> {
  const result = await client.from("publications").select("summary").eq("id", id).eq("is_public", true).maybeSingle();
  if (result.error) throw new Error("Could not load that snapshot.");
  const summary = (result.data as { summary?: unknown } | null)?.summary;
  if (!isSummary(summary)) return null;
  return summary;
}

async function readInvokeError(error: { message?: string; context?: unknown }): Promise<string> {
  const context = error.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) return body.error;
    } catch {
      return "Publish failed. Check that you are signed in and that publish-run is deployed.";
    }
  }
  return "Publish failed. Check that you are signed in and that publish-run is deployed.";
}
