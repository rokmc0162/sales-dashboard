import { handleLogout } from "@/lib/auth-handlers.server";

export async function POST(request: Request) {
  return handleLogout(request);
}
