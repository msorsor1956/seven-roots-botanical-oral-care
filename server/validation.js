import { formatBySlug, formatSlugByName } from "./catalog.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;

const cleanText = (value, maxLength) => String(value ?? "")
  .normalize("NFKC")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, maxLength);

const cleanEmail = (value) => cleanText(value, 254).toLowerCase();

const resolveFormat = (value) => {
  const candidate = cleanText(value, 80).toLowerCase();
  if (formatBySlug.has(candidate)) return candidate;
  return formatSlugByName.get(candidate) ?? "";
};

export function validateWaitlist(input) {
  const value = {
    name: cleanText(input?.name, 100),
    email: cleanEmail(input?.email),
    preferredFormat: resolveFormat(input?.preferredFormat),
    country: cleanText(input?.country, 80),
    source: cleanText(input?.source || "website-dialog", 80),
    consent: input?.consent === true,
    website: cleanText(input?.website, 120)
  };
  const errors = {};
  if (value.name.length < 2) errors.name = "Enter your name.";
  if (!emailPattern.test(value.email)) errors.email = "Enter a valid email address.";
  if (!value.preferredFormat) errors.preferredFormat = "Choose a valid product format.";
  if (!value.consent) errors.consent = "Consent is required to join the pre-launch list.";
  return { value, errors, valid: Object.keys(errors).length === 0 };
}

export function validateInquiry(input) {
  const allowedTypes = new Set(["wholesale", "retail", "press", "sourcing", "general"]);
  const value = {
    name: cleanText(input?.name, 100),
    email: cleanEmail(input?.email),
    phone: cleanText(input?.phone, 30),
    organization: cleanText(input?.organization, 120),
    inquiryType: cleanText(input?.inquiryType || "general", 30).toLowerCase(),
    message: cleanText(input?.message, 2000),
    consent: input?.consent === true,
    website: cleanText(input?.website, 120)
  };
  const errors = {};
  if (value.name.length < 2) errors.name = "Enter your name.";
  if (!emailPattern.test(value.email)) errors.email = "Enter a valid email address.";
  if (!allowedTypes.has(value.inquiryType)) errors.inquiryType = "Choose a valid inquiry type.";
  if (value.message.length < 10) errors.message = "Tell us a little more about your inquiry.";
  if (!value.consent) errors.consent = "Consent is required to submit this inquiry.";
  return { value, errors, valid: Object.keys(errors).length === 0 };
}
