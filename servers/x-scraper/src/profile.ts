/**
 * Pure, runtime-agnostic helpers for the x-scraper's profile tool (`x_profile`).
 *
 * Backed by the `apidojo/twitter-user-scraper` Apify Actor - a *different* Actor
 * from the tweet scraper in `x.ts`. Given X handles or profile URLs it returns
 * full user objects (bio, follower/following counts, verified flag, join date,
 * location, tweet count...).
 *
 * Quirk this module exists to tame: the Actor returns the requested profiles
 * first, then pads the run up to `maxItems` with "who to follow" suggestions,
 * and at a very small `maxItems` its ordering is unstable (a suggestion can
 * crowd the requested account out of the window entirely - observed: asking for
 * `sama` at `maxItems: 1` returned `paulg`). So we deliberately over-fetch by a
 * fixed buffer and then filter the dataset back down to exactly the requested
 * accounts: the caller only ever sees profiles it asked for, never suggestions.
 */

import { normalizeHandle } from "./x";

export const DEFAULT_PROFILE_ACTOR_ID = "apidojo~twitter-user-scraper";

/**
 * Headroom over the requested count (see file header): fetch this many extra
 * items so the Actor's suggestion padding can never truncate a requested
 * profile out of the returned window before we filter back to the requested set.
 */
export const PROFILE_PADDING_BUFFER = 10;

export interface XProfileArgs {
  handles?: string[];
  profile_urls?: string[];
  include_about?: boolean;
}

/** Normalize + validate each handle (see {@link normalizeHandle}), discard
 * malformed ones, and dedupe case-insensitively while preserving first-seen
 * order. */
export function normalizeHandles(handles: string[] | undefined): string[] {
  if (!handles) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of handles) {
    if (typeof raw !== "string") continue;
    const h = normalizeHandle(raw);
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

// Non-profile first path segments on x.com / twitter.com (routes, not handles).
const RESERVED_URL_SEGMENTS = new Set([
  "i",
  "home",
  "search",
  "hashtag",
  "explore",
  "notifications",
  "messages",
  "settings",
  "compose",
  "intent",
]);

/**
 * Extract the @handle from a standard profile URL (`x.com/<handle>`), or return
 * undefined for anything that is not a bare profile URL: a tweet permalink
 * (`/<handle>/status/…`), an `/i/…` route, a search, or a foreign host.
 */
export function handleFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^www\./, "").replace(/^mobile\./, "");
  if (host !== "x.com" && host !== "twitter.com") return undefined;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // A profile URL is exactly one path segment. Deeper paths are tweets/routes.
  if (segments.length !== 1) return undefined;
  const stripped = segments[0].replace(/^@/, "");
  if (!stripped || RESERVED_URL_SEGMENTS.has(stripped.toLowerCase())) return undefined;
  // Validate the handle grammar too, so e.g. x.com/foo.bar yields no target.
  return normalizeHandle(segments[0]);
}

export interface ProfileTargets {
  /** Normalized handles to send as the Actor's `twitterHandles`. */
  handles: string[];
  /** Profile URLs to send as the Actor's `startUrls`. */
  urls: string[];
  /** Lowercased handle set used to filter the dataset back to the request. */
  names: Set<string>;
}

/** Resolve the caller's args into the Actor's targeting fields plus the
 * lowercased name set we filter results against. */
export function profileTargets(args: XProfileArgs): ProfileTargets {
  const handles = normalizeHandles(args.handles);
  const names = new Set<string>(handles.map((h) => h.toLowerCase()));
  const urls: string[] = [];
  for (const raw of args.profile_urls ?? []) {
    if (typeof raw !== "string") continue;
    const u = raw.trim();
    if (!u) continue;
    urls.push(u);
    const h = handleFromUrl(u);
    if (h) names.add(h.toLowerCase());
  }
  return { handles, urls, names };
}

/** A request needs at least one handle or profile URL. */
export function hasProfileTarget(args: XProfileArgs): boolean {
  const { handles, urls } = profileTargets(args);
  return handles.length > 0 || urls.length > 0;
}

/** Map the caller's input onto the Actor's input schema, over-fetching by
 * {@link PROFILE_PADDING_BUFFER} so suggestion padding never truncates a
 * requested profile out of the window (see file header). */
export function buildProfileInput(args: XProfileArgs): Record<string, unknown> {
  const { handles, urls } = profileTargets(args);
  const targetCount = handles.length + urls.length;
  const input: Record<string, unknown> = {
    getAbout: args.include_about ?? true,
    maxItems: targetCount + PROFILE_PADDING_BUFFER,
  };
  if (handles.length) input.twitterHandles = handles;
  if (urls.length) input.startUrls = urls;
  return input;
}

/**
 * Filter raw dataset items down to exactly the requested profiles, dropping the
 * Actor's suggestion padding, deduping by handle, and preserving the order the
 * Actor returned. If no handle could be resolved for filtering (only
 * unparseable URLs were given) fall back to the first `targetCount` items so the
 * caller still gets data rather than an empty result.
 */
export function selectProfiles(
  items: Record<string, unknown>[],
  args: XProfileArgs,
): Record<string, unknown>[] {
  const { handles, urls, names } = profileTargets(args);
  if (names.size === 0) return items.slice(0, handles.length + urls.length);

  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    const userName = item.userName;
    if (typeof userName !== "string") continue;
    const key = userName.toLowerCase();
    if (!names.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
