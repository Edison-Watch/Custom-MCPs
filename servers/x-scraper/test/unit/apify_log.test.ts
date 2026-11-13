import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { apifyErrorType, apifyFailureEvent, logApifyFailure } from "../../src/apify_log";

const REVOKED_TOKEN_BODY = JSON.stringify({
  error: {
    type: "user-or-token-not-found",
    message: "User was not found or authentication token is not valid",
  },
});

describe("apifyErrorType", () => {
  test("reads error.type from an Apify error body", () => {
    expect(apifyErrorType(REVOKED_TOKEN_BODY)).toBe("user-or-token-not-found");
  });

  test("returns undefined for a missing, non-JSON or differently shaped body", () => {
    expect(apifyErrorType(undefined)).toBeUndefined();
    expect(apifyErrorType("")).toBeUndefined();
    expect(apifyErrorType("<html>bad gateway</html>")).toBeUndefined();
    expect(apifyErrorType(JSON.stringify({ error: "nope" }))).toBeUndefined();
    expect(apifyErrorType(JSON.stringify({ error: { type: 7 } }))).toBeUndefined();
    expect(apifyErrorType("null")).toBeUndefined();
  });
});

describe("apifyFailureEvent", () => {
  test("tags an HTTP failure with its status and Apify error type", () => {
    const event = apifyFailureEvent({
      service: "x",
      actor: "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest",
      stage: "http",
      status: 401,
      body: REVOKED_TOKEN_BODY,
      message: `Apify returned 401: ${REVOKED_TOKEN_BODY}`,
    });
    expect(event).toEqual({
      event: "apify_call_failed",
      service: "x",
      actor: "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest",
      stage: "http",
      status: 401,
      apify_error_type: "user-or-token-not-found",
      message: `Apify returned 401: ${REVOKED_TOKEN_BODY}`,
    });
  });

  test("never copies the raw body into the event", () => {
    const event = apifyFailureEvent({
      service: "x",
      actor: "a~b",
      stage: "http",
      status: 500,
      body: "secret-looking upstream body",
      message: "Apify returned 500",
    });
    expect(JSON.stringify(event)).not.toContain("secret-looking upstream body");
  });

  test("leaves out fields that do not apply and keeps the run id", () => {
    expect(
      apifyFailureEvent({ service: "reddit", actor: "a~b", stage: "run", runId: "RUN1", message: "ended" }),
    ).toEqual({ event: "apify_call_failed", service: "reddit", actor: "a~b", stage: "run", run_id: "RUN1", message: "ended" });
  });

  test("truncates a very long message", () => {
    const event = apifyFailureEvent({ service: "x", actor: "a~b", stage: "json", message: "m".repeat(2000) });
    expect((event.message as string).length).toBe(500);
  });
});

describe("logApifyFailure", () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  test("logs one error-level event and returns the caller-facing message", () => {
    spy = spyOn(console, "error").mockImplementation(() => {});
    const message = logApifyFailure({ service: "x", actor: "a~b", stage: "network", message: "could not reach Apify: TypeError" });
    expect(message).toBe("could not reach Apify: TypeError");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ event: "apify_call_failed", service: "x", stage: "network" });
  });
});
