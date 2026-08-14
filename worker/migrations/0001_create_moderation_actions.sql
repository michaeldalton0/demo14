CREATE TABLE moderation_actions (
  action_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publish', 'decline', 'notify')),
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX moderation_actions_expires_at_idx
  ON moderation_actions (expires_at);
