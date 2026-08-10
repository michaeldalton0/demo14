import assert from "node:assert/strict";
import test from "node:test";

import { handlePostingSubmission } from "../src/posting-review.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return Response.json(payload, { status, headers });
}

function errorResponse(error, status = 400, headers = {}) {
  return jsonResponse({ ok: false, error }, status, headers);
}

function validSubmission(overrides = {}) {
  return {
    name: "Pipeline Tester",
    email: "submitter@example.com",
    subject: "WPCNA moderation pipeline test",
    category: "Neighborhood",
    postingType: "Event",
    organization: "WPCNA",
    eventDate: "2026-09-20",
    eventTime: "10:00 AM",
    location: "White Plains Public Library",
    audience: ["White Plains residents"],
    whitePlainsAffiliation: "White Plains neighborhood association",
    fundraising: "no",
    linksIncluded: "no",
    guidelinesConfirmed: "yes",
    message: "This submission has enough detail for the WPCNA community moderation workflow.",
    ...overrides
  };
}

test("every review email includes approve and both decline choices", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resendPayload;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.anthropic.com/v1/messages") {
      return Response.json({
        content: [{
          type: "text",
          text: JSON.stringify({
            recommendation: "NOT_QUALIFIED",
            escalate: false,
            confidence: 0.98,
            reason: "This test result lets the human reviewer verify all choices.",
            missingInformation: [],
            suggestedFollowUp: "None.",
            cleanedUpDraftSummary: "",
            checklist: {}
          })
        }]
      });
    }
    if (String(url) === "https://api.resend.com/emails") {
      resendPayload = JSON.parse(options.body);
      return Response.json({ id: "review-email-test" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const request = new Request("https://worker.example/posting-review", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.45"
    },
    body: JSON.stringify(validSubmission())
  });
  const response = await handlePostingSubmission({
    request,
    env: {
      ANTHROPIC_API_KEY: "test-anthropic-key",
      APPROVE_SIGNING_SECRET: "test-signing-secret",
      RESEND_API_KEY: "test-resend-key",
      POSTING_EMAIL_FROM: "WPCNA <postings@wp-cna.org>",
      POSTING_RECIPIENT_EMAILS_DEFAULT:
        "wpcna.info@gmail.com,michael@mdalton.com,michael.kushman@gmail.com"
    },
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 200);
  assert.deepEqual(resendPayload.to, [
    "wpcna.info@gmail.com",
    "michael@mdalton.com",
    "michael.kushman@gmail.com"
  ]);
  assert.match(resendPayload.text, /1\) APPROVE & PUBLISH \(one click\)/);
  assert.match(resendPayload.text, /https:\/\/worker\.example\/publish\?token=/);
  assert.match(resendPayload.text, /2\) DECLINE - NO MESSAGE \(one click\)/);
  assert.match(resendPayload.text, /https:\/\/worker\.example\/decline\?token=/);
  assert.match(resendPayload.text, /3\) DECLINE & SEND EXPLANATION \(one click\)/);
  assert.match(resendPayload.text, /https:\/\/worker\.example\/notify-submitter\?token=/);
});

test("submission email is required so all three actions can work", async () => {
  const request = new Request("https://worker.example/posting-review", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.46"
    },
    body: JSON.stringify(validSubmission({ email: "" }))
  });
  const response = await handlePostingSubmission({
    request,
    env: {},
    corsHeaders: {},
    jsonResponse,
    errorResponse
  });

  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /Contact email/);
});
