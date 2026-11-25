/**
 * Pure, runtime-agnostic helpers for the x-scraper's profile tool (`x_profile`).
 *
 * Backed by the `apidojo/twitter-user-scraper` Apify Actor - a *different* Actor
 * from the tweet scraper in `x.ts`. Given X handles or profile URLs it returns
 * full user objects (bio, follower/following counts, verified flag, join date,
 * location, tweet count...).
 *
 * Quirk this module exists to tame: the Actor's `getFollowers`, `getFollowing`
 * and `getRetweeters` inputs all DEFAULT TO TRUE. Left on, a profile lookup also
 * scrapes each account's followers and following (rows tagged `followerOf` /
 * `followedBy`), each a billed "Follower/Following Query" plus a billed dataset
 * item, and those rows share the `maxItems` window with the profiles - so a
 * requested profile could be crowded out and silently dropped (observed:
 * `["openai","sama"]` at maxItems 12 returned OpenAI plus 10 of its
 * following/followers; `sama` at maxItems 1 returned `paulg`, one of sama's
 * follows). We turn all three off and ask for one item per target plus
 * {@link PROFILE_HEADROOM};
 * {@link selectProfiles} still filters to the requested set as a defensive floor,
 * and {@link missingTargets} names any requested account that did not come back.
 */

import { normalizeHandle } from "./x";

export const DEFAULT_PROFILE_ACTOR_ID = "apidojo~twitter-user-scraper";

/**
 * Small headroom over the target count. With follower/following scraping off
 * the Actor returns only the requested profiles (measured: 2 handles at
 * maxItems 4 returned exactly 2), and it bills per item actually returned, so
 * unused headroom costs nothing. It only matters if the Actor ever starts
 * emitting an extra non-requested row again: then that row cannot crowd a
 * requested profile out of the window, and selectProfiles drops it.
 */
export const PROFILE_HEADROOM = 2;

/**
 * Hard cap on how many accounts one call may request. Each requested account is
 * a billed Actor item, so an unbounded array would let a caller force an
 * arbitrarily large paid run; enforced at the tool's input schema.
 */
export const MAX_PROFILE_TARGETS = 50;

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

/**
 * Count unique account identities in a request: a handle, or the raw URL when it
 * has no resolvable handle. Used both to size the run and to enforce the
 * per-call target cap, so repeating or overlapping targets can neither inflate
 * `maxItems` nor slip past the limit.
 */
export function uniqueTargetCount(args: XProfileArgs): number {
  const { handles, urls } = profileTargets(args);
  return new Set([
    ...handles.map((h) => h.toLowerCase()),
    ...urls.map((u) => handleFromUrl(u)?.toLowerCase() ?? u.toLowerCase()),
  ]).size;
}

export function buildProfileInput(args: XProfileArgs): Record<string, unknown> {
  const { handles, urls } = profileTargets(args);
  const targetCount = uniqueTargetCount(args);
  const input: Record<string, unknown> = {
    getAbout: args.include_about ?? true,
    // Profiles only: these default to true in the Actor (see file header).
    getFollowers: false,
    getFollowing: false,
    getRetweeters: false,
    maxItems: targetCount + PROFILE_HEADROOM,
  };
  if (handles.length) input.twitterHandles = handles;
  if (urls.length) input.startUrls = urls;
  return input;
}

/**
 * Filter raw dataset items down to exactly the requested profiles, dropping the
 * Actor's suggestion padding, deduping by handle, and preserving the order the
 * Actor returned. If no handle could be resolved for filtering (only unparseable
 * URLs were given) returns nothing, so padding is never mistaken for a result -
 * the tool rejects such requests up front, so this is a defensive floor.
 */
export function selectProfiles(
  items: Record<string, unknown>[],
  args: XProfileArgs,
): Record<string, unknown>[] {
  const { names } = profileTargets(args);
  // No resolvable handle to match against (only unparseable URLs). Returning the
  // raw items here would hand back the Actor's who-to-follow padding as if it
  // were the requested profile, so return nothing instead.
  if (names.size === 0) return [];

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

/**
 * Requested handles (as the caller spelled them, URL targets resolved to their
 * handle) with no matching profile in `profiles`, so a dropped or nonexistent
 * account is reported instead of silently missing from the result. Handles that
 * fail X's handle grammar (see normalizeHandle: 1-15 of `[A-Za-z0-9_]`) are never
 * sent to the Actor, so they are reported here too rather than vanishing.
 */
export function missingTargets(profiles: Record<string, unknown>[], args: XProfileArgs): string[] {
  const found = new Set(
    profiles.flatMap((p) => (typeof p.userName === "string" ? [p.userName.toLowerCase()] : [])),
  );
  const { handles, urls } = profileTargets(args);
  const requested = [...handles, ...urls.flatMap((u) => handleFromUrl(u) ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of requested) {
    const key = h.toLowerCase();
    if (found.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  for (const raw of args.handles ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    // Blank entries are not targets; valid ones were handled above.
    if (!trimmed || trimmed === "@" || normalizeHandle(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
