// The fleet auth contract lives once in shared/auth/ts. This connector just
// re-exports it so src/index.ts and the unit tests import a stable local path
// while the verify logic stays a single source of truth across every server.
export * from "../../../shared/auth/ts/auth";
