import { requireSettlementApiAuth, requireSettlementApiPrincipal } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import {
  INTAKE_ERROR,
  isValidIntakeMonthKey,
} from "@/features/settlement/lib/intake/contract";
import {
  createIntakeAdminClient,
  intakeJson,
  loadIntakeWorkspace,
  mapIntakeDbError,
} from "@/features/settlement/lib/intake/server";

export const runtime = "nodejs";

/** Month workspace: intake, draft revision, ordered draft files, versions. */
export async function GET(request: Request) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const monthKey = new URL(request.url).searchParams.get("month");
  if (!isValidIntakeMonthKey(monthKey)) {
    return intakeJson({ error: INTAKE_ERROR.invalidMonth }, { status: 400 });
  }

  const supabase = createIntakeAdminClient();
  const workspace = await loadIntakeWorkspace(supabase, monthKey);
  return intakeJson(workspace);
}

/** Idempotently creates (or returns) the single shared intake for a month. */
export async function POST(request: Request) {
  const auth = await requireSettlementApiPrincipal(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const monthKey = (body as { month?: unknown } | null)?.month;
  if (!isValidIntakeMonthKey(monthKey)) {
    return intakeJson({ error: INTAKE_ERROR.invalidMonth }, { status: 400 });
  }

  const supabase = createIntakeAdminClient();
  const { error } = await supabase.rpc("create_settlement_intake", {
    p_month_key: monthKey,
    p_actor: auth.principal.subject,
  });
  if (error) {
    const mapped = mapIntakeDbError(error);
    return intakeJson(mapped.body, { status: mapped.status });
  }

  const workspace = await loadIntakeWorkspace(supabase, monthKey);
  return intakeJson(workspace);
}
