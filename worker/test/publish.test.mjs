import assert from "node:assert/strict";
import test from "node:test";

import { handleDecline, handlePublish, signPosting } from "../src/publish.js";

const emptyPostings = Buffer.from(JSON.stringify({ postings: [] }), "utf8").toString("base64");

function testEnv() {
  return {
    APPROVE_SIGNING_SECRET: "unit-test-signing-secret",
    GITHUB_TOKEN: "unit-test-github-token",
    GITHUB_REPO: "wp-cna/demo14",
    GITHUB_BRANCH: "main",
    POSTINGS_PATH: "src/_data/communityPostings.json",
    SITE_BASE_URL: "https://wp-cna.org",
    RESEND_API_KEY: "unit-test-resend-token",
    POSTING_EMAIL_FROM: "WPCNA <posting@wp-cna.org>"
  };
}

function testPosting(slug = "pipeline-confirmation-test-2026-09-12") {
  return {
    slug,
    title: "Pipeline Confirmation Test",
    category: "Neighborhood Event",
    sourceLabel: "WPCNA",
    status: "upcoming",
    startDate: "2026-09-12",
    startTime: "10:00",
    endTime: "",
    displayTime: "10:00",
    locationName: "White Plains Public Library",
    locationAddress: "",
    shortSummary: "A test posting.",
    fullDescription: "A test posting for the approval confirmation pipeline."
  };
}

async function approvalRequest(env, posting, submitter) {
  const token = await signPosting({ kind: "publish", posting, submitter }, env.APPROVE_SIGNING_SECRET);
  return new Request(`https://worker.example/publish?token=${token}`);
}

test("emails the submitter only after GitHub accepts the posting", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body || "" };
    calls.push(call);

    if (call.url.includes("api.github.com") && call.method === "GET") {
      return Response.json({ content: emptyPostings, sha: "before" });
    }
    if (call.url.includes("api.github.com") && call.method === "PUT") {
      return Response.json({ commit: { sha: "after" } });
    }
    if (call.url === "https://api.resend.com/emails") {
      return Response.json({ id: "email-test" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = testEnv();
  const posting = testPosting();
  const request = await approvalRequest(env, posting, {
    email: "michael.kushman@gmail.com",
    name: "Michael"
  });
  const response = await handlePublish({ request, env });
  const html = await response.text();
  const writeIndex = calls.findIndex((call) => call.method === "PUT");
  const emailIndex = calls.findIndex((call) => call.url === "https://api.resend.com/emails");
  const email = JSON.parse(calls[emailIndex].body);

  assert.ok(writeIndex >= 0, "GitHub write should be attempted");
  assert.ok(emailIndex > writeIndex, "confirmation must follow the successful GitHub write");
  assert.equal(email.to[0], "michael.kushman@gmail.com");
  assert.match(email.text, /https:\/\/wp-cna\.org\/posting\/pipeline-confirmation-test-2026-09-12\//);
  assert.match(html, /confirmation with the live link was emailed/);
});

test("keeps the posting published when confirmation delivery fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = options.method || "GET";

    if (requestUrl.includes("api.github.com") && method === "GET") {
      return Response.json({ content: emptyPostings, sha: "before" });
    }
    if (requestUrl.includes("api.github.com") && method === "PUT") {
      return Response.json({ commit: { sha: "after" } });
    }
    if (requestUrl === "https://api.resend.com/emails") {
      return new Response("delivery failed", { status: 500 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = testEnv();
  const posting = testPosting("email-failure-test-2026-09-13");
  const request = await approvalRequest(env, posting, {
    email: "michael.kushman@gmail.com",
    name: "Michael"
  });
  const response = await handlePublish({ request, env });
  const html = await response.text();

  assert.match(html, /posting was published, but the submitter confirmation email failed/);
  assert.doesNotMatch(html, /Something went wrong committing the posting/);
});

test("declines without publishing or emailing the submitter", async () => {
  const env = testEnv();
  const token = await signPosting(
    { kind: "decline", subject: "Test posting" },
    env.APPROVE_SIGNING_SECRET
  );
  const response = await handleDecline({
    request: new Request(`https://worker.example/decline?token=${token}`),
    env
  });
  const html = await response.text();

  assert.match(html, /Submission declined/);
  assert.match(html, /No message was sent to the submitter/);
});
