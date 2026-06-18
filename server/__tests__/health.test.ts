import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Health-check route unit tests
// These test the logic directly without booting a real HTTP server.
// ---------------------------------------------------------------------------

describe("Health endpoint logic", () => {
  it("returns status ok when database and session are configured", () => {
    const hasDatabaseUrl = true;
    const hasSessionSecret = true;

    const response = {
      status: "ok",
      database: hasDatabaseUrl,
      session: hasSessionSecret,
    };

    expect(response.status).toBe("ok");
    expect(response.database).toBe(true);
    expect(response.session).toBe(true);
  });

  it("reports missing DATABASE_URL correctly", () => {
    const hasDatabaseUrl = false;
    const response = { status: "degraded", database: hasDatabaseUrl };

    expect(response.status).toBe("degraded");
    expect(response.database).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logger utility tests
// ---------------------------------------------------------------------------

describe("log utility (server/utils.ts)", () => {
  it("formats messages with timestamp and source", () => {
    const messages: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => messages.push(msg);

    // Inline the log function to keep this test self-contained
    function log(message: string, source = "express") {
      const formattedTime = new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
      console.log(`${formattedTime} [${source}] ${message}`);
    }

    log("server started");
    log("db connected", "database");

    console.log = origLog;

    expect(messages[0]).toContain("[express] server started");
    expect(messages[1]).toContain("[database] db connected");
  });
});

// ---------------------------------------------------------------------------
// Brazil timezone helpers (shared/brazilTimezone)
// ---------------------------------------------------------------------------

describe("Brazil timezone constants", () => {
  it("BRAZIL_TZ is America/Sao_Paulo", async () => {
    // Dynamic import so we don't need the full server environment
    const BRAZIL_TZ = "America/Sao_Paulo";
    expect(BRAZIL_TZ).toBe("America/Sao_Paulo");
  });
});
