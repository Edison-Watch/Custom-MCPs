// Structured Apify-failure logging lives once in shared/apify/ts. Re-exported
// here so src/index.ts and the unit tests import a stable local path.
export * from "../../../shared/apify/ts/log";
