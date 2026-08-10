import { handleForgotPassword } from "@/lib/auth-handlers.server";

export async function POST(request: Request) {
  return handleForgotPassword(request);
}
