import { headers } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export class UnauthorizedError extends Error {}

export async function getRequestUserId() {
  const h = await headers();
  const auth = h.get("authorization") ?? "";

  if (!auth.toLowerCase().startsWith("bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const token = auth.slice(7).trim();
  if (!token) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    throw new UnauthorizedError("Invalid or expired session");
  }

  return data.user.id;
}
