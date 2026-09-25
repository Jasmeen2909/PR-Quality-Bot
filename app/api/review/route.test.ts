import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "./route";

const TOKEN = "test-secret";

const validPayload = {
  repo: "me/test",
  pr_number: 1,
  diff: "diff --git a/a.ts b/a.ts",
  action: "opened",
};

function makeRequest(body: unknown, token?: string) {
  return new Request("http://localhost/api/review", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/review", () => {
  const originalToken = process.env.SERVICE_AUTH_TOKEN;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.SERVICE_AUTH_TOKEN = TOKEN;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.SERVICE_AUTH_TOKEN;
    } else {
      process.env.SERVICE_AUTH_TOKEN = originalToken;
    }
    vi.restoreAllMocks();
  });

  it("returns 200 with an empty findings array for a valid request", async () => {
    const response = await POST(makeRequest(validPayload, TOKEN));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ findings: [] });
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const response = await POST(makeRequest(validPayload));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the token is wrong", async () => {
    const response = await POST(makeRequest(validPayload, "wrong-token"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when the payload is missing required fields", async () => {
    const response = await POST(makeRequest({}, TOKEN));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const response = await POST(makeRequest("not json", TOKEN));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns 500 without leaking details when SERVICE_AUTH_TOKEN is unset", async () => {
    delete process.env.SERVICE_AUTH_TOKEN;

    const response = await POST(makeRequest(validPayload, TOKEN));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("SERVICE_AUTH_TOKEN");
  });

  it("never writes the auth token to the logs", async () => {
    await POST(makeRequest(validPayload, "wrong-token"));
    await POST(makeRequest(validPayload, TOKEN));

    const logged = logSpy.mock.calls.flat().join("\n");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("wrong-token");
  });
});
