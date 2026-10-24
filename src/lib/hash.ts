import { bytesToHex } from "../../supabase/functions/publish-run/domain/canonical.ts";
import type { Sha256Port } from "../../supabase/functions/publish-run/domain/contracts.ts";

/** Browser SHA-256 port for the shared domain (Web Crypto). */
export const browserSha256: Sha256Port = async (bytes) => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return bytesToHex(new Uint8Array(digest));
};
