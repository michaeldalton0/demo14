import { sendPostingReviewEmail } from "./posting-review.js";
import { enforceEmailRateLimit, enforceIpRateLimit } from "./rate-limit.js";

const CONTACT_MAX_LENGTHS = {
  name: 120,
  email: 254,
  subject: 160,
  message: 4000,
  associationSlug: 80,
  website: 500,
  pageSource: 500
};

function normalizeText(value = "", maxLength = 4000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maxLength)
    .trim();
}

function isEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function parseContactRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";
  let body;

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    body = Object.fromEntries((await request.formData()).entries());
  }

  return {
    name: normalizeText(body.name, CONTACT_MAX_LENGTHS.name),
    email: normalizeText(body.email, CONTACT_MAX_LENGTHS.email).toLowerCase(),
    subject: normalizeText(body.subject || body.topic, CONTACT_MAX_LENGTHS.subject),
    message: normalizeText(body.message, CONTACT_MAX_LENGTHS.message),
    associationSlug: normalizeText(
      body.associationSlug || body.association || "",
      CONTACT_MAX_LENGTHS.associationSlug
    ).toLowerCase(),
    website: normalizeText(body.website || body._honey, CONTACT_MAX_LENGTHS.website),
    pageSource: normalizeText(
      body.pageSource || request.headers.get("Referer") || "",
      CONTACT_MAX_LENGTHS.pageSource
    )
  };
}

function validateContact(contact) {
  if (!contact.name || !contact.email || !contact.subject || !contact.message) {
    return "Please complete name, email, subject, and message.";
  }
  if (!isEmail(contact.email)) {
    return "Please enter a valid email address.";
  }
  if (contact.subject.length < 3 || contact.message.length < 10) {
    return "Please include enough detail for WPCNA to respond.";
  }
  if (contact.associationSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contact.associationSlug)) {
    return "The neighborhood association selection is invalid.";
  }
  return "";
}

function contactEmailBody(contact, timestamp) {
  return [
    "WPCNA WEBSITE CONTACT",
    `Name: ${contact.name}`,
    `Email: ${contact.email}`,
    `Subject: ${contact.subject}`,
    `Association: ${contact.associationSlug || "General WPCNA contact"}`,
    `Page/source: ${contact.pageSource || "Unknown"}`,
    `Timestamp: ${timestamp}`,
    "",
    "MESSAGE",
    contact.message
  ].join("\n");
}

export async function handleContactSubmission({ request, env, corsHeaders, jsonResponse, errorResponse }) {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, corsHeaders);
  }

  const ipLimit = await enforceIpRateLimit({
    env,
    request,
    scope: "forms",
    limitedMessage: "Too many messages. Please try again in a minute."
  });
  if (!ipLimit.ok) {
    return errorResponse(ipLimit.error, ipLimit.status, corsHeaders);
  }

  let contact;
  try {
    contact = await parseContactRequest(request);
  } catch {
    return errorResponse("Invalid contact request.", 400, corsHeaders);
  }

  if (contact.website) {
    return jsonResponse({ ok: true, message: "Your message has been received." }, 200, corsHeaders);
  }

  const validationError = validateContact(contact);
  if (validationError) {
    return errorResponse(validationError, 422, corsHeaders);
  }

  const emailLimit = await enforceEmailRateLimit({
    env,
    email: contact.email,
    scope: "forms",
    limitedMessage: "Too many messages for this email address. Please try again in a minute."
  });
  if (!emailLimit.ok) {
    return errorResponse(emailLimit.error, emailLimit.status, corsHeaders);
  }

  const prefix = normalizeText(env.CONTACT_SUBJECT_PREFIX || "WPCNA Website Contact", 80);
  const associationTag = contact.associationSlug ? ` [${contact.associationSlug}]` : "";

  try {
    await sendPostingReviewEmail({
      env,
      subject: `${prefix}${associationTag}: ${contact.subject}`.slice(0, 220),
      body: contactEmailBody(contact, new Date().toISOString()),
      replyTo: contact.email
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "Contact email delivery failed",
      associationSlug: contact.associationSlug || "general",
      error: String(error && error.message ? error.message : error)
    }));
    return errorResponse("Your message could not be delivered right now. Please try again later.", 502, corsHeaders);
  }

  return jsonResponse(
    { ok: true, message: "Your message has been received by WPCNA." },
    200,
    corsHeaders
  );
}
