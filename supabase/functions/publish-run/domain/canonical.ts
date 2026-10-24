// Canonical JSON, ordering conventions and digest helpers (PLAN.md §5).
// Pinned conventions:
// - Object keys sorted by UTF-16 code unit order (compareCodeUnits). No locale collation.
// - Arrays keep their order, except collections documented below which callers sort first.
// - Numbers must be finite and are written with ECMAScript Number-to-String (shortest round trip).
// - null is explicit; undefined, functions, symbols, bigint and non-plain objects are rejected.
// - Output is UTF-8 bytes of the canonical text. Artifact bytes are never normalized here.

import type { AttemptRecord, Digest, Sha256Port, TaskDescriptor } from "./contracts.ts";

export class CanonicalError extends Error {}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalError(`${path} is not a finite number`);
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item, i) => write(item, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError(`${path} is not a plain object`);
      const entries = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
      const parts: string[] = [];
      for (const key of entries) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new CanonicalError(`${path}.${key} is undefined`);
        parts.push(`${JSON.stringify(key)}:${write(item, `${path}.${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalError(`${path} has unsupported type ${typeof value}`);
  }
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

export async function digestOf(value: unknown, sha256: Sha256Port): Promise<Digest> {
  return sha256(canonicalBytes(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Tree digest: SHA-256 of canonical [[relativePath, contentDigest], ...] sorted by path. */
export async function treeDigest(entries: Array<{ path: string; digest: Digest }>, sha256: Sha256Port): Promise<Digest> {
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.path, b.path));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.path === sorted[i - 1]!.path) throw new CanonicalError(`duplicate tree path ${sorted[i]!.path}`);
  }
  return digestOf(
    sorted.map((entry) => [entry.path, entry.digest]),
    sha256,
  );
}

export function sortTasks(tasks: TaskDescriptor[]): TaskDescriptor[] {
  return [...tasks].sort((a, b) => compareCodeUnits(a.task_id, b.task_id));
}

const ARM_ORDER: Record<string, number> = { baseline: 0, treatment: 1 };

/** Documented attempt order: task_id, repeat_id, arm_id (baseline first), attempt_no, attempt_id. */
export function compareAttempts(a: AttemptRecord, b: AttemptRecord): number {
  return (
    compareCodeUnits(a.task_id, b.task_id) ||
    a.repeat_id - b.repeat_id ||
    (ARM_ORDER[a.arm_id] ?? 9) - (ARM_ORDER[b.arm_id] ?? 9) ||
    a.attempt_no - b.attempt_no ||
    compareCodeUnits(a.attempt_id, b.attempt_id)
  );
}

export function sortAttempts(attempts: AttemptRecord[]): AttemptRecord[] {
  return [...attempts].sort(compareAttempts);
}
