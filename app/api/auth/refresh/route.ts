import { handleRefresh } from "@/lib/auth-handlers.server";

export async function POST(request: Request) {
  return handleRefresh(request);
}
