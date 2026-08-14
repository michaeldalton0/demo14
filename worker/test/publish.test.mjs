import assert from "node:assert/strict";
import test from "node:test";

import { handleDecline, handleNotifySubmitter, handlePublish, signPosting } from "../src/publish.js";

const emptyPostings = Buffer.from(JSON.stringify({ postings: [] }), "utf8").toString("base64");

function memoryD1({ failReads = false, failWrites = false } = {}) {
  const rows = new Map();
  const operations = [];
  const inserts = [];
  return {
    rows,
    operations,
    inserts,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              if (!sql.includes("INSERT INTO moderation_actions")) {
                throw new Error(`Unexpected D1 run statement: ${sql}`);
              }
              operations.push({ type: "insert", bindings });
              await Promise.resolve();
              if (failWrites) throw new Error("simulated D1 write failure");
              const [actionId, kind, claimedAt, expiresAt] = bindings;
              if (rows.has(actionId)) {
                return { success: true, meta: { changes: 0 }, results: [] };
              }
              const row = {
                action_id: actionId,
                kind,
                claimed_at: claimedAt,
                expires_at: expiresAt
              };
              rows.set(actionId, row);
              inserts.push(row);
              return { success: true, meta: { changes: 1 }, results: [] };
            },
            async first() {
              if (!sql.includes("SELECT kind FROM moderation_actions")) {
                throw new Error(`Unexpected D1 first statement: ${sql}`);
              }
              operations.push({ type: "select", bindings });
              if (failReads) throw new Error("simulated D1 read failure");
              const row = rows.get(bindings[0]);
              return row ? { kind: row.kind } : null;
            }
          };
        }
      };
    }
  };
}

function testEnv(overrides = {}) {
  return {
    APPROVE_SIGNING_SECRET: "unit-test-signing-secret",
    GITHUB_TOKEN: "unit-test-github-token",
    GITHUB_REPO: "wp-cna/demo14",
    GITHUB_BRANCH: "main",
    POSTINGS_PATH: "src/_data/communityPostings.json",
    SITE_BASE_URL: "https://wp-cna.org",
    RESEND_API_KEY: "unit-test-resend-token",
    POSTING_EMAIL_FROM: "WPCNA <posting@wp-cna.org>",
    LEGACY_ACTIONS_UNTIL: "2099-08-29T04:00:00Z",
    MODERATION_DB: memoryD1(),
    ...overrides
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

function actionMeta(actionId = crypto.randomUUID(), expiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000) {
  return { actionId, issuedAt: Date.now(), expiresAt };
}

async function actionToken(env, payload) {
  return signPosting(payload, env.APPROVE_SIGNING_SECRET);
}

function getRequest(path, token) {
  return new Request(`https://worker.example${path}?token=${token}`);
}

function postRequest(path, token) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token })
  });
}

test("GET publish renders confirmation without executing any side effect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("GET confirmation must not fetch");
  };

  const env = testEnv();
  const token = await actionToken(env, {
    ...actionMeta("confirm-only-action"),
    kind: "publish",
    posting: testPosting(),
    submitter: { email: "submitter@example.com", name: "Pat" }
  });
  const response = await handlePublish({ request: getRequest("/publish", token), env });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Opening this page has not changed anything/);
  assert.match(html, /method="post"/);
  assert.equal(fetchCount, 0);
  assert.equal(env.MODERATION_DB.rows.size, 0);
  assert.deepEqual(env.MODERATION_DB.operations.map((operation) => operation.type), ["select"]);
});

test("POST publishes first, then emails the submitter, using one atomic database claim", async (t) => {
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
  const token = await actionToken(env, {
    ...actionMeta("publish-completion-action"),
    kind: "publish",
    posting: testPosting(),
    submitter: { email: "submitter@example.com", name: "Pat" }
  });
  const response = await handlePublish({ request: postRequest("/publish", token), env });
  const html = await response.text();
  const writeIndex = calls.findIndex((call) => call.method === "PUT");
  const emailIndex = calls.findIndex((call) => call.url === "https://api.resend.com/emails");
  const email = JSON.parse(calls[emailIndex].body);
  const claim = env.MODERATION_DB.rows.get("publish-completion-action");

  assert.ok(writeIndex >= 0, "GitHub write should be attempted");
  assert.ok(emailIndex > writeIndex, "confirmation must follow the successful GitHub write");
  assert.equal(email.to[0], "submitter@example.com");
  assert.match(email.text, /https:\/\/wp-cna\.org\/posting\/pipeline-confirmation-test-2026-09-12\//);
  assert.match(html, /confirmation with the live link was emailed/);
  assert.equal(claim.kind, "publish");
  assert.equal(env.MODERATION_DB.inserts.length, 1);
  assert.deepEqual(env.MODERATION_DB.operations.map((operation) => operation.type), ["insert"]);
});

test("a failed publish remains atomically claimed and fails closed", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let githubPutAttempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = options.method || "GET";
    if (requestUrl.includes("api.github.com") && method === "GET") {
      return Response.json({ content: emptyPostings, sha: "before" });
    }
    if (requestUrl.includes("api.github.com") && method === "PUT") {
      githubPutAttempts += 1;
      return new Response("temporary failure", { status: 503 });
    }
    if (requestUrl === "https://api.resend.com/emails") {
      return Response.json({ id: "retry-email" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = testEnv();
  const token = await actionToken(env, {
    ...actionMeta("retryable-publish-action"),
    kind: "publish",
    posting: testPosting("retryable-posting-2026-09-14"),
    submitter: null
  });

  const failed = await handlePublish({ request: postRequest("/publish", token), env });
  const failedHtml = await failed.text();
  assert.equal(failed.status, 502);
  assert.match(failedHtml, /remains claimed/);
  assert.match(failedHtml, /handle the submission manually/);
  assert.equal(env.MODERATION_DB.rows.has("retryable-publish-action"), true);
  assert.equal(env.MODERATION_DB.inserts.length, 1);

  const retried = await handlePublish({ request: postRequest("/publish", token), env });
  assert.equal(retried.status, 409);
  assert.match(await retried.text(), /already claimed or handled/);
  assert.equal(env.MODERATION_DB.inserts.length, 1);
  assert.equal(githubPutAttempts, 1);
});

test("one confirmed choice blocks every other token sharing its actionId", async () => {
  const env = testEnv();
  const shared = actionMeta("shared-choice-action");
  const declineToken = await actionToken(env, {
    ...shared,
    kind: "decline",
    subject: "Shared choice"
  });
  const notifyToken = await actionToken(env, {
    ...shared,
    kind: "notify",
    to: "submitter@example.com",
    subject: "Shared choice",
    message: "This is the prepared explanation."
  });

  const declined = await handleDecline({ request: postRequest("/decline", declineToken), env });
  assert.equal(declined.status, 200);
  assert.match(await declined.text(), /Submission declined/);

  const blocked = await handleNotifySubmitter({
    request: postRequest("/notify-submitter", notifyToken),
    env
  });
  const blockedHtml = await blocked.text();
  assert.equal(blocked.status, 409);
  assert.match(blockedHtml, /already claimed or handled/);
  assert.match(blockedHtml, /The decline choice was already confirmed/);
});

test("concurrent sibling actions atomically allow exactly one side effect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let githubWrites = 0;
  let explanationEmails = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = options.method || "GET";
    if (requestUrl.includes("api.github.com") && method === "GET") {
      return Response.json({ content: emptyPostings, sha: "before" });
    }
    if (requestUrl.includes("api.github.com") && method === "PUT") {
      githubWrites += 1;
      return Response.json({ commit: { sha: "after" } });
    }
    if (requestUrl === "https://api.resend.com/emails") {
      explanationEmails += 1;
      return Response.json({ id: "concurrency-email" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = testEnv();
  const shared = actionMeta("concurrent-shared-action");
  const publishToken = await actionToken(env, {
    ...shared,
    kind: "publish",
    posting: testPosting("concurrent-action-2026-09-16"),
    submitter: null
  });
  const notifyToken = await actionToken(env, {
    ...shared,
    kind: "notify",
    to: "submitter@example.com",
    subject: "Concurrent shared action",
    message: "This is the prepared explanation."
  });

  const responses = await Promise.all([
    handlePublish({ request: postRequest("/publish", publishToken), env }),
    handleNotifySubmitter({ request: postRequest("/notify-submitter", notifyToken), env })
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(githubWrites + explanationEmails, 1);
  assert.equal(env.MODERATION_DB.inserts.length, 1);
  assert.equal(env.MODERATION_DB.rows.size, 1);
  assert.deepEqual(
    env.MODERATION_DB.operations.slice(0, 2).map((operation) => operation.type),
    ["insert", "insert"]
  );
});

test("legacy GET confirms, POST executes, and a normalized sibling subject is blocked", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let githubPutAttempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = options.method || "GET";
    if (requestUrl.includes("api.github.com") && method === "GET") {
      return Response.json({ content: emptyPostings, sha: "before" });
    }
    if (requestUrl.includes("api.github.com") && method === "PUT") {
      githubPutAttempts += 1;
      return Response.json({ commit: { sha: "after" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = testEnv();
  const publishToken = await actionToken(env, {
    kind: "publish",
    posting: testPosting("legacy-transition-event-2026-09-15"),
    submitter: null
  });
  const declineToken = await actionToken(env, {
    kind: "decline",
    subject: "  PIPELINE   confirmation test  "
  });

  const confirmation = await handlePublish({ request: getRequest("/publish", publishToken), env });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Opening this page has not changed anything/);
  assert.equal(env.MODERATION_DB.rows.size, 0);

  const published = await handlePublish({ request: postRequest("/publish", publishToken), env });
  assert.equal(published.status, 200);
  assert.match(await published.text(), /Published/);
  assert.equal(githubPutAttempts, 1);
  assert.equal(env.MODERATION_DB.inserts.length, 1);

  const sibling = await handleDecline({ request: postRequest("/decline", declineToken), env });
  assert.equal(sibling.status, 409);
  assert.match(await sibling.text(), /already claimed or handled/);
  assert.equal(env.MODERATION_DB.inserts.length, 1);
});

test("legacy links reject an elapsed or missing transition cutoff", async () => {
  const signedWith = testEnv();
  const token = await actionToken(signedWith, {
    kind: "decline",
    subject: "Legacy cutoff test"
  });

  const elapsedEnv = testEnv({ LEGACY_ACTIONS_UNTIL: "2000-01-01T00:00:00Z" });
  const elapsed = await handleDecline({ request: postRequest("/decline", token), env: elapsedEnv });
  assert.equal(elapsed.status, 410);
  assert.match(await elapsed.text(), /transition window has ended/);
  assert.equal(elapsedEnv.MODERATION_DB.rows.size, 0);

  const missingEnv = testEnv({ LEGACY_ACTIONS_UNTIL: undefined });
  const missing = await handleDecline({ request: postRequest("/decline", token), env: missingEnv });
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /transition is not configured correctly/);
  assert.equal(missingEnv.MODERATION_DB.rows.size, 0);
});

test("new-format links keep their own expiry when the legacy transition is unavailable", async () => {
  const env = testEnv({ LEGACY_ACTIONS_UNTIL: undefined });
  const token = await actionToken(env, {
    ...actionMeta("new-format-without-legacy-config"),
    kind: "decline",
    subject: "New format cutoff independence"
  });

  const response = await handleDecline({ request: postRequest("/decline", token), env });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Submission declined/);
  assert.equal(env.MODERATION_DB.inserts.length, 1);
});

test("legacy links without a subject are rejected", async () => {
  const env = testEnv();
  const token = await actionToken(env, {
    kind: "notify",
    to: "submitter@example.com",
    message: "Prepared explanation"
  });

  const response = await handleNotifySubmitter({
    request: postRequest("/notify-submitter", token),
    env
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /does not identify a submission subject/);
  assert.equal(env.MODERATION_DB.rows.size, 0);
});

test("expired moderation links do not claim state or execute", async () => {
  const env = testEnv();
  const token = await actionToken(env, {
    ...actionMeta("expired-action", Date.now() - 1),
    kind: "decline",
    subject: "Expired"
  });
  const response = await handleDecline({ request: postRequest("/decline", token), env });

  assert.equal(response.status, 410);
  assert.match(await response.text(), /expired/);
  assert.equal(env.MODERATION_DB.rows.size, 0);
});

test("missing moderation database binding fails closed with a useful page", async () => {
  const env = testEnv({ MODERATION_DB: undefined });
  const token = await actionToken(env, {
    ...actionMeta("missing-db-action"),
    kind: "decline",
    subject: "Missing database"
  });
  const response = await handleDecline({ request: postRequest("/decline", token), env });

  assert.equal(response.status, 503);
  assert.match(await response.text(), /database binding is missing/);
});

test("moderation database failure blocks the action before any side effect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("side effects must not run when D1 fails");
  };

  const env = testEnv({ MODERATION_DB: memoryD1({ failWrites: true }) });
  const token = await actionToken(env, {
    ...actionMeta("failed-db-action"),
    kind: "publish",
    posting: testPosting("failed-db-action-2026-09-17"),
    submitter: null
  });
  const response = await handlePublish({ request: postRequest("/publish", token), env });

  assert.equal(response.status, 503);
  assert.match(await response.text(), /database could not be reached/);
  assert.equal(fetchCount, 0);
});

test("keeps the posting published when submitter confirmation delivery fails", async (t) => {
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
  const token = await actionToken(env, {
    ...actionMeta("confirmation-failure-action"),
    kind: "publish",
    posting: testPosting("email-failure-test-2026-09-13"),
    submitter: { email: "submitter@example.com", name: "Pat" }
  });
  const response = await handlePublish({ request: postRequest("/publish", token), env });
  const html = await response.text();

  assert.match(html, /posting was published, but the submitter confirmation email failed/);
  assert.doesNotMatch(html, /Something went wrong committing the posting/);
});
