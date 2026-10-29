import { createHash } from "node:crypto";
import type { Sha256Port } from "../../supabase/functions/publish-run/domain/contracts.ts";

export const sha256: Sha256Port = async (bytes) => createHash("sha256").update(bytes).digest("hex");
