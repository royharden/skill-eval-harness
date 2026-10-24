// publish-run v2 (PLAN.md §11). Authenticated POST {suiteId, editionId, expectedContentDigest, isPublic, idempotencyKey}.
// Verifies the caller JWT and suite/edition ownership BEFORE any privileged operation, captures exactly the immutable
// edition requested, recomputes and sanitizes those bytes with the shared domain, and inserts precisely that
// artifact through a service-only transactional function with idempotency. CORS is not authorization.
// Source only: not deployed or exercised. Gateway verify_jwt stays enabled in config.toml.

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { bytesToHex, canonicalJson, utf8 } from "./domain/canonical.ts";
import type { Sha256Port } from "./domain/contracts.ts";
import { isDigest } from "./domain/limits.ts";
import { buildEnvelope, envelopeText, recordsEditionDigest } from "./domain/manifest.ts";
import { DEFAULT_SANITIZE, sanitizeForExport } from "./domain/sanitize.ts";
import { parseRunRecords } from "./domain/validate.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_EDITION_BYTES = 8 * 1024 * 1024;

const denoSha256: Sha256Port = async (bytes) => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Reads at most `limit` bytes of the body; returns null when the body is larger. */
async function readBounded(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(500, { error: "Function configuration is missing; nothing was stored." });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json(401, { error: "Sign in required." });

  let raw: string | null;
  try {
    raw = await readBounded(req, MAX_REQUEST_BYTES);
  } catch {
    return json(400, { error: "Body must be UTF-8 JSON." });
  }
  if (raw === null) return json(413, { error: `Body is larger than ${MAX_REQUEST_BYTES} bytes.` });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: "Body must be a JSON object." });
  }
  const { suiteId, editionId, expectedContentDigest, isPublic, idempotencyKey } = body;
  if (typeof suiteId !== "string" || !UUID.test(suiteId)) return json(400, { error: "suiteId must be a UUID." });
  if (typeof editionId !== "string" || !UUID.test(editionId)) return json(400, { error: "editionId must be a UUID." });
  if (!isDigest(expectedContentDigest)) return json(400, { error: "expectedContentDigest must be a SHA-256 hex digest." });
  if (typeof isPublic !== "boolean") return json(400, { error: "isPublic must be true or false." });
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return json(400, { error: "idempotencyKey must be 8-128 characters." });

  // 1. Independently verify the caller.
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "The access token was rejected. Sign in again." });
  const userId = userData.user.id;

  // 2. Ownership of suite and edition, before any privileged write.
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: suite, error: suiteError } = await admin.from("suites").select("id, owner_id").eq("id", suiteId).maybeSingle();
  if (suiteError) return json(500, { error: "Could not read the suite." });
  if (!suite || suite.owner_id !== userId) return json(403, { error: "That suite is not owned by the signed-in user." });
  const { data: edition, error: editionError } = await admin
    .from("suite_editions")
    .select("id, suite_id, owner_id, schema_version, records_edition_digest, content")
    .eq("id", editionId)
    .eq("suite_id", suiteId)
    .maybeSingle();
  if (editionError) return json(500, { error: "Could not read the edition." });
  if (!edition || edition.owner_id !== userId) return json(403, { error: "That edition is not owned by the signed-in user in this suite." });
  if (edition.records_edition_digest !== expectedContentDigest) return json(409, { error: "The edition digest does not match expectedContentDigest." });
  if (typeof edition.content !== "string" || utf8(edition.content).byteLength > MAX_EDITION_BYTES) return json(400, { error: "Stored edition is missing or too large." });

  // 3. Recompute from exactly the captured immutable bytes.
  let content: { spec?: unknown; ledger?: unknown; attempts?: unknown };
  try {
    content = JSON.parse(edition.content) as typeof content;
  } catch {
    return json(400, { error: "Stored edition is not JSON." });
  }
  const records = parseRunRecords(content.spec, content.ledger, Array.isArray(content.attempts) ? content.attempts : [null]);
  if (!records.ok) return json(400, { error: "Stored edition failed v2 validation.", details: records.errors.slice(0, 20) });
  const digest = await recordsEditionDigest(records.value, denoSha256);
  if (digest !== expectedContentDigest || (await denoSha256(utf8(edition.content))) !== expectedContentDigest) {
    return json(409, { error: "Stored edition bytes do not hash to expectedContentDigest." });
  }
  const priv = await buildEnvelope(records.value, denoSha256, { kind: "private", runtime: {} });
  if (!priv.ok) return json(400, { error: "Edition could not be summarized.", details: priv.errors.slice(0, 20) });
  const sanitized = await sanitizeForExport(records.value, priv.value.envelope.manifest, denoSha256, DEFAULT_SANITIZE);
  if (!sanitized.ok) return json(400, { error: "Edition could not be sanitized.", details: sanitized.errors.slice(0, 20) });
  const artifact = envelopeText(sanitized.value.envelope);
  const requestDigest = await denoSha256(utf8(canonicalJson({ suiteId, editionId, expectedContentDigest, isPublic })));

  // 4. Transactional, idempotent insert of precisely this artifact (service-only function).
  const { data: recorded, error: recordError } = await admin.rpc("record_publication", {
    p_owner_id: userId,
    p_suite_id: suiteId,
    p_edition_id: editionId,
    p_idempotency_key: idempotencyKey,
    p_request_digest: requestDigest,
    p_is_public: isPublic,
    p_method_version: sanitized.value.summary.method_version,
    p_content_digest: sanitized.value.envelope.manifest.content_digest,
    p_source_edition_digest: expectedContentDigest,
    p_summary: sanitized.value.summary,
    p_artifact: artifact,
  });
  if (recordError) {
    if (recordError.code === "P0409") return json(409, { error: "This idempotency key was already used for a different request." });
    return json(500, { error: "The publication was not stored." });
  }
  const row = recorded as { id: string; is_public: boolean; created_at: string; existing: boolean };
  return json(200, {
    publication: {
      id: row.id,
      isPublic: row.is_public,
      createdAt: row.created_at,
      sourceEditionDigest: expectedContentDigest,
      contentDigest: sanitized.value.envelope.manifest.content_digest,
      schemaVersion: sanitized.value.summary.schema_version,
      summary: sanitized.value.summary,
      existing: row.existing,
    },
  });
});
