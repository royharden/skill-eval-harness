import type { HarnessId } from "../../supabase/functions/publish-run/domain/contracts.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { replayAdapter } from "./replay.ts";
import type { Adapter } from "./types.ts";

const ADAPTERS: Partial<Record<HarnessId, Adapter>> = { replay: replayAdapter, "claude-code": claudeAdapter, codex: codexAdapter };

export function adapterFor(harness: HarnessId): Adapter {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`no adapter is available for ${harness}`);
  return adapter;
}
