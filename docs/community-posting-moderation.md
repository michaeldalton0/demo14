# Community Posting Review Endpoint

The Community Posting form sends structured intake data to a private Cloudflare
Worker. The Worker runs deterministic guideline checks, then asks Anthropic to
vet the submission against the WPCNA posting guidelines, sends a private audit
email to WPCNA, and returns a neutral confirmation to the browser.

This is advisory review only. It does not auto-publish, auto-approve,
auto-reject, or create public posting pages. A WPCNA person makes the final
call from the audit email.

## Runtime

The Worker entrypoint is `worker/src/posting-worker.js`, with rule-based review
in `worker/src/posting-review.js` and the AI vetting in `worker/src/anthropic.js`.

Supported routes:

- `/`
- `/posting-review`
- `/api/posting-review`
- `/contact`
- `/api/contact`
- `/publish`, `/decline`, and `/notify-submitter` (signed moderation links;
  `GET` shows a confirmation page and only `POST` executes the action)

The static site receives the deployed Worker URL through the `POSTING_API_URL`
build variable.

## Private Worker Configuration

Set secrets with `wrangler secret put`; do not commit real values.

AI vetting (required for the AI recommendation):

- `ANTHROPIC_API_KEY` — the WPCNA owner's Anthropic key. Never appears in public
  HTML or frontend JavaScript.

Email delivery — preferred path:

- `RESEND_API_KEY`
- `POSTING_EMAIL_FROM`
- `POSTING_RECIPIENT_EMAILS`

Email delivery — fallback webhook path:

- `POSTING_FORM_FALLBACK_URL` — currently the confirmed FormSubmit endpoint in
  `wrangler.toml`; Resend failures fall through to it.
- `POSTING_CC_EMAILS`

Moderation and abuse-control bindings:

- `MODERATION_DB` — D1 database used to atomically claim a submission once
  across publish, decline, and decline-with-explanation choices.
- `EMAIL_RATE_LIMITER` — 5 form submissions per email address per minute.
- `IP_RATE_LIMITER` — 20 form submissions per IP address per minute.

Worker vars:

- `ALLOWED_ORIGINS=https://wp-cna.github.io`
- `LEGACY_ACTIONS_UNTIL=2026-08-29T04:00:00Z` — temporary cutoff for signed
  review links generated before action IDs and expirations were added.
- `POSTING_REVIEW_MODEL` (optional) — defaults to `claude-sonnet-4-6`.
  Set to `claude-haiku-4-5-20251001` to cut cost if volume ever grows.

No recipient email addresses, API keys, or webhook URLs should appear in public
HTML or frontend JavaScript.

## Flow

1. The resident submits the Community Posting intake form.
2. The frontend sends structured JSON to `POSTING_API_URL`.
3. The Worker validates required fields, email format, field lengths, honeypot
   state, and rate limits.
4. The Worker runs deterministic rule-based pre-checks (local relevance,
   community-serving signals, missing event details, spam/outside/escalation
   patterns).
5. The Worker calls Anthropic to vet the submission against the WPCNA
   guidelines and return a structured recommendation. The deterministic signals
   are passed to the model as advisory context.
6. The Worker emails a scannable audit report: the AI recommendation and reason
   first, then the original submission, deterministic checks, missing
   information, guideline checklist, and a cleaned-up draft summary when
   appropriate. All three signed action links share one action ID and expire
   after 14 days. Opening a link only shows a confirmation page; confirming the
   page sends a POST that claims the shared action ID before doing anything.
7. The browser receives only a neutral confirmation message.

On POST, the Worker claims the action with one atomic D1
`INSERT ... ON CONFLICT(action_id) DO NOTHING` and decides ownership from the
statement's change count. There is no read before this claim. A conflict reads
the already-recorded choice only to render the useful "already handled" page.
If the downstream publish or email operation fails after the claim, the row
remains and the reviewer is directed to handle the submission manually. Any
database error fails closed rather than risking two different choices.

Signed review links created before this deployment do not contain an action ID
or expiration. Until `LEGACY_ACTIONS_UNTIL`, the Worker derives a shared action
ID by normalizing and hashing the submission subject (`posting.title` for
publish links and `subject` for both decline choices). This preserves
cross-choice single use during the transition. Legacy links without a subject,
with a missing/invalid cutoff, or used at or after the cutoff are rejected.
New-format tokens always keep their own action ID and 14-day expiration.

The `/contact` route accepts the general website contact fields plus an optional
validated `associationSlug`. It uses the same honeypot, rate-limit bindings,
Resend recipient configuration, and FormSubmit fallback as posting-review
email delivery. Association destination addresses remain server-side.

If the Anthropic call fails for any reason, the submission is still emailed to
WPCNA with an "AI vetting unavailable — review manually" note. Nothing is lost.

## Recommendations

The AI vetting returns one of three buckets, matching the public guidelines:

- `READY_TO_POST` — clearly local, community-serving, on-topic, and complete
  enough to post with little or no edits.
- `NEEDS_REVIEW` — plausibly appropriate but missing details, ambiguous,
  borderline, or sensitive enough to warrant a close human look.
- `NOT_QUALIFIED` — clearly outside the guidelines (commercial, classifieds,
  unrelated to White Plains, spam, etc.).

A separate `escalate` flag rides alongside the bucket for content that is
defamatory, accusatory, political-campaign, legal, medical, emergency/safety,
discriminatory, or threatening — those should always get careful human handling.
The recommendation is advisory only; it never publishes or replies to the
submitter.

The audit email subject is tagged `[READY TO POST]`, `[NEEDS REVIEW]`,
`[NOT QUALIFIED]`, or `[ESCALATE]` so WPCNA can triage at a glance.

## Test Curl

Replace the URL with the deployed Worker endpoint.

```bash
curl -i -X POST "https://YOUR-WORKER.workers.dev/posting-review" \
  -H "Origin: https://wp-cna.github.io" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sarah Klein",
    "email": "sarah@example.com",
    "subject": "Battle Hill Block Cleanup",
    "category": "Volunteer / Cleanup",
    "postingType": "Volunteer opportunity",
    "organization": "Battle Hill Neighborhood Association",
    "eventDate": "2026-06-14",
    "eventTime": "09:00",
    "location": "Battle Hill Park",
    "audience": ["Neighborhood residents", "Families"],
    "whitePlainsAffiliation": "White Plains resident or neighborhood group",
    "fundraising": "No",
    "linksIncluded": "No",
    "guidelinesConfirmed": "yes",
    "message": "The Battle Hill neighborhood association is organizing a volunteer cleanup morning at Battle Hill Park for residents and families.",
    "pageSource": "/demo12/posting/"
  }'
```

Expected browser response:

```json
{
  "ok": true,
  "message": "Submission received. WPCNA will review it before anything is posted."
}
```

## Demo12 Deployment Notes

For the GitHub Pages demo build, set:

- `SITE_BASE_URL=https://wp-cna.github.io`
- `SITE_PATH_PREFIX=/demo12`
- `CANONICAL_PATH_PREFIX=/demo12`
- repository variable `POSTING_API_URL` to the deployed Worker `/posting-review` URL

On the Worker side, set the `ANTHROPIC_API_KEY` secret (and email secrets)
before deploying so vetting is live:

```bash
cd worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put POSTING_RECIPIENT_EMAILS
npm run deploy
```

The deploy workflow fails if `POSTING_API_URL` is missing so the live form
cannot silently ship with an empty backend endpoint.
