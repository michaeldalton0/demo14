// One-click "Approve & Publish" for community postings.
//
// The vetting email for a READY_TO_POST submission includes a signed link to
// this Worker's /publish route. When a trusted reviewer clicks it, the Worker
// verifies the HMAC signature (so nobody can forge a link for arbitrary
// content), then commits the posting into the site repo's
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
function htmlPage(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5;color:#1a2433">` +
      body +
      `</body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
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
  const secret = env.APPROVE_SIGNING_SECRET;
  if (!secret) {
    return htmlPage("Not configured", "<h1>Publishing isn't configured</h1><p>The approval signing secret is missing on the server.</p>");
  }
  const token = new URL(request.url).searchParams.get("token");
  const signedData = await verifyToken(token, secret);
  const posting = signedData && signedData.kind === "publish" ? signedData.posting : signedData;
  const submitter = signedData && signedData.kind === "publish" ? signedData.submitter : null;
  if (!posting || !posting.slug || !posting.title) {
    return htmlPage("Invalid link", "<h1>This approval link is invalid or expired</h1><p>Please re-open the original submission email, or publish the posting manually.</p>");
  }

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
      `<h1>Couldn't publish</h1><p>Something went wrong committing the posting. You can try the link again or publish manually.</p><pre style="white-space:pre-wrap;color:#a33">${escapeHtml(String(error.message || error))}</pre>`
    );
  }
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
  const secret = env.APPROVE_SIGNING_SECRET;
  if (!secret) {
    return htmlPage("Not configured", "<h1>Not configured</h1><p>The signing secret is missing on the server.</p>");
  }
  const token = new URL(request.url).searchParams.get("token");
  const data = await verifyToken(token, secret);
  if (!data || data.kind !== "notify" || !data.to || !data.message) {
    return htmlPage("Invalid link", "<h1>This link is invalid or expired</h1><p>Please re-open the original review email.</p>");
  }
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
      `<h1>Couldn't send the explanation</h1><p>The email didn't go out. The most common cause is that the Resend sending domain isn't verified yet, so mail can only reach your own Resend address.</p><pre style="white-space:pre-wrap;color:#a33">${escapeHtml(String(error.message || error))}</pre>`
    );
  }
}
