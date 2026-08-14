import assert from "node:assert/strict";
import test from "node:test";

import { handleContactSubmission } from "../src/contact.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return Response.json(payload, { status, headers });
}

function errorResponse(error, status = 400, headers = {}) {
  return jsonResponse({ ok: false, error }, status, headers);
}

function allowLimiter() {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: true };
    }
  };
}

function contactRequest(overrides = {}) {
  return new Request("https://worker.example/contact", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.90"
    },
    body: JSON.stringify({
      name: "Contact Tester",
      email: "resident@example.com",
      subject: "Question for Fisher Hill",
      message: "Please connect me with the neighborhood association.",
      associationSlug: "fisher-hill",
      pageSource: "https://wp-cna.org/neighborhoods/fisher-hill/",
      ...overrides
    })
  });
}

test("contact route validates, rate-limits, and delivers through Resend", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resendPayload;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    resendPayload = JSON.parse(options.body);
    return Response.json({ id: "contact-email" });
  };

  const ipLimiter = allowLimiter();
  const emailLimiter = allowLimiter();
  const response = await handleContactSubmission({
    request: contactRequest(),
    env: {
      IP_RATE_LIMITER: ipLimiter,
      EMAIL_RATE_LIMITER: emailLimiter,
      RESEND_API_KEY: "test-resend-key",
      POSTING_EMAIL_FROM: "WPCNA <contact@wp-cna.org>",
      POSTING_RECIPIENT_EMAILS_DEFAULT: "wpcna.info@gmail.com"
    },
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(resendPayload.to[0], "wpcna.info@gmail.com");
  assert.deepEqual(resendPayload.reply_to, ["resident@example.com"]);
  assert.match(resendPayload.subject, /\[fisher-hill\]/);
  assert.match(resendPayload.text, /Association: fisher-hill/);
  assert.equal(ipLimiter.keys.length, 1);
  assert.equal(emailLimiter.keys.length, 1);
  assert.match(emailLimiter.keys[0], /^forms:email:[a-f0-9]{64}$/);
});

test("contact honeypot returns neutral success without sending or consuming email quota", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("honeypot must not send email");
  };

  const ipLimiter = allowLimiter();
  const emailLimiter = allowLimiter();
  const response = await handleContactSubmission({
    request: contactRequest({ website: "https://spam.example" }),
    env: { IP_RATE_LIMITER: ipLimiter, EMAIL_RATE_LIMITER: emailLimiter },
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 200);
  assert.equal(emailLimiter.keys.length, 0);
  assert.equal(ipLimiter.keys.length, 1);
});

test("contact route rejects invalid association slugs", async () => {
  const response = await handleContactSubmission({
    request: contactRequest({ associationSlug: "../../other" }),
    env: { IP_RATE_LIMITER: allowLimiter(), EMAIL_RATE_LIMITER: allowLimiter() },
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /association selection is invalid/);
});

test("contact route fails closed when a required rate-limit binding is missing", async () => {
  const response = await handleContactSubmission({
    request: contactRequest(),
    env: {},
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /protection is temporarily unavailable/);
});
