import { reviewPostingWithAnthropic } from "./anthropic.js";
import { signPosting, postingFromSubmission } from "./publish.js";

const POSTING_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const POSTING_RATE_LIMIT_MAX = 5;
const POSTING_MAX_LENGTHS = {
  name: 120,
  email: 254,
  subject: 160,
  category: 80,
  postingType: 80,
  organization: 140,
  eventDate: 40,
  eventTime: 40,
  location: 180,
  audience: 500,
  whitePlainsAffiliation: 160,
  fundraising: 12,
  linksIncluded: 12,
  guidelinesConfirmed: 12,
  message: 4000,
  website: 500
};
const REQUIRED_POSTING_FIELDS = [
  "name",
  "email",
  "subject",
  "category",
  "postingType",
  "whitePlainsAffiliation",
  "fundraising",
  "linksIncluded",
  "message"
];
const POSTING_FIELD_LABELS = {
  name: "Contact name",
  email: "Contact email",
  subject: "Posting/event title",
  category: "Submission category",
  postingType: "Posting type",
  whitePlainsAffiliation: "White Plains affiliation",
  fundraising: "Fundraising",
  linksIncluded: "Links included",
  message: "Main description"
};
const postingRateLimitStore = new Map();

const RECOMMENDATIONS = {
  ready: "READY FOR HUMAN REVIEW",
  needs: "NEEDS MORE INFORMATION",
  outside: "LIKELY OUTSIDE GUIDELINES",
  escalate: "ESCALATE TO HUMAN"
};

const CHECKLIST_LABELS = {
  relevantToWhitePlainsResidents: "Relevant to White Plains residents",
  communityServing: "Community-serving",
  civicEducationalPublicInterestPurpose: "Neighborhood/civic/educational/public-interest purpose",
  notPrivateClassifiedListing: "Not a private classified/listing",
  notCommercialAdvertising: "Not commercial advertising",
  notPersonalDisputeOrComplaint: "Not a personal dispute or complaint",
  notUrgentEmergencyMessaging: "Not urgent emergency messaging",
  includesDateIfTimeBased: "Includes date if time-based",
  includesTimeIfTimeBased: "Includes time if time-based",
  includesLocationIfLocationBased: "Includes location if location-based",
  includesOrganizerSource: "Includes organizer/source",
  includesContactInformationForFollowUp: "Includes contact information for follow-up"
};

const LOCAL_TERMS = [
  "white plains",
  "wp",
  "wpcna",
  "battle hill",
  "bronx river",
  "bryant gardens",
  "carhart",
  "church street",
  "eastview",
  "ferris",
  "fisher hill",
  "gedney",
  "good counsel",
  "highlands",
  "north broadway",
  "north street",
  "old oak ridge",
  "prospect park",
  "rosedale",
  "soundview",
  "westchester avenue",
  "westminster ridge",
  "woodcrest"
];

const EVENT_TERMS = [
  "block party",
  "cleanup",
  "clinic",
  "class",
  "event",
  "festival",
  "gathering",
  "meeting",
  "night",
  "parade",
  "picnic",
  "presentation",
  "program",
  "session",
  "tour",
  "walk",
  "workshop"
];

const COMMUNITY_TERMS = [
  "association",
  "block party",
  "civic",
  "cleanup",
  "community",
  "educational",
  "family",
  "garden",
  "guide",
  "library",
  "neighbors",
  "neighborhood",
  "public",
  "residents",
  "safety",
  "school",
  "volunteer",
  "workshop"
];

const OUTSIDE_RULES = [
  ["Yard sale", /\byard sale\b/i],
  ["Garage sale", /\bgarage sale\b/i],
  ["Personal item for sale", /\b(for sale|selling|item listing|personal item)\b/i],
  ["Discount/coupon/promotion", /\b(discount|coupon|promo|promotion|limited time offer)\b/i],
  ["Business/service advertisement", /\b(private tutoring|business service|service advertisement|book now|free estimate|hire me)\b/i],
  ["Real estate listing", /\b(real estate|open house|apartment rental|room for rent|lease available|condo for sale)\b/i],
  ["Job listing", /\b(job listing|hiring|now hiring|apply for this job|employment opportunity)\b/i],
  ["Private-benefit fundraiser", /\b(fundraiser|gofundme|donate to my|donate to our family)\b/i],
  ["Unrelated city focus", /\b(yonkers|scarsdale|new rochelle|rye|mamaroneck|harrison|bronxville|greenburgh)\b/i]
];

const ESCALATION_RULES = [
  ["Emergency or immediate danger", /\b(urgent emergency|immediate danger|call 911|evacuate|active threat)\b/i],
  ["Crime or accusation", /\b(stole|theft|assault|fraud|crime|criminal|illegal activity|accused|police report)\b/i],
  ["Named personal complaint", /\b(complaint against|harassment by|neighbor is|landlord is|tenant is)\b/i],
  ["Legal claim", /\b(lawsuit|sue|attorney|legal claim|court case|subpoena)\b/i],
  ["Medical advice or claim", /\b(medical advice|diagnosis|medication|cure|treatment plan|health claim)\b/i],
  ["Discriminatory or hateful language", /\b(discriminatory|racist|hate speech|slur)\b/i],
  ["Political campaign content", /\b(vote for|elect|candidate|campaign fundraiser|political campaign)\b/i],
  ["Threats or harassment", /\b(threat|threaten|harass|harassment|retaliation)\b/i],
  ["Defamatory or accusatory language", /\b(defamatory|corrupt|scam artist|dangerous person)\b/i]
];

function normalizeText(value = "", maxLength = 4000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, maxLength)
    .trim();
}

function rawText(value = "", maxLength = 4000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, maxLength);
}

function normalizeList(value = [], maxLength = 500) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return values
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, 12);
}

function safeEmailText(value = "", maxLength = 4000) {
  return rawText(value, maxLength)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function normalizeEmail(value = "") {
  return normalizeText(value, POSTING_MAX_LENGTHS.email).toLowerCase();
}

function isEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

function isPostingRateLimited(ipAddress) {
  const now = Date.now();

  for (const [ip, state] of postingRateLimitStore.entries()) {
    if (now - state.startedAt > POSTING_RATE_LIMIT_WINDOW_MS) {
      postingRateLimitStore.delete(ip);
    }
  }

  const current = postingRateLimitStore.get(ipAddress);

  if (!current) {
    postingRateLimitStore.set(ipAddress, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > POSTING_RATE_LIMIT_MAX;
}

async function parseSubmissionRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";
  let body = {};
  let audience = [];

  if (contentType.includes("application/json")) {
    body = await request.json();
    audience = Array.isArray(body.audience) ? body.audience : body.audience || [];
  } else {
    const formData = await request.formData();
    body = Object.fromEntries(formData.entries());
    audience = formData.getAll("audience");
  }

  const raw = {
    name: rawText(body.name, POSTING_MAX_LENGTHS.name),
    email: rawText(body.email, POSTING_MAX_LENGTHS.email),
    subject: rawText(body.subject, POSTING_MAX_LENGTHS.subject),
    category: rawText(body.category, POSTING_MAX_LENGTHS.category),
    postingType: rawText(body.postingType, POSTING_MAX_LENGTHS.postingType),
    organization: rawText(body.organization, POSTING_MAX_LENGTHS.organization),
    eventDate: rawText(body.eventDate, POSTING_MAX_LENGTHS.eventDate),
    eventTime: rawText(body.eventTime, POSTING_MAX_LENGTHS.eventTime),
    location: rawText(body.location, POSTING_MAX_LENGTHS.location),
    audience: normalizeList(audience, POSTING_MAX_LENGTHS.audience),
    whitePlainsAffiliation: rawText(body.whitePlainsAffiliation, POSTING_MAX_LENGTHS.whitePlainsAffiliation),
    fundraising: rawText(body.fundraising, POSTING_MAX_LENGTHS.fundraising),
    linksIncluded: rawText(body.linksIncluded, POSTING_MAX_LENGTHS.linksIncluded),
    guidelinesConfirmed: rawText(body.guidelinesConfirmed, POSTING_MAX_LENGTHS.guidelinesConfirmed),
    message: rawText(body.message, POSTING_MAX_LENGTHS.message),
    website: rawText(body.website || body._honey, POSTING_MAX_LENGTHS.website),
    pageSource: rawText(body.pageSource || request.headers.get("Referer") || "", 500)
  };

  const clean = {
    name: normalizeText(raw.name, POSTING_MAX_LENGTHS.name),
    email: normalizeEmail(raw.email),
    subject: normalizeText(raw.subject, POSTING_MAX_LENGTHS.subject),
    category: normalizeText(raw.category, POSTING_MAX_LENGTHS.category),
    postingType: normalizeText(raw.postingType, POSTING_MAX_LENGTHS.postingType),
    organization: normalizeText(raw.organization, POSTING_MAX_LENGTHS.organization),
    eventDate: normalizeText(raw.eventDate, POSTING_MAX_LENGTHS.eventDate),
    eventTime: normalizeText(raw.eventTime, POSTING_MAX_LENGTHS.eventTime),
    location: normalizeText(raw.location, POSTING_MAX_LENGTHS.location),
    audience: normalizeList(raw.audience, POSTING_MAX_LENGTHS.audience),
    whitePlainsAffiliation: normalizeText(raw.whitePlainsAffiliation, POSTING_MAX_LENGTHS.whitePlainsAffiliation),
    fundraising: normalizeText(raw.fundraising, POSTING_MAX_LENGTHS.fundraising),
    linksIncluded: normalizeText(raw.linksIncluded, POSTING_MAX_LENGTHS.linksIncluded),
    guidelinesConfirmed: normalizeText(raw.guidelinesConfirmed, POSTING_MAX_LENGTHS.guidelinesConfirmed).toLowerCase(),
    message: normalizeText(raw.message, POSTING_MAX_LENGTHS.message),
    website: normalizeText(raw.website, POSTING_MAX_LENGTHS.website),
    pageSource: normalizeText(raw.pageSource, 500)
  };

  return { raw, clean };
}

function validateSubmission(submission) {
  const missing = REQUIRED_POSTING_FIELDS.filter((field) => !submission[field]);

  if (missing.length) {
    return `Please complete ${missing.map((field) => POSTING_FIELD_LABELS[field] || field).join(", ")}.`;
  }

  if (submission.guidelinesConfirmed !== "yes") {
    return "Please confirm the WPCNA posting guidelines before submitting.";
  }

  if (!isEmail(submission.email)) {
    return "Please enter a valid email address.";
  }

  if (submission.subject.length < 3 || submission.message.length < 20) {
    return "Please include enough detail for WPCNA to review the posting.";
  }

  return "";
}

function includesAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function matchesRules(text, rules) {
  return rules
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

function hasConcreteDate(text) {
  return [
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+of\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/
  ].some((pattern) => pattern.test(text));
}

function hasConcreteTime(text) {
  return [
    /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
    /\b\d{1,2}\s*[-\u2013]\s*\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
    /\bnoon\b/i
  ].some((pattern) => pattern.test(text));
}

function hasLocation(text) {
  return /\b(?:avenue|ave\.?|street|st\.?|road|rd\.?|lane|ln\.?|park|library|school|hall|center|centre|entrance|greenway|plaza|parking lot|playground|field|church|temple|synagogue)\b/i.test(text);
}

function isEmergencyPreparedness(text) {
  return /\bemergency preparedness\b/i.test(text);
}

function wordCount(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function checklistValue(condition, fallback = "unclear") {
  if (condition === true) return "yes";
  if (condition === false) return "no";
  return fallback;
}

function cleanedDraftSummary(submission) {
  const firstSentence = normalizeText(submission.message)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)[0] || submission.message;

  return `${submission.subject}: ${firstSentence}`.slice(0, 320);
}

function reviewPostingSubmission(submission) {
  const audienceText = Array.isArray(submission.audience) ? submission.audience.join(", ") : "";
  const text = [
    submission.subject,
    submission.category,
    submission.postingType,
    submission.organization,
    submission.location,
    audienceText,
    submission.whitePlainsAffiliation,
    submission.message,
    submission.name
  ].filter(Boolean).join("\n").trim();
  const lower = text.toLowerCase();
  const eventLike = includesAny(lower, EVENT_TERMS) || /^(event|meeting|workshop|volunteer opportunity)$/i.test(submission.postingType);
  const datePresent = Boolean(submission.eventDate) || hasConcreteDate(text);
  const timePresent = Boolean(submission.eventTime) || hasConcreteTime(text);
  const locationPresent = Boolean(submission.location) || hasLocation(text);
  const local = includesAny(lower, LOCAL_TERMS) || /white plains/i.test(submission.whitePlainsAffiliation);
  const communityServing = includesAny(lower, COMMUNITY_TERMS) || /^(neighborhood|civic|workshop|learning|history|music & family|city notice|school\/family|volunteer\/cleanup)$/i.test(submission.category);
  const outsideFlags = matchesRules(text, OUTSIDE_RULES).filter((label) => {
    if (label === "Unrelated city focus") {
      return !local;
    }
    return true;
  });
  const escalationFlags = matchesRules(text, ESCALATION_RULES).filter((label) => {
    if (label === "Emergency or immediate danger") {
      return !isEmergencyPreparedness(text);
    }
    return true;
  });
  const reviewFlags = [];
  const missingInformation = [];

  if (/^yes$/i.test(submission.fundraising)) {
    reviewFlags.push("Fundraising disclosed for human review");
  }

  if (/^yes$/i.test(submission.linksIncluded)) {
    reviewFlags.push("Links included; verify destinations");
  }

  if (!local) {
    missingInformation.push("White Plains or neighborhood relevance");
  }

  if (!communityServing) {
    missingInformation.push("Community-serving purpose");
  }

  if (eventLike && !datePresent) {
    missingInformation.push("Specific date");
  }

  if (eventLike && !timePresent) {
    missingInformation.push("Specific time");
  }

  if (eventLike && !locationPresent) {
    missingInformation.push("Specific location");
  }

  if (/^yes$/i.test(submission.fundraising)) {
    missingInformation.push("Fundraising purpose and beneficiary");
  }

  if (wordCount(submission.message) < 12) {
    missingInformation.push("More description");
  }

  const checklist = {
    relevantToWhitePlainsResidents: checklistValue(local),
    communityServing: checklistValue(communityServing),
    civicEducationalPublicInterestPurpose: checklistValue(communityServing || local),
    notPrivateClassifiedListing: checklistValue(!outsideFlags.some((flag) => /sale|rental|listing|job/i.test(flag))),
    notCommercialAdvertising: checklistValue(!outsideFlags.some((flag) => /discount|business|real estate|job/i.test(flag))),
    notPersonalDisputeOrComplaint: checklistValue(!escalationFlags.some((flag) => /complaint|accusation|defamatory/i.test(flag))),
    notUrgentEmergencyMessaging: checklistValue(!escalationFlags.some((flag) => /emergency/i.test(flag))),
    includesDateIfTimeBased: eventLike ? checklistValue(datePresent) : "unclear",
    includesTimeIfTimeBased: eventLike ? checklistValue(timePresent) : "unclear",
    includesLocationIfLocationBased: eventLike ? checklistValue(locationPresent) : "unclear",
    includesOrganizerSource: checklistValue(Boolean(submission.organization || submission.name)),
    includesContactInformationForFollowUp: checklistValue(Boolean(submission.email))
  };

  let recommendation = RECOMMENDATIONS.ready;
  let reason = "Submission appears complete enough for WPCNA human review.";
  let suggestedFollowUp = "None.";
  let summary = cleanedDraftSummary(submission);

  if (escalationFlags.length) {
    recommendation = RECOMMENDATIONS.escalate;
    reason = "Submission includes sensitive or potentially high-risk material that should be reviewed carefully by a person.";
    suggestedFollowUp = "Please review the original submission before responding or taking any action.";
    summary = "";
  } else if (outsideFlags.length) {
    recommendation = RECOMMENDATIONS.outside;
    reason = "Submission includes signs of commercial, private-listing, unrelated, or otherwise outside-guideline content.";
    suggestedFollowUp = "Please confirm whether the item has a clear White Plains community-serving purpose.";
    summary = "";
  } else if (missingInformation.length) {
    recommendation = RECOMMENDATIONS.needs;
    reason = "Submission may be appropriate but is missing details needed for review.";
    suggestedFollowUp = `Could you provide: ${missingInformation.join(", ")}?`;
  }

  return {
    recommendation,
    reason,
    triggeredFlags: [...escalationFlags, ...outsideFlags, ...reviewFlags],
    missingInformation: [...new Set(missingInformation)],
    suggestedFollowUp,
    cleanedUpDraftSummary: summary,
    checklist
  };
}

function displayChecklistValue(value = "") {
  const normalized = String(value || "unclear").toLowerCase();

  if (normalized === "yes") return "Yes";
  if (normalized === "no") return "No";
  return "Unclear";
}

function formatList(items = []) {
  if (!items.length) {
    return "None noted.";
  }

  return items.map((item) => `- ${safeEmailText(item, 500)}`).join("\n");
}

function formatGuidelineChecklist(checklist = {}) {
  return Object.entries(CHECKLIST_LABELS)
    .map(([key, label]) => `${label}: ${displayChecklistValue(checklist[key])}`)
    .join("\n");
}

function formatField(label, value, maxLength = 500) {
  const text = Array.isArray(value)
    ? value.map((item) => safeEmailText(item, maxLength)).filter(Boolean).join(", ")
    : safeEmailText(value, maxLength);

  return `${label}: ${text || "Not provided"}`;
}

function formatCivicIntakeSummary(raw = {}) {
  return [
    formatField("Posting/Event Title", raw.subject, POSTING_MAX_LENGTHS.subject),
    formatField("Submission Category", raw.category, POSTING_MAX_LENGTHS.category),
    formatField("Posting Type", raw.postingType, POSTING_MAX_LENGTHS.postingType),
    formatField("Organization/Group", raw.organization, POSTING_MAX_LENGTHS.organization),
    formatField("Contact Name", raw.name, POSTING_MAX_LENGTHS.name),
    formatField("Contact Email", raw.email, POSTING_MAX_LENGTHS.email),
    formatField("Event Date", raw.eventDate, POSTING_MAX_LENGTHS.eventDate),
    formatField("Event Time", raw.eventTime, POSTING_MAX_LENGTHS.eventTime),
    formatField("Location", raw.location, POSTING_MAX_LENGTHS.location),
    formatField("Intended Audience", raw.audience, POSTING_MAX_LENGTHS.audience),
    formatField("White Plains Affiliation", raw.whitePlainsAffiliation, POSTING_MAX_LENGTHS.whitePlainsAffiliation),
    formatField("Fundraising", raw.fundraising, POSTING_MAX_LENGTHS.fundraising),
    formatField("Links Included", raw.linksIncluded, POSTING_MAX_LENGTHS.linksIncluded),
    formatField("Guidelines Confirmed", raw.guidelinesConfirmed, POSTING_MAX_LENGTHS.guidelinesConfirmed)
  ].join("\n");
}

function formatOriginalSubmission(raw = {}) {
  return [
    "Main Description:",
    safeEmailText(raw.message, POSTING_MAX_LENGTHS.message)
  ].join("\n");
}

const AI_RECOMMENDATION_LABELS = {
  READY_TO_POST: "READY TO POST",
  NEEDS_REVIEW: "NEEDS REVIEW",
  NOT_QUALIFIED: "NOT QUALIFIED"
};

const AI_CHECKLIST_LABELS = CHECKLIST_LABELS;

function aiRecommendationLabel(recommendation = "") {
  return AI_RECOMMENDATION_LABELS[recommendation] || "NEEDS REVIEW";
}

function formatAiReviewSection(aiReview) {
  if (!aiReview) {
    return [
      "AI VETTING (ANTHROPIC)",
      "AI vetting was unavailable for this submission; please review it manually."
    ];
  }

  const confidencePct = `${Math.round((Number(aiReview.confidence) || 0) * 100)}%`;
  const lines = [
    "AI VETTING (ANTHROPIC)",
    `Recommendation: ${aiRecommendationLabel(aiReview.recommendation)}`,
    `Escalate to a person: ${aiReview.escalate ? "YES" : "No"}`,
    `Confidence: ${confidencePct}`,
    `Reason: ${safeEmailText(aiReview.reason, 900) || "Not provided"}`,
    "Missing information:",
    formatList(aiReview.missingInformation),
    `Suggested follow-up: ${safeEmailText(aiReview.suggestedFollowUp, 600) || "None suggested."}`,
    "AI guideline checklist:",
    formatGuidelineChecklist(aiReview.checklist)
  ];

  if (aiReview.cleanedUpDraftSummary) {
    lines.push("AI cleaned-up draft summary:", safeEmailText(aiReview.cleanedUpDraftSummary, 600));
  }

  return lines;
}

function formatEmailBody({ review, aiReview, approveUrl, rawSubmission, timestamp, request }) {
  const sections = [
    ...formatAiReviewSection(aiReview),
    ...(approveUrl
      ? (aiReview && aiReview.recommendation === "NEEDS_REVIEW"
          ? ["", "PUBLISH AS-IS (one click) - review the missing items above first", approveUrl, "Clicking this publishes the posting to the site as-is. Address any gaps above first if needed."]
          : ["", "APPROVE & PUBLISH (one click)", approveUrl, "Clicking the link above publishes this posting to the site right away."])
      : []),
    "",
    "CIVIC INTAKE SUMMARY",
    formatCivicIntakeSummary(rawSubmission),
    "",
    "RULE-BASED REVIEW",
    `Recommendation: ${review.recommendation}`,
    `Reason: ${review.reason}`,
    "Triggered flags:",
    formatList(review.triggeredFlags),
    "Missing information:",
    formatList(review.missingInformation),
    `Suggested follow-up: ${review.suggestedFollowUp || "None suggested."}`,
    "",
    "GUIDELINE CHECKLIST",
    formatGuidelineChecklist(review.checklist)
  ];

  if (
    review.cleanedUpDraftSummary &&
    [RECOMMENDATIONS.ready, RECOMMENDATIONS.needs].includes(review.recommendation)
  ) {
    sections.push("", "CLEANED-UP DRAFT SUMMARY", safeEmailText(review.cleanedUpDraftSummary, 600));
  }

  sections.push(
    "",
    "ORIGINAL SUBMISSION",
    formatOriginalSubmission(rawSubmission),
    "",
    "TECHNICAL FOOTER",
    `Submission timestamp: ${timestamp}`,
    `Page/source: ${safeEmailText(rawSubmission.pageSource || request.headers.get("Referer") || "Unknown", 500)}`,
    "No secrets are included.",
    "No public posting was created automatically."
  );

  return sections.join("\n");
}

function emailSubject(subject = "", aiReview = null) {
  const cleanSubject = normalizeText(subject, 120) || "Untitled submission";
  let tag = "";
  if (aiReview) {
    tag = aiReview.escalate
      ? "[ESCALATE] "
      : `[${aiRecommendationLabel(aiReview.recommendation)}] `;
  }
  return `${tag}Community Posting Review: ${cleanSubject}`;
}

function parseEmailList(value = "") {
  return String(value || "")
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter((email) => email && isEmail(email));
}

function postingRecipients(env) {
  const recipients = [
    ...parseEmailList(env.POSTING_RECIPIENT_EMAILS),
    ...parseEmailList(env.POSTING_RECIPIENT_EMAIL)
  ];

  return [...new Set(recipients)];
}

function postingBcc(env) {
  return [...new Set(parseEmailList(env.POSTING_BCC_EMAILS))];
}

async function sendViaResend({ env, subject, body, replyTo }) {
  const from = env.POSTING_EMAIL_FROM || "WPCNA <onboarding@resend.dev>";
  const recipients = postingRecipients(env);
  const bcc = postingBcc(env);

  if (!env.RESEND_API_KEY || (!recipients.length && !bcc.length)) {
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from,
      to: recipients,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: body,
      reply_to: replyTo ? [replyTo] : undefined
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend email failed with ${response.status}: ${detail}`);
  }

  return true;
}

async function sendViaWebhook({ env, subject, body, replyTo }) {
  const webhookUrl = env.POSTING_EMAIL_WEBHOOK_URL;

  if (!webhookUrl) {
    return false;
  }

  const payload = new URLSearchParams();
  payload.set("_subject", subject);
  payload.set("_template", "table");
  payload.set("_captcha", "false");
  if (replyTo) {
    payload.set("_replyto", replyTo);
  }
  const cc = parseEmailList(env.POSTING_CC_EMAILS).join(",");
  if (cc) {
    payload.set("_cc", cc);
  }
  payload.set("Rule-based posting review", body);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email webhook failed with ${response.status}: ${detail}`);
  }

  return true;
}

async function sendPostingReviewEmail({ env, subject, body, replyTo }) {
  if (await sendViaResend({ env, subject, body, replyTo })) {
    return;
  }

  if (await sendViaWebhook({ env, subject, body, replyTo })) {
    return;
  }

  throw new Error("No posting email provider is configured.");
}

export async function handlePostingSubmission({ request, env, corsHeaders, jsonResponse, errorResponse }) {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, corsHeaders);
  }

  const ipAddress = getClientIp(request);

  if (isPostingRateLimited(ipAddress)) {
    return errorResponse("Too many submissions. Please try again in a few minutes.", 429, corsHeaders);
  }

  let parsed;

  try {
    parsed = await parseSubmissionRequest(request);
  } catch {
    return errorResponse("Invalid submission.", 400, corsHeaders);
  }

  const { raw, clean } = parsed;

  if (clean.website) {
    return jsonResponse({ ok: true, message: "Submission received for review." }, 200, corsHeaders);
  }

  const validationError = validateSubmission(clean);

  if (validationError) {
    return errorResponse(validationError, 422, corsHeaders);
  }

  const review = reviewPostingSubmission(clean);

  let aiReview = null;
  try {
    aiReview = await reviewPostingWithAnthropic({ env, submission: clean, ruleReview: review });
  } catch (error) {
    console.error("Anthropic posting vetting error:", error);
    aiReview = null;
  }

  let approveUrl = null;
  try {
    if (aiReview && !aiReview.escalate && ["READY_TO_POST", "NEEDS_REVIEW"].includes(aiReview.recommendation) && env.APPROVE_SIGNING_SECRET) {
      const posting = postingFromSubmission(clean, aiReview);
      const token = await signPosting(posting, env.APPROVE_SIGNING_SECRET);
      approveUrl = `${new URL(request.url).origin}/publish?token=${token}`;
    }
  } catch (error) {
    console.error("Approve-link build failed:", error);
  }

  const timestamp = new Date().toISOString();
  const subject = emailSubject(clean.subject, aiReview);
  const body = formatEmailBody({
    review,
    aiReview,
    approveUrl,
    rawSubmission: raw,
    timestamp,
    request
  });

  try {
    await sendPostingReviewEmail({
      env,
      subject,
      body,
      replyTo: clean.email
    });
  } catch (error) {
    console.error("Posting email error:", error);
    return errorResponse("The submission could not be emailed right now. Please try again later.", 502, corsHeaders);
  }

  return jsonResponse(
    {
      ok: true,
      message: "Submission received. WPCNA will review it before anything is posted."
    },
    200,
    corsHeaders
  );
}
