import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export const STAFF_LOCATIONS = Object.freeze({
  liberia: Object.freeze({ id: "liberia", label: "Liberia warehouse", shortLabel: "Liberia" }),
  us: Object.freeze({ id: "us", label: "U.S. fulfillment", shortLabel: "U.S." })
});

export const STAFF_ROLES = Object.freeze({
  owner: Object.freeze({
    id: "owner",
    label: "Owner / super admin",
    description: "Full access to staff, operations, finance, integrations, and both locations.",
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: [
      "staff.manage", "staff.view", "finance.view", "reports.export", "orders.view", "orders.fulfill",
      "inventory.view", "inventory.count", "inventory.approve", "inventory.adjust", "transfers.view",
      "transfers.create", "transfers.approve", "transfers.dispatch", "transfers.receive", "tasks.view",
      "tasks.manage", "tasks.update", "audit.view", "integrations.manage"
    ]
  }),
  liberia_manager: Object.freeze({
    id: "liberia_manager",
    label: "Liberia warehouse manager",
    description: "Runs receiving, quality, counts, packing, and outbound transfer work in Liberia.",
    allowedLocations: ["liberia"],
    defaultLocations: ["liberia"],
    permissions: [
      "inventory.view", "inventory.count", "inventory.approve", "transfers.view", "transfers.create",
      "transfers.dispatch", "tasks.view", "tasks.manage", "tasks.update"
    ]
  }),
  liberia_staff: Object.freeze({
    id: "liberia_staff",
    label: "Liberia warehouse staff",
    description: "Completes assigned receiving, quality, packing, and physical count work.",
    allowedLocations: ["liberia"],
    defaultLocations: ["liberia"],
    permissions: ["inventory.view", "inventory.count", "transfers.view", "tasks.view", "tasks.update"]
  }),
  us_manager: Object.freeze({
    id: "us_manager",
    label: "U.S. fulfillment manager",
    description: "Runs U.S. receiving, inventory, order fulfillment, returns, and transfer reconciliation.",
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: [
      "orders.view", "orders.fulfill", "inventory.view", "inventory.count", "inventory.approve",
      "transfers.view", "transfers.receive", "tasks.view", "tasks.manage", "tasks.update"
    ]
  }),
  us_fulfillment: Object.freeze({
    id: "us_fulfillment",
    label: "U.S. fulfillment staff",
    description: "Picks, packs, ships, receives, and completes assigned U.S. warehouse work.",
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: ["orders.view", "orders.fulfill", "inventory.view", "inventory.count", "transfers.view", "tasks.view", "tasks.update"]
  }),
  finance: Object.freeze({
    id: "finance",
    label: "Finance",
    description: "Reviews payment records and financial reports without warehouse write access.",
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: ["finance.view", "reports.export", "orders.view", "tasks.view", "tasks.update"]
  }),
  customer_support: Object.freeze({
    id: "customer_support",
    label: "Customer support",
    description: "Reviews customer orders and completes support or return tasks without financial controls.",
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: ["orders.view", "tasks.view", "tasks.update"]
  }),
  auditor: Object.freeze({
    id: "auditor",
    label: "Auditor / read only",
    description: "Read-only access to assigned locations, reports, and operational history.",
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: ["finance.view", "orders.view", "inventory.view", "transfers.view", "tasks.view", "audit.view"]
  })
});

export class StaffValidationError extends Error {
  constructor(message, details = {}, code = "staff_validation_failed") {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class StaffAccessError extends Error {
  constructor(message, code = "staff_access_denied", status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const cleanStaffText = (value, maxLength = 180) => String(value ?? "")
  .normalize("NFKC")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, maxLength);

export const cleanStaffEmail = (value) => cleanStaffText(value, 254).toLowerCase();

export const roleCatalog = () => Object.values(STAFF_ROLES).map((role) => ({
  id: role.id,
  label: role.label,
  description: role.description,
  allowedLocations: [...role.allowedLocations],
  defaultLocations: [...role.defaultLocations],
  permissions: [...role.permissions]
}));

export const hasStaffPermission = (user, permission) => Boolean(
  user && STAFF_ROLES[user.role]?.permissions.includes(permission)
);

export const staffLocations = (user) => Array.isArray(user?.locations)
  ? user.locations.filter((location) => Object.hasOwn(STAFF_LOCATIONS, location))
  : [];

export const canAccessStaffLocation = (user, location) => staffLocations(user).includes(location);

export const publicStaffUser = (user) => {
  if (!user) return null;
  const role = STAFF_ROLES[user.role];
  return {
    id: user.id,
    employeeNumber: user.employeeNumber,
    name: user.name,
    email: user.email,
    role: user.role,
    roleLabel: role?.label || user.role,
    country: user.country,
    locations: staffLocations(user),
    managerId: user.managerId || "",
    status: user.status,
    lastLoginAt: user.lastLoginAt || null,
    invitedAt: user.invitedAt || null,
    acceptedAt: user.acceptedAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    permissions: role ? [...role.permissions] : []
  };
};

export function validateStaffUserInput(input, { partial = false } = {}) {
  const details = {};
  const role = cleanStaffText(input?.role, 40).toLowerCase();
  const roleDefinition = STAFF_ROLES[role];
  const locationsInput = Array.isArray(input?.locations) ? input.locations : [];
  const requestedLocations = [...new Set(locationsInput.map((value) => cleanStaffText(value, 20).toLowerCase()))];
  const value = {
    name: cleanStaffText(input?.name, 120),
    email: cleanStaffEmail(input?.email),
    role,
    country: cleanStaffText(input?.country, 80),
    locations: requestedLocations,
    managerId: cleanStaffText(input?.managerId, 80),
    status: cleanStaffText(input?.status, 20).toLowerCase()
  };

  if (!partial || Object.hasOwn(input || {}, "name")) {
    if (value.name.length < 2) details.name = "Enter the employee's full name.";
  }
  if (!partial || Object.hasOwn(input || {}, "email")) {
    if (!emailPattern.test(value.email)) details.email = "Enter a valid work email address.";
  }
  if (!partial || Object.hasOwn(input || {}, "role")) {
    if (!roleDefinition) details.role = "Choose a valid staff role.";
  }
  if (!partial || Object.hasOwn(input || {}, "locations") || Object.hasOwn(input || {}, "role")) {
    const allowed = roleDefinition?.allowedLocations || [];
    const resolved = requestedLocations.length ? requestedLocations : (roleDefinition?.defaultLocations || []);
    if (!resolved.length || resolved.some((location) => !allowed.includes(location))) {
      details.locations = "Choose only locations permitted for this role.";
    }
    value.locations = resolved;
  }
  if (value.status && !["invited", "active", "inactive"].includes(value.status)) {
    details.status = "Choose invited, active, or inactive.";
  }
  if (Object.keys(details).length) throw new StaffValidationError("Check the employee details.", details);
  return value;
}

export function validateStaffPassword(value) {
  const password = typeof value === "string" ? value : "";
  const details = {};
  if (password.length < PASSWORD_MIN_LENGTH) details.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) details.password = `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  if (/\u0000/u.test(password)) details.password = "The password contains an unsupported character.";
  if (Object.keys(details).length) throw new StaffValidationError("Choose a stronger password.", details, "weak_password");
  return password;
}

export async function hashStaffPassword(value) {
  const password = validateStaffPassword(value);
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return ["scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION, salt, Buffer.from(derived).toString("base64url")].join("$");
}

export async function verifyStaffPassword(value, record) {
  const password = typeof value === "string" ? value : "";
  const [algorithm, cost, blockSize, parallelization, salt, encoded] = String(record || "").split("$");
  if (algorithm !== "scrypt" || !salt || !encoded) return false;
  try {
    const expected = Buffer.from(encoded, "base64url");
    const derived = Buffer.from(await scrypt(password, salt, expected.length, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelization),
      maxmem: SCRYPT_MAX_MEMORY
    }));
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export const createOpaqueToken = () => randomBytes(32).toString("base64url");
export const hashOpaqueToken = (value) => createHash("sha256").update(String(value || "")).digest("base64url");

export const staffSessionCookie = (token, { secure = false, maxAge = 12 * 60 * 60 } = {}) => [
  `sr_staff_session=${encodeURIComponent(token)}`,
  "Path=/",
  "HttpOnly",
  "SameSite=Lax",
  `Max-Age=${maxAge}`,
  ...(secure ? ["Secure"] : [])
].join("; ");

export const clearStaffSessionCookie = ({ secure = false } = {}) => [
  "sr_staff_session=",
  "Path=/",
  "HttpOnly",
  "SameSite=Lax",
  "Max-Age=0",
  ...(secure ? ["Secure"] : [])
].join("; ");

export const readStaffSessionCookie = (request) => {
  const cookies = String(request?.headers?.cookie || "").split(";");
  for (const item of cookies) {
    const [name, ...value] = item.trim().split("=");
    if (name === "sr_staff_session") return decodeURIComponent(value.join("="));
  }
  return "";
};

export const secureStaffValueEqual = (left, right) => {
  if (!left || !right) return false;
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
};
