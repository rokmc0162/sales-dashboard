import assert from "node:assert/strict";

import { requireWorkerEnvironment } from "../src/features/settlement/lib/worker/worker-env";

function main() {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
    SUPABASE_DATABASE_URL: "postgresql://fake.invalid/db",
  };

  // Anon-only configuration fails closed: the anon key is never accepted as a
  // service-role substitute, and its value never leaks into the error message.
  assert.throws(
    () => requireWorkerEnvironment({ ...base, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-secret" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /RVJP_DB_ADMIN_TOKEN or RVJP_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY/,
      );
      assert.doesNotMatch(error.message, /anon-secret/);
      return true;
    },
  );

  // Empty-string keys are missing, not credentials.
  assert.throws(() => requireWorkerEnvironment({ ...base, RVJP_DB_ADMIN_TOKEN: "" }));

  // Missing URL and database URL are reported together with the key names.
  assert.throws(
    () => requireWorkerEnvironment({}),
    /Missing required worker environment: NEXT_PUBLIC_SUPABASE_URL, RVJP_DB_ADMIN_TOKEN or RVJP_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DATABASE_URL/,
  );

  // Each accepted service-role name works on its own.
  for (const name of [
    "RVJP_DB_ADMIN_TOKEN",
    "RVJP_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    const env = requireWorkerEnvironment({ ...base, [name]: `key-via-${name}` });
    assert.equal(env.serviceRoleKey, `key-via-${name}`);
    assert.equal(env.supabaseUrl, base.NEXT_PUBLIC_SUPABASE_URL);
    assert.equal(env.databaseUrl, base.SUPABASE_DATABASE_URL);
  }

  // The project-scoped alias wins over the compatibility fallbacks, and the
  // anon key is ignored even when present alongside a service-role key.
  const resolved = requireWorkerEnvironment({
    ...base,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-secret",
    RVJP_DB_ADMIN_TOKEN: "primary-key",
    RVJP_SUPABASE_SERVICE_ROLE_KEY: "fallback-key",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-key",
  });
  assert.equal(resolved.serviceRoleKey, "primary-key");

  console.log("test-settlement-worker-env: all assertions passed");
}

main();
