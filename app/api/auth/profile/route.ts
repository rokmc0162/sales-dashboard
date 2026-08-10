import { handleProfile } from "@/lib/auth-handlers.server";

export async function GET(request: Request) {
  return handleProfile(request);
}
