import assert from "node:assert/strict";
import test from "node:test";

import { postingRecipients } from "../src/posting-review.js";

test("WPCNA submission reviews reach the shared inbox and both Michaels", () => {
  assert.deepEqual(
    postingRecipients({
      POSTING_RECIPIENT_EMAILS_DEFAULT:
        "wpcna.info@gmail.com,michael@mdalton.com,michael.kushman@gmail.com",
      POSTING_RECIPIENT_EMAILS: "wpcna.info@gmail.com,michael.kushman@gmail.com"
    }),
    [
      "wpcna.info@gmail.com",
      "michael@mdalton.com",
      "michael.kushman@gmail.com"
    ]
  );
});
