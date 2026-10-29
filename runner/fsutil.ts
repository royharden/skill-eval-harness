// Node-only filesystem helpers: bounded reads under owned roots, symlink/reparse rejection, tree digests,
// atomic same-volume writes. Never follows links and never reads outside the declared root.

import { createHash } from "node:crypto";
import { constants as fsc, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Digest, Sha256Port } from "../supabase/functions/publish-run/domain/contracts.ts";
import { treeDigest } from "../supabase/functions/publish-run/domain/canonical.ts";
import { LIMITS, relativePathError } from "../supabase/functions/publish-run/domain/limits.ts";

export const nodeSha256: Sha256Port = async (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sha256Hex(bytes: Uint8Array | string): Digest {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FsBoundError extends Error {}

export const TREE_LIMITS = { files: LIMITS.files, fileBytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024, depth: 16 } as const;

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes exact UTF-8 bytes (BOM preserved) or returns null for non-UTF-8 content. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

/** Resolves a trusted relative path under root, refusing traversal and absolute forms. */
export function resolveUnder(root: string, rel: string): string {
  const err = relativePathError(rel);
  if (err) throw new FsBoundError(`${rel}: ${err}`);
  const abs = resolve(root, ...rel.split("/"));
  const back = relative(resolve(root), abs);
  if (back.startsWith("..") || isAbsolute(back)) throw new FsBoundError(`${rel} escapes ${root}`);
  return abs;
}

/** lstat-based check: regular file or directory only; symlinks, junctions and other reparse points are refused. */
export async function assertPlain(path: string, want: "file" | "dir"): Promise<number> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new FsBoundError(`${path} is a symlink or reparse point`);
  if (want === "file" && !st.isFile()) throw new FsBoundError(`${path} is not a regular file`);
  if (want === "dir" && !st.isDirectory()) throw new FsBoundError(`${path} is not a directory`);
  return st.size;
}

/** Ancestors checked for symlinks too, so a linked parent cannot redirect a trusted path. */
export async function assertNoLinkedAncestors(root: string, abs: string): Promise<void> {
  let cur = abs;
  const top = resolve(root);
  while (cur.length > top.length && cur.startsWith(top)) {
    const st = await lstat(cur);
    if (st.isSymbolicLink()) throw new FsBoundError(`${cur} is a symlink or reparse point`);
    cur = dirname(cur);
  }
}

export async function readTrustedFile(root: string, rel: string, maxBytes = TREE_LIMITS.fileBytes): Promise<Uint8Array> {
  const abs = resolveUnder(root, rel);
  await assertNoLinkedAncestors(root, abs);
  const size = await assertPlain(abs, "file");
  if (size > maxBytes) throw new FsBoundError(`${rel} exceeds ${maxBytes} bytes`);
  return new Uint8Array(await readFile(abs));
}

export interface TreeEntry {
  path: string;
  abs: string;
  bytes: number;
  digest: Digest;
}

/** Walks a directory (no links followed), bounded by count, size and depth. Paths are "/"-joined and sorted. */
export async function walkTree(dir: string, limits = TREE_LIMITS): Promise<TreeEntry[]> {
  await assertPlain(dir, "dir");
  const out: TreeEntry[] = [];
  let total = 0;
  async function visit(abs: string, rel: string, depth: number): Promise<void> {
    if (depth > limits.depth) throw new FsBoundError(`${dir} is nested deeper than ${limits.depth}`);
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const err = relativePathError(childRel);
      if (err) throw new FsBoundError(`${childRel}: ${err}`);
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) throw new FsBoundError(`${childRel} is a symlink or reparse point`);
      if (st.isDirectory()) await visit(childAbs, childRel, depth + 1);
      else if (st.isFile()) {
        if (st.size > limits.fileBytes) throw new FsBoundError(`${childRel} exceeds ${limits.fileBytes} bytes`);
        total += st.size;
        if (total > limits.totalBytes) throw new FsBoundError(`${dir} exceeds ${limits.totalBytes} bytes`);
        if (out.length + 1 > limits.files) throw new FsBoundError(`${dir} has more than ${limits.files} files`);
        out.push({ path: childRel, abs: childAbs, bytes: st.size, digest: sha256Hex(await readFile(childAbs)) });
      } else throw new FsBoundError(`${childRel} is not a regular file or directory`);
    }
  }
  await visit(dir, "", 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function treeDigestOf(dir: string): Promise<Digest> {
  return treeDigest(await walkTree(dir), nodeSha256);
}

/** Copies a walked tree into dest (dest must not exist yet or be empty). */
export async function copyTree(entries: TreeEntry[], dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of entries) {
    const target = resolveUnder(dest, e.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(e.abs, target, fsc.COPYFILE_EXCL);
  }
}

/** Writes via a temp file in the same directory, flushes, then renames. Refuses to replace different bytes. */
export async function writeImmutable(path: string, text: string): Promise<"written" | "identical"> {
  if (existsSync(path)) {
    const prior = await readFile(path, "utf8");
    if (prior === text) return "identical";
    throw new FsBoundError(`${path} already exists with different content; measured records are never overwritten`);
  }
  await writeAtomic(path, text);
  return "written";
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export async function writeNew(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", flag: "wx" });
}

/** True if path or any ancestor contains a .git entry (a repository work tree). */
export function insideGitWorkTree(path: string): string | null {
  let cur = resolve(path);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function isWithin(parent: string, child: string): boolean {
  const back = relative(resolve(parent), resolve(child));
  return back === "" || (!back.startsWith("..") && !isAbsolute(back) && !back.startsWith(sep));
}
