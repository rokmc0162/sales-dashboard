export interface SettlementWorkerEnvironment {
  supabaseUrl: string;
  serviceRoleKey: string;
  databaseUrl: string;
}

export const WORKER_SERVICE_ROLE_ENV_NAMES = [
  "RVJP_DB_ADMIN_TOKEN",
  "RVJP_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function requireWorkerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SettlementWorkerEnvironment {
  // Prefer RVJP_DB_ADMIN_TOKEN (Vercel Preview filters env names containing
  // SERVICE_ROLE_KEY); the older names are compatibility fallbacks.
  // Never fall back to anon/public keys.
  const serviceRoleKey =
    env.RVJP_DB_ADMIN_TOKEN ||
    env.RVJP_SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY;
  const missing: string[] = [];
  if (!env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push(WORKER_SERVICE_ROLE_ENV_NAMES.join(" or "));
  if (!env.SUPABASE_DATABASE_URL) missing.push("SUPABASE_DATABASE_URL");
  if (missing.length > 0) {
    throw new Error(`Missing required worker environment: ${missing.join(", ")}`);
  }
  return {
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL as string,
    serviceRoleKey: serviceRoleKey as string,
    databaseUrl: env.SUPABASE_DATABASE_URL as string,
  };
}
