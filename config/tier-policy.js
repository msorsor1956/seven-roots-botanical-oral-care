export const TRAINING_FEATURE_FLAG = "ENABLE_TRAINING_MODULE";

export const ACCESS_TIERS = Object.freeze({
  LOCKED: "TIER_0",
  LIMITED: "TIER_1",
  FULL: "TIER_2"
});

export const TIER_ONE_ALLOWLIST = Object.freeze([
  "/api/v1/staff/workspace",
  "/api/v1/staff/profile",
  "/api/v1/staff/onboarding",
  "/api/v1/staff/verification",
  "/api/v1/staff/session",
  "/api/v1/staff/logout"
]);

export const trainingFeatureEnabled = (environment = process.env) =>
  String(environment[TRAINING_FEATURE_FLAG] || "").toLowerCase() === "true";
