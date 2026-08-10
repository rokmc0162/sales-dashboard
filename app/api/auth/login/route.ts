import { handleLogin } from "@/lib/auth-handlers.server";

export async function POST(request: Request) {
  return handleLogin(request);
}
