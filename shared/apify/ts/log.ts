/**
 * Structured logging for failed Apify calls, shared by every Apify-backed fleet
 * server (reddit, youtube, x, linkedin).
 *
 * A failed Actor call reaches the MCP caller as an `isError` tool result, which
 * Workers Logs never sees. Without a log line, a fleet-wide outage (a revoked
 * APIFY_TOKEN once 401'd every scrape for days) is invisible in Cloudflare
 * observability. Each failure is logged once, at error level, as one object, so
 * Workers Logs indexes its fields and it can be grouped by
 * `$metadata.service` + `apify_error_type`.
 *
 * Never put the Apify token or a response body in a field: the event carries
 * only the actor id, the failing stage, the HTTP status, Apify's error type and
 * an error message. For stage "http" the caller-facing message embeds part of
 * the response body, so the event's message is rebuilt from the status alone.
 */

/** Where a call failed: reaching Apify, its HTTP status, its JSON, the dataset, or the run itself. */
export type ApifyStage = "network" | "http" | "json" | "dataset" | "run";

export interface ApifyFailure {
  /** Fleet server id, e.g. "reddit". */
  service: string;
  /** Apify Actor id (tilde form) the call ran. */
  actor: string;
  stage: ApifyStage;
  /**
   * The error message returned to the MCP caller. Logged as-is for every stage
   * except "http", whose message can carry the response body.
   */
  message: string;
  /** HTTP status Apify answered with, for stage "http". */
  status?: number;
  /** Raw Apify response body, for stage "http"; only its `error.type` is logged. */
  body?: string;
  /** Apify run id, when the failure is about one specific run. */
  runId?: string;
}

/** Longest message kept in a log event. */
const MAX_MESSAGE_CHARS = 500;

/**
 * Pull Apify's machine-readable error type out of an error body, e.g.
 * `user-or-token-not-found` from `{"error":{"type":"user-or-token-not-found"}}`.
 * Returns undefined for any other shape.
 */
export function apifyErrorType(body: string | undefined): string | undefined {
  if (!body) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (json === null || typeof json !== "object") return undefined;
  const error = (json as Record<string, unknown>).error;
  if (error === null || typeof error !== "object") return undefined;
  const type = (error as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

/** The message to log: never the response body an "http" caller message carries. */
function logMessage(failure: ApifyFailure): string {
  if (failure.stage === "http") {
    return failure.status === undefined ? "Apify returned an error" : `Apify returned ${failure.status}`;
  }
  return failure.message.slice(0, MAX_MESSAGE_CHARS);
}

/** Build the log event for a failure (pure, so it is unit-testable). */
export function apifyFailureEvent(failure: ApifyFailure): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event: "apify_call_failed",
    service: failure.service,
    actor: failure.actor,
    stage: failure.stage,
    message: logMessage(failure),
  };
  if (failure.status !== undefined) event.status = failure.status;
  const type = apifyErrorType(failure.body);
  if (type) event.apify_error_type = type;
  if (failure.runId) event.run_id = failure.runId;
  return event;
}

/** Log a failed Apify call at error level and return its caller-facing message. */
export function logApifyFailure(failure: ApifyFailure): string {
  console.error(apifyFailureEvent(failure));
  return failure.message;
}
