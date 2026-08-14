// Confirmed moderation actions for community postings.
//
// The vetting email for a READY_TO_POST submission includes a signed link to
// this Worker's /publish route. Opening a link only renders a confirmation
// page. A trusted reviewer must submit that page before the Worker commits the
// posting into the site repo's
// communityPostings.json via the GitHub Contents API. That commit triggers the
// normal GitHub Pages rebuild, so the posting goes live within ~a minute.
//
// Required Worker config for publishing:
//   APPROVE_SIGNING_SECRET  - HMAC secret used to sign/verify approve links
//   GITHUB_TOKEN            - fine-grained token with Contents:write on the repo
//   GITHUB_REPO             - e.g. "wp-cna/demo13"
//   GITHUB_BRANCH           - default "main"
//   POSTINGS_PATH           - default "src/_data/communityPostings.json"
//   SITE_BASE_URL           - default "https://wp-cna.org"

const POSTINGS_PATH_DEFAULT = "src/_data/communityPostings.json";
const BRANCH_DEFAULT = "main";
const SITE_BASE_URL_DEFAULT = "https://wp-cna.org";

// ---- base64url + HMAC (Workers Web Crypto) -------------------------------
function bytesToB64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signPosting(posting, secret) {
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify(posting)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToB64url(sig)}`;
}

export async function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  const [payload, sig] = token.split(".");
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
  } catch {
    return null;
  }
}

// ---- submission -> posting object ----------------------------------------
function slugify(text = "") {
  return (
    String(text)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "posting"
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function firstSentence(text = "") {
  const s = String(text).replace(/\s+/g, " ").trim();
  const m = s.match(/^.*?[.!?](?:\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 200);
}

// Maps a cleaned submission (+ optional AI review) to a posting object that
// matches the communityPostings.json schema the site renders.
export function postingFromSubmission(submission = {}, aiReview = null) {
  const title = (submission.subject || submission.title || "Community posting").slice(0, 160);
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(submission.eventDate || "") ? submission.eventDate : todayISO();
  const eventTime = (submission.eventTime || "").slice(0, 60);
  const shortSummary =
    (aiReview && aiReview.cleanedUpDraftSummary) ||
    firstSentence(submission.message || submission.description || "") ||
    title;
  return {
    slug: `${slugify(title)}-${startDate}`,
    category: (submission.category || "Community").slice(0, 60),
    sourceLabel: (submission.organization || submission.organizationName || submission.name || submission.contactName || "Community submission").slice(0, 140),
    status: "upcoming",
    title,
    startDate,
    startTime: eventTime,
    endTime: "",
    displayTime: eventTime,
    locationName: (submission.location || "").slice(0, 180),
    locationAddress: "",
    shortSummary: shortSummary.slice(0, 280),
    fullDescription: (submission.message || submission.description || "").slice(0, 4000)
  };
}

// ---- GitHub commit --------------------------------------------------------
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "wpcna-posting-publisher",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

export async function publishPosting({ env, posting }) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    throw new Error("Publishing is not configured (GITHUB_TOKEN / GITHUB_REPO missing).");
  }
  const branch = env.GITHUB_BRANCH || BRANCH_DEFAULT;
  const path = env.POSTINGS_PATH || POSTINGS_PATH_DEFAULT;
  const apiBase = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;

  const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(env) });
  if (!getRes.ok) {
    throw new Error(`GitHub read failed ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`);
  }
  const meta = await getRes.json();
  let data;
  try {
    data = JSON.parse(b64ToUtf8(meta.content));
  } catch {
    throw new Error("Could not parse current communityPostings.json");
  }
  // Supports both the keyed-object shape { "postings": [...] } and a bare array.
  const postings = Array.isArray(data) ? data : (data && Array.isArray(data.postings) ? data.postings : null);
  if (!postings) throw new Error("communityPostings.json has an unexpected shape");

  if (postings.some((p) => p && p.slug === posting.slug)) {
    return { status: "duplicate", slug: posting.slug };
  }

  const nextPostings = [...postings, posting];
  const updated = Array.isArray(data) ? nextPostings : { ...data, postings: nextPostings };
  const newContent = JSON.stringify(updated, null, 2) + "\n";
  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Add community posting: ${posting.title} (approved via email)`,
      content: utf8ToB64(newContent),
      sha: meta.sha,
      branch
    })
  });
  if (!putRes.ok) {
    throw new Error(`GitHub write failed ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  }
  return { status: "published", slug: posting.slug };
}

// ---- /publish route -------------------------------------------------------
function htmlPage(title, body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5;color:#1a2433">` +
      body +
      `</body>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}

const MODERATION_ACTION_KINDS = new Set(["publish", "decline", "notify"]);
const READ_ACTION_CLAIM_SQL =
  "SELECT kind FROM moderation_actions WHERE action_id = ?1 LIMIT 1";
const CLAIM_ACTION_SQL =
  "INSERT INTO moderation_actions (action_id, kind, claimed_at, expires_at) " +
  "VALUES (?1, ?2, ?3, ?4) ON CONFLICT(action_id) DO NOTHING";

function validActionId(value = "") {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(String(value));
}

function normalizeLegacySubject(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function legacySubject(data) {
  if (data.kind === "publish") {
    return normalizeLegacySubject(data.posting && data.posting.title);
  }
  return normalizeLegacySubject(data.subject);
}

async function legacyActionId(subject) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `legacy-${hex}`;
}

function legacyTransitionPage(reason) {
  if (reason === "expired") {
    return htmlPage(
      "Legacy link expired",
      "<h1>This older moderation link has expired</h1><p>The temporary legacy-link transition window has ended. No action was taken; please handle the submission manually.</p>",
      410
    );
  }
  if (reason === "subject") {
    return htmlPage(
      "Invalid legacy link",
      "<h1>This older moderation link is incomplete</h1><p>It does not identify a submission subject, so it cannot be protected against conflicting choices. No action was taken.</p>",
      400
    );
  }
  return htmlPage(
    "Legacy moderation unavailable",
    "<h1>Older moderation links are unavailable</h1><p>The temporary legacy-link transition is not configured correctly. No action was taken; please contact the site administrator.</p>",
    503
  );
}

async function tokenFromRequest(request) {
  const urlToken = new URL(request.url).searchParams.get("token");
  if (urlToken) return urlToken;
  if (request.method !== "POST") return "";
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) {
    return "";
  }
  try {
    return String((await request.formData()).get("token") || "");
  } catch {
    return "";
  }
}

async function readActionClaim(env, actionId) {
  if (!env.MODERATION_DB || typeof env.MODERATION_DB.prepare !== "function") {
    return { ok: false, reason: "missing" };
  }
  try {
    return {
      ok: true,
      claim: await env.MODERATION_DB.prepare(READ_ACTION_CLAIM_SQL).bind(actionId).first()
    };
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not read moderation action claim",
      actionId,
      error: String(error && error.message ? error.message : error)
    }));
    return { ok: false, reason: "unavailable" };
  }
}

function moderationStoragePage(reason) {
  const detail = reason === "missing"
    ? "The moderation database binding is missing on the server."
    : "The moderation database could not be reached.";
  return htmlPage(
    "Moderation unavailable",
    `<h1>Moderation is temporarily unavailable</h1><p>${detail} No action was taken. Please contact the site administrator rather than trying another choice.</p>`,
    503
  );
}

function usedActionPage(claim) {
  const kind = claim && MODERATION_ACTION_KINDS.has(claim.kind) ? claim.kind : "another";
  return htmlPage(
    "Submission already claimed",
    `<h1>This submission was already claimed or handled</h1><p>The ${escapeHtml(kind)} choice was already confirmed, so no additional action was taken. Check the site or the submitter inbox before escalating.</p>`,
    409
  );
}

async function prepareActionRequest({ request, env, expectedKind }) {
  const secret = env.APPROVE_SIGNING_SECRET;
  if (!secret) {
    return {
      response: htmlPage("Not configured", "<h1>Moderation isn't configured</h1><p>The action signing secret is missing on the server. No action was taken.</p>", 503)
    };
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return {
      response: htmlPage("Method not allowed", "<h1>Method not allowed</h1><p>Open the signed review link, then use its confirmation button.</p>", 405)
    };
  }
  const token = await tokenFromRequest(request);
  let data = await verifyToken(token, secret);
  if (!data || data.kind !== expectedKind) {
    return {
      response: htmlPage("Invalid link", "<h1>This moderation link is invalid</h1><p>Please re-open the original review email.</p>", 400)
    };
  }

  const hasActionId = Object.prototype.hasOwnProperty.call(data, "actionId");
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(data, "expiresAt");
  if (!hasActionId && !hasExpiresAt) {
    const configuredCutoff = String(env.LEGACY_ACTIONS_UNTIL || "").trim();
    const cutoff = Date.parse(configuredCutoff);
    if (!configuredCutoff || !Number.isFinite(cutoff)) {
      return { response: legacyTransitionPage("configuration") };
    }
    if (cutoff <= Date.now()) {
      return { response: legacyTransitionPage("expired") };
    }
    const subject = legacySubject(data);
    if (!subject) {
      return { response: legacyTransitionPage("subject") };
    }
    data = {
      ...data,
      actionId: await legacyActionId(subject),
      expiresAt: cutoff
    };
  } else if (
    !hasActionId ||
    !hasExpiresAt ||
    !validActionId(data.actionId) ||
    !Number.isFinite(Number(data.expiresAt))
  ) {
    return {
      response: htmlPage("Invalid link", "<h1>This moderation link is invalid</h1><p>Please re-open the original review email.</p>", 400)
    };
  }

  if (Number(data.expiresAt) <= Date.now()) {
    return {
      response: htmlPage("Expired link", "<h1>This moderation link has expired</h1><p>Review links expire after 14 days. Please handle the submission manually.</p>", 410)
    };
  }
  if (request.method === "GET") {
    const claimResult = await readActionClaim(env, data.actionId);
    if (!claimResult.ok) {
      return { response: moderationStoragePage(claimResult.reason) };
    }
    if (claimResult.claim) {
      return { response: usedActionPage(claimResult.claim) };
    }
  }
  return { token, data };
}

function confirmationPage({ title, heading, detail, buttonLabel, path, token }) {
  return htmlPage(
    title,
    `<h1>${escapeHtml(heading)}</h1>` +
      `<p>${escapeHtml(detail)}</p>` +
      `<p><strong>Opening this page has not changed anything.</strong></p>` +
      `<form method="post" action="${escapeHtml(path)}">` +
        `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
        `<button type="submit" style="font:inherit;font-weight:700;padding:.75rem 1rem;cursor:pointer">${escapeHtml(buttonLabel)}</button>` +
      `</form>`
  );
}

async function claimAction(env, data) {
  if (!env.MODERATION_DB || typeof env.MODERATION_DB.prepare !== "function") {
    return { ok: false, response: moderationStoragePage("missing") };
  }

  try {
    const result = await env.MODERATION_DB
      .prepare(CLAIM_ACTION_SQL)
      .bind(data.actionId, data.kind, Date.now(), Number(data.expiresAt))
      .run();
    const changes = Number(result && result.meta && result.meta.changes);
    if (changes === 1) {
      return { ok: true };
    }
    if (changes !== 0) {
      throw new Error(`Moderation claim returned unexpected change count: ${changes}`);
    }

    const existing = await readActionClaim(env, data.actionId);
    if (!existing.ok) {
      return { ok: false, response: moderationStoragePage(existing.reason) };
    }
    if (!existing.claim) {
      throw new Error("Moderation claim conflicted but the existing row could not be read.");
    }
    return { ok: false, response: usedActionPage(existing.claim) };
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not atomically claim moderation action",
      actionId: data.actionId,
      error: String(error && error.message ? error.message : error)
    }));
    return { ok: false, response: moderationStoragePage("unavailable") };
  }
}

function isEmailAddress(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function postingUrl(env, posting) {
  const baseUrl = String(env.SITE_BASE_URL || SITE_BASE_URL_DEFAULT).replace(/\/+$/, "");
  return `${baseUrl}/posting/${encodeURIComponent(posting.slug)}/`;
}

function publishedConfirmation({ submitter, posting, url }) {
  const greeting = submitter.name ? `Hi ${submitter.name},` : "Hello,";
  return [
    greeting,
    "",
    "Your WPCNA community posting has been accepted and published:",
    "",
    posting.title,
    "",
    "View it here:",
    url,
    "",
    "The page may take a minute or two to finish appearing everywhere after approval.",
    "",
    "Thank you for sharing useful community information with White Plains residents.",
    "",
    "— WPCNA"
  ].join("\n");
}

export async function handlePublish({ request, env }) {
  const prepared = await prepareActionRequest({ request, env, expectedKind: "publish" });
  if (prepared.response) return prepared.response;
  const { token, data: signedData } = prepared;
  const posting = signedData.posting;
  const submitter = signedData.submitter || null;
  if (!posting || !posting.slug || !posting.title) {
    return htmlPage("Invalid link", "<h1>This approval link is invalid</h1><p>Please re-open the original submission email, or publish the posting manually.</p>", 400);
  }

  if (request.method === "GET") {
    return confirmationPage({
      title: "Confirm publication",
      heading: "Confirm approve and publish",
      detail: `Publish “${posting.title}” to the WPCNA site? A confirmation email will be attempted after publication.`,
      buttonLabel: "Confirm approve and publish",
      path: "/publish",
      token
    });
  }

  const claim = await claimAction(env, signedData);
  if (!claim.ok) return claim.response;

  try {
    const result = await publishPosting({ env, posting });
    if (result.status === "duplicate") {
      return htmlPage(
        "Already published",
        `<h1>Already published</h1><p>“${escapeHtml(posting.title)}” is already on the site, so nothing was changed.</p>`
      );
    }

    const url = postingUrl(env, posting);
    let confirmationStatus = "";
    if (submitter && isEmailAddress(submitter.email)) {
      try {
        await sendSubmitterEmail({
          env,
          to: submitter.email,
          subject: `Your WPCNA community posting is published: ${posting.title}`,
          body: publishedConfirmation({ submitter, posting, url })
        });
        confirmationStatus = `<p>A confirmation with the live link was emailed to ${escapeHtml(submitter.email)}.</p>`;
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "Published posting confirmation email failed",
            postingSlug: posting.slug,
            error: String(error && error.message ? error.message : error)
          })
        );
        confirmationStatus =
          `<p><strong>The posting was published, but the submitter confirmation email failed.</strong></p>` +
          `<pre style="white-space:pre-wrap;color:#a33">${escapeHtml(String(error && error.message ? error.message : error))}</pre>`;
      }
    } else {
      confirmationStatus = "<p>No submitter confirmation was sent because no email address was provided.</p>";
    }

    return htmlPage(
      "Published",
      `<h1>✅ Published</h1>` +
        `<p>“${escapeHtml(posting.title)}” has been added and will appear on the site within a minute or two as the site rebuilds.</p>` +
        `<p><a href="${escapeHtml(url)}">View the posting</a></p>` +
        confirmationStatus
    );
  } catch (error) {
    return htmlPage(
      "Publish failed",
      `<h1>Couldn't publish</h1><p>Something went wrong committing the posting. This submission remains claimed to prevent conflicting moderation choices. Do not retry the link; verify whether any partial publication occurred and handle the submission manually.</p><pre style="white-space:pre-wrap;color:#a33">${escapeHtml(String(error.message || error))}</pre>`,
      502
    );
  }
}

export async function handleDecline({ request, env }) {
  const prepared = await prepareActionRequest({ request, env, expectedKind: "decline" });
  if (prepared.response) return prepared.response;
  const { token, data } = prepared;

  if (request.method === "GET") {
    return confirmationPage({
      title: "Confirm decline",
      heading: "Confirm decline without a message",
      detail: `${data.subject ? `Decline “${data.subject}”` : "Decline this submission"} without publishing it or emailing the submitter?`,
      buttonLabel: "Confirm decline without a message",
      path: "/decline",
      token
    });
  }

  const claim = await claimAction(env, data);
  if (!claim.ok) return claim.response;
  return htmlPage(
    "Submission declined",
    `<h1>Submission declined</h1><p>${data.subject ? `“${escapeHtml(data.subject)}” was` : "The submission was"} not published. No message was sent to the submitter.</p>`
  );
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- submitter notification -----------------------------------------------
// Sends a single transactional email after a trusted reviewer either publishes
// a posting or chooses to explain why a rejected item was not posted.
async function sendSubmitterEmail({ env, to, subject, body }) {
  if (!env.RESEND_API_KEY) {
    throw new Error("Email is not configured (RESEND_API_KEY missing).");
  }
  const from = env.POSTING_EMAIL_FROM || "WPCNA <onboarding@resend.dev>";
  const replyTo = env.POSTING_REPLY_TO || undefined;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
      reply_to: replyTo ? [replyTo] : undefined
    })
  });
  if (!response.ok) {
    throw new Error(`Resend email failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return true;
}

export async function handleNotifySubmitter({ request, env }) {
  const prepared = await prepareActionRequest({ request, env, expectedKind: "notify" });
  if (prepared.response) return prepared.response;
  const { token, data } = prepared;
  if (!data.to || !data.message || !isEmailAddress(data.to)) {
    return htmlPage("Invalid link", "<h1>This notification link is invalid</h1><p>Please re-open the original review email.</p>", 400);
  }

  if (request.method === "GET") {
    return confirmationPage({
      title: "Confirm decline and notify",
      heading: "Confirm decline and send explanation",
      detail: `Decline ${data.subject ? `“${data.subject}”` : "this submission"} and email the prepared explanation to ${data.to}?`,
      buttonLabel: "Confirm decline and send explanation",
      path: "/notify-submitter",
      token
    });
  }

  const claim = await claimAction(env, data);
  if (!claim.ok) return claim.response;

  try {
    await sendSubmitterEmail({
      env,
      to: data.to,
      subject: `About your WPCNA community posting submission${data.subject ? `: ${data.subject}` : ""}`,
      body: data.message
    });
    return htmlPage(
      "Explanation sent",
      `<h1>✅ Explanation sent</h1><p>A note explaining the decision was emailed to ${escapeHtml(data.to)}.</p>`
    );
  } catch (error) {
    return htmlPage(
      "Send failed",
      `<h1>Couldn't send the explanation</h1><p>The email didn't go out. This submission remains claimed to prevent conflicting moderation choices. Do not retry the link; contact the submitter manually and record the decision.</p><pre style="white-space:pre-wrap;color:#a33">${escapeHtml(String(error.message || error))}</pre>`,
      502
    );
  }
}
