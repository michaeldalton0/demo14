import assert from "node:assert/strict";
import test from "node:test";

import { sendPostingReviewEmail } from "../src/posting-review.js";

test("Resend failure falls through to FormSubmit with default recipients copied", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://api.resend.com/emails") {
      return new Response("temporary Resend failure", { status: 503 });
    }
    if (String(url) === "https://formsubmit.co/wpcna.info@gmail.com") {
      return new Response("ok", { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await sendPostingReviewEmail({
    env: {
      RESEND_API_KEY: "test-resend-key",
      POSTING_EMAIL_FROM: "WPCNA <postings@wp-cna.org>",
      POSTING_RECIPIENT_EMAILS_DEFAULT:
        "wpcna.info@gmail.com,michael@mdalton.com,michael.kushman@gmail.com",
      POSTING_CC_EMAILS: "extra-reviewer@example.com",
      POSTING_FORM_FALLBACK_URL: "https://formsubmit.co/wpcna.info@gmail.com"
    },
    subject: "Fallback test",
    body: "Review body",
    replyTo: "submitter@example.com"
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.resend.com/emails",
    "https://formsubmit.co/wpcna.info@gmail.com"
  ]);
  const fallbackBody = new URLSearchParams(calls[1].options.body);
  assert.equal(fallbackBody.get("_replyto"), "submitter@example.com");
  assert.deepEqual(fallbackBody.get("_cc").split(","), [
    "michael@mdalton.com",
    "michael.kushman@gmail.com",
    "extra-reviewer@example.com"
  ]);
});
