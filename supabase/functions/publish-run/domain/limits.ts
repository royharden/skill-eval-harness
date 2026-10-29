// Shared bounds for every import boundary: browser, Edge function and Node runner (PLAN.md §5).

export const MIB = 1024 * 1024;

export const LIMITS = {
  envelopeBytes: 8 * MIB,
  files: 4096,
  fileBytes: 512 * 1024,
  attempts: 2000,
  plannedSides: 2000,
  tasks: 256,
  repeats: 20,
  depth: 32,
  idChars: 256,
  pathChars: 256,
  freeTextChars: 64 * 1024,
} as const;

/** Source defaults pinned into each experiment before dispatch (§4). */
export const DEFAULT_LIMITS = {
  first_event_timeout_ms: 30_000,
  agent_timeout_ms: 180_000,
  grader_timeout_ms: 30_000,
  max_output_bytes: 8 * MIB,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LIMITS.idChars && ID_PATTERN.test(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/**
 * Validates a distributable relative path: forward slashes only, no absolute/drive/UNC form, no "." or ".."
 * segments, no empty segments, no NUL or control characters, bounded length. Returns an error or null.
 * Symlinks/reparse points can only be rejected on disk by the runner.
 */
export function relativePathError(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (path.length > LIMITS.pathChars) return `path exceeds ${LIMITS.pathChars} characters`;
  if (/[\u0000-\u001f\u007f]/.test(path)) return "path contains NUL or control characters";
  if (path.includes("\\")) return "path must use forward slashes";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "path must be relative";
  for (const segment of path.split("/")) {
    if (segment === "") return "path has an empty segment";
    if (segment === "." || segment === "..") return "path has a dot segment";
    if (/[<>:"|?*]/.test(segment)) return "path has a reserved character";
    if (/[ .]$/.test(segment)) return "path segment ends with a space or dot";
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(segment)) return "path segment is a reserved device name";
  }
  return null;
}

/** Alias key for duplicate detection across case-insensitive / normalizing filesystems. */
export function pathAliasKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * Walks parsed JSON once and enforces depth, string length and node count before expensive analysis.
 * Rejects non-finite numbers (cannot come from JSON.parse, but guards in-memory inputs).
 */
export function shapeBoundsErrors(value: unknown, maxNodes = 2_000_000): string[] {
  const errors: string[] = [];
  let nodes = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      errors.push(`input has more than ${maxNodes} JSON nodes`);
      break;
    }
    if (d > LIMITS.depth) {
      errors.push(`input nesting exceeds depth ${LIMITS.depth}`);
      break;
    }
    if (typeof v === "string") {
      if (v.length > LIMITS.freeTextChars) {
        errors.push(`a string exceeds ${LIMITS.freeTextChars} characters`);
        break;
      }
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        errors.push("input contains a non-finite number");
        break;
      }
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, d: d + 1 });
    } else if (v !== null && typeof v === "object") {
      for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
        if (key.length > LIMITS.freeTextChars) {
          errors.push("an object key is too long");
          return errors;
        }
        stack.push({ v: item, d: d + 1 });
      }
    }
  }
  return errors;
}
