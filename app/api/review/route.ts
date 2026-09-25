import { createHash, timingSafeEqual } from "node:crypto";
import { reviewRequestSchema } from "@/lib/schemas/request";

// Hash both sides first so timingSafeEqual always gets equal-length buffers
// (it throws otherwise) without leaking the secret's length.
function tokensMatch(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function log(level: "INFO" | "WARN" | "ERROR", message: string, extra = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...extra,
    }),
  );
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const expected = process.env.SERVICE_AUTH_TOKEN;
  if (!expected) {
    log("ERROR", "SERVICE_AUTH_TOKEN is not configured");
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Something went wrong, please try again later.",
    );
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token || !tokensMatch(token, expected)) {
    log("WARN", "Rejected request with missing or invalid auth token");
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Invalid or missing service auth token.",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    log("WARN", "Rejected request with unparseable JSON body");
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Request body must be valid JSON.",
    );
  }

  const parsed = reviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Log field paths only, never the payload, which contains diff contents.
    log("WARN", "Rejected request with invalid payload", {
      invalid_fields: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Request payload is missing required fields or has invalid values.",
    );
  }

  const { repo, pr_number, action } = parsed.data;
  log("INFO", "Review request received", { repo, pr_number, action });

  return Response.json({ findings: [] });
}
