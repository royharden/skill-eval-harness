// Optional Bolt Database persistence for v2 runs (PLAN.md §11). Browser uses the public key only.
// Every failure surfaces as an error; nothing is replaced with demo behavior.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunRecords } from "../../supabase/functions/publish-run/domain/contracts.ts";
import { recordsEditionDigest, recordsEditionText } from "../../supabase/functions/publish-run/domain/manifest.ts";
import type { RunSummary } from "../../supabase/functions/publish-run/domain/summary.ts";
import { browserSha256 } from "./hash.ts";

export interface SavedEdition {
  suiteId: string;
  editionId: string;
  digest: string;
  existing: boolean;
}

export interface Publication {
  id: string;
  isPublic: boolean;
  createdAt: string;
  sourceEditionDigest: string;
  contentDigest: string;
  schemaVersion: string;
  summary: RunSummary;
}

export interface PublicSnapshot {
  id: string;
  createdAt: string;
  contentDigest: string;
  sourceEditionDigest: string;
  /** Exact sanitized envelope text; the viewer re-verifies it before display. */
  artifact: string;
}

export async function saveEdition(client: SupabaseClient, records: RunRecords, suiteId: string | null): Promise<SavedEdition> {
  const content = recordsEditionText(records);
  const digest = await recordsEditionDigest(records, browserSha256);
  const { data, error } = await client.rpc("save_suite_edition", {
    p_suite_id: suiteId,
    p_suite_name: records.spec.experiment_id,
    p_run_id: records.ledger.run_id,
    p_experiment_digest: records.spec.experiment_digest,
    p_records_edition_digest: digest,
    p_content: content,
  });
  if (error) throw new Error(error.message || "The edition was not saved.");
  const row = data as { suite_id?: unknown; edition_id?: unknown; existing?: unknown } | null;
  if (!row || typeof row.suite_id !== "string" || typeof row.edition_id !== "string") throw new Error("The save response was not understood; nothing is assumed saved.");
  return { suiteId: row.suite_id, editionId: row.edition_id, digest, existing: row.existing === true };
}

export async function publishEdition(
  client: SupabaseClient,
  saved: SavedEdition,
  isPublic: boolean,
  idempotencyKey: string,
): Promise<Publication> {
  const invoked = await client.functions.invoke("publish-run", {
    body: { suiteId: saved.suiteId, editionId: saved.editionId, expectedContentDigest: saved.digest, isPublic, idempotencyKey },
  });
  if (invoked.error) throw new Error(await readInvokeError(invoked.error));
  const p = (invoked.data as { publication?: Partial<Publication> } | null)?.publication;
  if (!p || typeof p.id !== "string" || typeof p.isPublic !== "boolean" || !p.summary || p.sourceEditionDigest !== saved.digest) {
    throw new Error("The function response was not a v2 publication for this edition.");
  }
  return p as Publication;
}

export async function loadPublicSnapshot(client: SupabaseClient, id: string): Promise<PublicSnapshot | null> {
  const { data, error } = await client.rpc("get_public_publication", { p_id: id });
  if (error) throw new Error("Could not load that snapshot.");
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row || typeof row.artifact !== "string" || typeof row.id !== "string") return null;
  return {
    id: row.id,
    createdAt: String(row.created_at ?? ""),
    contentDigest: String(row.content_digest ?? ""),
    sourceEditionDigest: String(row.source_edition_digest ?? ""),
    artifact: row.artifact,
  };
}

export interface MyPublication {
  publication_id: string;
  is_public: boolean;
  revoked_at: string | null;
  created_at: string;
}

export async function listMyPublications(client: SupabaseClient): Promise<MyPublication[]> {
  const { data, error } = await client
    .from("publication_controls")
    .select("publication_id, is_public, revoked_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message || "Could not list publications.");
  return (data ?? []) as MyPublication[];
}

export async function setVisibility(client: SupabaseClient, id: string, isPublic: boolean): Promise<void> {
  const { error } = await client.from("publication_controls").update({ is_public: isPublic }).eq("publication_id", id);
  if (error) throw new Error(error.message || "Visibility was not changed.");
}

export async function revokePublication(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("publication_controls").update({ revoked_at: new Date().toISOString(), is_public: false }).eq("publication_id", id);
  if (error) throw new Error(error.message || "The publication was not revoked.");
}

export async function deletePublication(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc("delete_my_publication", { p_id: id });
  if (error) throw new Error(error.message || "The publication was not deleted.");
}

async function readInvokeError(error: { message?: string; context?: unknown }): Promise<string> {
  const context = error.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) return body.error;
    } catch {
      /* fall through */
    }
  }
  return "Publish failed. Check that you are signed in and that publish-run is deployed.";
}
