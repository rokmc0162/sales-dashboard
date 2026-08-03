import { handleCurrentExport } from "@/features/settlement/lib/current-data-routes";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ month: string }> },
) {
  const { month } = await params;
  return handleCurrentExport(request, month);
}
