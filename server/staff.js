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
    requiresOnboarding: false,
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: [
      "staff.manage", "staff.view", "finance.view", "reports.export", "orders.view", "orders.fulfill",
      "inventory.view", "inventory.count", "inventory.approve", "inventory.adjust", "transfers.view",
      "transfers.create", "transfers.approve", "transfers.dispatch", "transfers.receive", "tasks.view",
      "tasks.manage", "tasks.update", "tasks.approve", "onboarding.review", "directory.view", "profile.update", "audit.view", "integrations.manage"
    ]
  }),
  liberia_manager: Object.freeze({
    id: "liberia_manager",
    label: "Liberia warehouse manager",
    description: "Runs receiving, quality, counts, packing, and outbound transfer work in Liberia.",
    requiresOnboarding: false,
    allowedLocations: ["liberia"],
    defaultLocations: ["liberia"],
    permissions: [
      "inventory.view", "inventory.count", "inventory.approve", "transfers.view", "transfers.create",
      "transfers.dispatch", "tasks.view", "tasks.manage", "tasks.update", "tasks.approve", "onboarding.review", "directory.view", "profile.update"
    ]
  }),
  liberia_staff: Object.freeze({
    id: "liberia_staff",
    label: "Liberia warehouse staff",
    description: "Completes assigned receiving, quality, packing, and physical count work.",
    requiresOnboarding: true,
    allowedLocations: ["liberia"],
    defaultLocations: ["liberia"],
    permissions: ["inventory.view", "inventory.count", "transfers.view", "tasks.view", "tasks.update", "directory.view", "profile.update"]
  }),
  us_manager: Object.freeze({
    id: "us_manager",
    label: "U.S. fulfillment manager",
    description: "Runs U.S. receiving, inventory, order fulfillment, returns, and transfer reconciliation.",
    requiresOnboarding: false,
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: [
      "orders.view", "orders.fulfill", "inventory.view", "inventory.count", "inventory.approve",
      "transfers.view", "transfers.receive", "tasks.view", "tasks.manage", "tasks.update", "tasks.approve", "onboarding.review", "directory.view", "profile.update"
    ]
  }),
  us_fulfillment: Object.freeze({
    id: "us_fulfillment",
    label: "U.S. fulfillment staff",
    description: "Picks, packs, ships, receives, and completes assigned U.S. warehouse work.",
    requiresOnboarding: true,
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: ["orders.view", "orders.fulfill", "inventory.view", "inventory.count", "transfers.view", "tasks.view", "tasks.update", "directory.view", "profile.update"]
  }),
  finance: Object.freeze({
    id: "finance",
    label: "Finance",
    description: "Reviews payment records and financial reports without warehouse write access.",
    requiresOnboarding: true,
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: ["finance.view", "reports.export", "orders.view", "tasks.view", "tasks.update", "directory.view", "profile.update"]
  }),
  customer_support: Object.freeze({
    id: "customer_support",
    label: "Customer support",
    description: "Reviews customer orders and completes support or return tasks without financial controls.",
    requiresOnboarding: true,
    allowedLocations: ["us"],
    defaultLocations: ["us"],
    permissions: ["orders.view", "tasks.view", "tasks.update", "directory.view", "profile.update"]
  }),
  auditor: Object.freeze({
    id: "auditor",
    label: "Auditor / read only",
    description: "Read-only access to assigned locations, reports, and operational history.",
    requiresOnboarding: true,
    allowedLocations: ["liberia", "us"],
    defaultLocations: ["liberia", "us"],
    permissions: ["finance.view", "orders.view", "inventory.view", "transfers.view", "tasks.view", "directory.view", "profile.update", "audit.view"]
  })
});

export const STAFF_ONBOARDING_MODULES = Object.freeze([
  Object.freeze({
    id: "personal_hygiene",
    order: 1,
    code: "PH",
    title: "Personal Hygiene",
    duration: "8 minutes",
    objective: "Protect the product, coworkers, and customers by maintaining clean personal habits before and during every shift.",
    sections: Object.freeze([
      Object.freeze({ heading: "Arrive ready", points: Object.freeze(["Bathe regularly and report in clean work clothing.", "Keep fingernails short, clean, and free of false nails or loose polish when handling product.", "Cover cuts with a waterproof dressing and a glove when hands may contact product or packaging."]) }),
      Object.freeze({ heading: "Wash hands correctly", points: Object.freeze(["Wash with soap and clean running water for at least 20 seconds.", "Wash before starting work and after breaks, restroom use, eating, coughing, sneezing, waste handling, or touching unclean surfaces.", "Dry with a clean single-use towel or approved hand dryer; never wipe hands on work clothing."]) }),
      Object.freeze({ heading: "Report illness", points: Object.freeze(["Tell a manager before work if you have vomiting, diarrhea, fever, an infected skin condition, or another illness that may contaminate product.", "Follow management instructions before returning to product-handling duties."]) })
    ]),
    question: "How long should hands be washed with soap and clean running water?",
    options: Object.freeze([
      Object.freeze({ id: "five_seconds", label: "About 5 seconds" }),
      Object.freeze({ id: "twenty_seconds", label: "At least 20 seconds" }),
      Object.freeze({ id: "only_when_dirty", label: "Only when dirt is visible" })
    ]),
    correctAnswer: "twenty_seconds"
  }),
  Object.freeze({
    id: "workplace_hygiene",
    order: 2,
    code: "WH",
    title: "Workplace Hygiene",
    duration: "9 minutes",
    objective: "Keep receiving, processing, packing, storage, and fulfillment areas clean enough to prevent contamination and product mix-ups.",
    sections: Object.freeze([
      Object.freeze({ heading: "Clean as you go", points: Object.freeze(["Follow the posted cleaning schedule and use only approved cleaning materials.", "Clean and sanitize tools and contact surfaces before work, between incompatible activities, and after contamination.", "Keep chemicals labeled and stored away from chewing sticks, packaging, and shipping supplies."]) }),
      Object.freeze({ heading: "Control contamination", points: Object.freeze(["Separate incoming raw material, approved product, rejected product, returns, and waste.", "Keep food, drinks, tobacco, and personal items outside product-handling zones.", "Never place product or primary packaging directly on the floor."]) }),
      Object.freeze({ heading: "Escalate problems", points: Object.freeze(["Stop work and notify a manager when you see pests, spills, damaged packaging, foreign material, unusual odor, mold, or unsafe equipment.", "Do not release quarantined or rejected stock without written authorization."]) })
    ]),
    question: "What is the correct response when a product-contact surface becomes contaminated?",
    options: Object.freeze([
      Object.freeze({ id: "finish_first", label: "Finish the batch, then clean" }),
      Object.freeze({ id: "wipe_clothing", label: "Wipe it with work clothing" }),
      Object.freeze({ id: "clean_as_you_go", label: "Stop, clean and sanitize it before continuing" })
    ]),
    correctAnswer: "clean_as_you_go"
  }),
  Object.freeze({
    id: "ppe",
    order: 3,
    code: "PPE",
    title: "Personal Protective Equipment",
    duration: "8 minutes",
    objective: "Select, inspect, wear, remove, and replace PPE correctly for the task and the posted warehouse rules.",
    sections: Object.freeze([
      Object.freeze({ heading: "Use task-specific PPE", points: Object.freeze(["Wear the hair restraint, clean protective clothing, gloves, eye protection, safety footwear, mask, or other PPE assigned in the Scope of Work or posted procedure.", "PPE reduces exposure but never replaces handwashing, training, guards, or safe work practices."]) }),
      Object.freeze({ heading: "Inspect before use", points: Object.freeze(["Check PPE for holes, tears, contamination, poor fit, missing parts, or expired service life.", "Replace disposable gloves when torn, contaminated, or when changing activities; never wash disposable gloves for reuse."]) }),
      Object.freeze({ heading: "Remove safely", points: Object.freeze(["Remove PPE without touching contaminated outer surfaces where possible.", "Discard single-use PPE in the assigned container and clean reusable PPE according to the posted procedure.", "Report missing or damaged PPE before starting the task."]) })
    ]),
    question: "What should you do before using assigned PPE?",
    options: Object.freeze([
      Object.freeze({ id: "inspect_before_use", label: "Inspect its condition and fit" }),
      Object.freeze({ id: "share_without_cleaning", label: "Share it without cleaning" }),
      Object.freeze({ id: "skip_handwashing", label: "Use it instead of washing hands" })
    ]),
    correctAnswer: "inspect_before_use"
  }),
  Object.freeze({
    id: "customer_service",
    order: 4,
    code: "CST",
    title: "Customer Service Training",
    duration: "10 minutes",
    objective: "Serve customers respectfully, protect their information, and resolve order or product concerns without making unsupported promises.",
    sections: Object.freeze([
      Object.freeze({ heading: "Listen and confirm", points: Object.freeze(["Greet the customer respectfully, listen without interrupting, and repeat the concern in plain language.", "Confirm the order number and only the minimum information needed to locate the order."]) }),
      Object.freeze({ heading: "Resolve within authority", points: Object.freeze(["Explain the next step, owner, and expected follow-up time.", "Record the interaction accurately and escalate refunds, safety concerns, adverse reactions, legal threats, or matters outside your role.", "Never promise a medical outcome or invent product, shipping, or refund information."]) }),
      Object.freeze({ heading: "Protect privacy", points: Object.freeze(["Use customer information only for assigned work and never share passwords, payment details, addresses, or order records through unauthorized channels.", "Do not request or store full payment-card numbers."]) })
    ]),
    question: "Which sequence best handles a customer concern?",
    options: Object.freeze([
      Object.freeze({ id: "argue_defend_close", label: "Argue, defend, and close the conversation" }),
      Object.freeze({ id: "listen_confirm_resolve", label: "Listen, confirm, resolve or escalate, and document" }),
      Object.freeze({ id: "promise_anything", label: "Promise anything needed to end the call" })
    ]),
    correctAnswer: "listen_confirm_resolve"
  })
]);

export const publicOnboardingCatalog = () => STAFF_ONBOARDING_MODULES.map(({ correctAnswer, ...module }) => ({
  ...module,
  sections: module.sections.map((section) => ({ heading: section.heading, points: [...section.points] })),
  options: module.options.map((option) => ({ ...option }))
}));

export const staffOnboardingRequired = (user) => Boolean(STAFF_ROLES[user?.role]?.requiresOnboarding);

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
export const cleanStaffPhone = (value) => cleanStaffText(value, 40);

export const roleCatalog = () => Object.values(STAFF_ROLES).map((role) => ({
  id: role.id,
  label: role.label,
  description: role.description,
  allowedLocations: [...role.allowedLocations],
  defaultLocations: [...role.defaultLocations],
  requiresOnboarding: role.requiresOnboarding,
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
    phone: user.phone || "",
    whatsappNumber: user.whatsappNumber || "",
    jobTitle: user.jobTitle || "",
    role: user.role,
    roleLabel: role?.label || user.role,
    country: user.country,
    locations: staffLocations(user),
    managerId: user.managerId || "",
    profilePhotoUrl: user.profilePhoto?.id ? `/api/v1/staff/files/${encodeURIComponent(user.profilePhoto.id)}` : null,
    profileReady: Boolean(user.profilePhoto?.id && user.signature?.id),
    onboardingRequired: Boolean(role?.requiresOnboarding),
    onboardingStatus: role?.requiresOnboarding ? (user.onboarding?.status || "not_started") : "approved",
    dashboardAccess: !role?.requiresOnboarding || user.onboarding?.status === "approved",
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
    phone: cleanStaffPhone(input?.phone),
    whatsappNumber: cleanStaffPhone(input?.whatsappNumber),
    jobTitle: cleanStaffText(input?.jobTitle, 100),
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
  if (value.phone && !/^\+?[0-9() .-]{7,24}$/u.test(value.phone)) {
    details.phone = "Enter a valid employee phone number.";
  }
  if (value.whatsappNumber && !/^\+[1-9]\d{7,14}$/u.test(value.whatsappNumber)) {
    details.whatsappNumber = "Enter the WhatsApp number in international format, such as +231... or +1....";
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
  "SameSite=Strict",
  "Priority=High",
  `Max-Age=${maxAge}`,
  ...(secure ? ["Secure"] : [])
].join("; ");

export const clearStaffSessionCookie = ({ secure = false } = {}) => [
  "sr_staff_session=",
  "Path=/",
  "HttpOnly",
  "SameSite=Strict",
  "Priority=High",
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
