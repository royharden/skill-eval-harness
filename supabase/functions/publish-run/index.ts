import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import { compareTrials } from "./domain/compare.ts";
import { trialFromStoredRow } from "./domain/stored.ts";
import { TRIAL_CAP } from "./domain/types.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, {
      error: "Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY. The publication was not stored.",
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(401, { error: "Sign in required. Send the user access token." });
  }

  const raw = await req.text();
  if (raw.length > 1_500_000) return json(413, { error: "Body is larger than 1.5 MB." });

  let payload: { suiteId?: unknown; trialIds?: unknown; isPublic?: unknown };
  try {
    payload = JSON.parse(raw) as { suiteId?: unknown; trialIds?: unknown; isPublic?: unknown };
  } catch {
    return json(400, { error: "Body must be JSON." });
  }

  if (typeof payload.suiteId !== "string" || !UUID.test(payload.suiteId)) {
    return json(400, { error: "suiteId must be a UUID." });
  }
  if (!Array.isArray(payload.trialIds) || payload.trialIds.length === 0 || payload.trialIds.length > TRIAL_CAP) {
    return json(400, { error: `trialIds must contain 1 to ${TRIAL_CAP} ids.` });
  }
  if (!payload.trialIds.every((id) => typeof id === "string" && UUID.test(id))) {
    return json(400, { error: "Every trial id must be a UUID." });
  }
  const trialIds = payload.trialIds as string[];
  if (new Set(trialIds).size !== trialIds.length) {
    return json(400, { error: "trialIds contains duplicates." });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json(401, { error: "The access token was rejected. Sign in again." });
  }
  const userId = userData.user.id;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: suite, error: suiteError } = await admin
    .from("suites")
    .select("id, owner_id")
    .eq("id", payload.suiteId)
    .maybeSingle();
  if (suiteError) return json(500, { error: "Could not read the suite." });
  if (!suite || suite.owner_id !== userId) {
    return json(403, { error: "That suite is not owned by the signed-in user." });
  }

  const loaded = await loadTrialRows(admin, payload.suiteId, userId, trialIds);
  if (!loaded.ok) return json(loaded.status, { error: loaded.error });
  const rows = loaded.rows;

  let trials;
  try {
    trials = rows.map((row) =>
      trialFromStoredRow({
        id: String(row.id),
        task_id: String(row.task_id),
        task_slug: slugOf(row.tasks),
        harness: String(row.harness),
        condition: String(row.condition),
        seed: row.seed as number | string,
        passed: asPassed(row.passed),
        instruction_loaded: asLoaded(row.instruction_loaded),
        input_tokens: row.input_tokens as number | string,
        output_tokens: row.output_tokens as number | string,
        cost_usd: row.cost_usd as number | string,
        cli_version: String(row.cli_version),
        model_id: String(row.model_id),
        artifact_sha256: String(row.artifact_sha256),
        grader_id: String(row.grader_id),
        grader_sha256: String(row.grader_sha256),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trial row could not be read.";
    return json(400, { error: message });
  }

  const compared = compareTrials(trials);
  if (!compared.ok) return json(400, { error: "Trials failed validation.", details: compared.errors });

  const { data: inserted, error: insertError } = await admin
    .from("publications")
    .insert({
      suite_id: payload.suiteId,
      owner_id: userId,
      is_public: payload.isPublic === true,
      summary: compared.summary,
      trial_ids: trialIds,
    })
    .select("id, is_public, created_at")
    .single();
  if (insertError || !inserted) return json(500, { error: "The publication was not stored." });

  return json(200, {
    publication: {
      id: inserted.id,
      isPublic: inserted.is_public,
      createdAt: inserted.created_at,
      summary: compared.summary,
    },
  });
});

async function loadTrialRows(
  admin: SupabaseClient,
  suiteId: string,
  userId: string,
  trialIds: string[],
): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; status: number; error: string }> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < trialIds.length; index += 100) {
    const chunk = trialIds.slice(index, index + 100);
    const { data, error } = await admin
      .from("trials")
      .select(
        "id, task_id, harness, condition, seed, passed, instruction_loaded, input_tokens, output_tokens, cost_usd, cli_version, model_id, artifact_sha256, grader_id, grader_sha256, tasks(slug)",
      )
      .eq("suite_id", suiteId)
      .eq("owner_id", userId)
      .in("id", chunk);
    if (error) return { ok: false, status: 500, error: "Could not read the trials." };
    for (const row of data ?? []) rows.push(row as Record<string, unknown>);
  }
  if (rows.length !== trialIds.length) {
    return { ok: false, status: 400, error: "Every trial id must belong to this suite and this owner." };
  }
  return { ok: true, rows };
}

function asPassed(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error("passed is not a boolean");
}

function asLoaded(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new Error("instruction_loaded is not a boolean or null");
}

function slugOf(tasks: unknown): string {
  if (!tasks) return "";
  if (Array.isArray(tasks)) {
    const first = tasks[0] as { slug?: unknown } | undefined;
    return typeof first?.slug === "string" ? first.slug : "";
  }
  if (typeof tasks === "object" && tasks !== null && "slug" in tasks) {
    const slug = (tasks as { slug?: unknown }).slug;
    return typeof slug === "string" ? slug : "";
  }
  return "";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
