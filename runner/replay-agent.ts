// Hidden "__replay-agent <script> <workspace>" child: executes a s20.replay.v1 script as a real process.
// Synthetic only. Writes are confined to the workspace; nothing else on the machine is touched.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { REPLAY_SCHEMA } from "./adapters/replay.ts";
import { resolveUnder } from "./fsutil.ts";

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;

type Step =
  | { event: Record<string, unknown> }
  | { write: { path: string; content: string } }
  | { sleep_ms: number }
  | { hang: true }
  | { exit: number };

export async function replayAgentMain(scriptPath: string, workspace: string): Promise<number> {
  const text = await readFile(scriptPath, "utf8");
  if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) throw new Error("replay script is too large");
  const script = JSON.parse(text) as { schema?: unknown; steps?: unknown };
  if (script.schema !== REPLAY_SCHEMA || !Array.isArray(script.steps) || script.steps.length > 1000) throw new Error("not a s20.replay.v1 script");
  for (const raw of script.steps as Step[]) {
    if ("event" in raw) process.stdout.write(`${JSON.stringify(raw.event)}\n`);
    else if ("write" in raw) {
      const { path, content } = raw.write;
      if (typeof content !== "string" || Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("replay write is too large");
      const target = resolveUnder(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    } else if ("sleep_ms" in raw) {
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(600_000, Number(raw.sleep_ms) || 0))));
    } else if ("hang" in raw) {
      await new Promise<never>(() => setInterval(() => undefined, 60_000));
    } else if ("exit" in raw) {
      return Number.isInteger(raw.exit) ? raw.exit : 1;
    } else throw new Error("unknown replay step");
  }
  return 0;
}
