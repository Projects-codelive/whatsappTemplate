# Phase 2 — Retry Failed Broadcasts Architecture Audit

---

## Executive Summary

The broadcast system has a fundamental distributed-system gap: the Meta WhatsApp API call and the database persistence are not atomic. When Meta accepts a message and returns a `message_id`, but the subsequent database write fails, the recipient is marked `failed` with `whatsapp_message_id = NULL` — even though Meta successfully delivered the message. A naive retry that treats `failed + NULL` as "safe to retry" will send duplicate messages to users.

This audit designs a retry architecture that accounts for this gap, introduces attempt-level tracking, prevents duplicate delivery through concurrency controls, and preserves full audit history.

---

## 1. Current Architecture

### 1.1 Send Flow

```
Client (use-broadcast-sending.ts)
  │
  ├─ Step 1: Resolve audience contacts
  ├─ Step 2: INSERT broadcasts row (status='sending')
  ├─ Step 3: INSERT broadcast_recipients rows (status='pending')
  ├─ Step 4: For each batch of 10 recipients:
  │     └─ POST /api/whatsapp/broadcast
  │           │
  │           └─ For each recipient in batch:
  │                 ├─ sanitizePhoneForMeta(phone)
  │                 ├─ phoneVariants() for sandbox retry
  │                 ├─ sendTemplateMessage() → Meta API
  │                 │     ├─ Meta accepts → returns messageId
  │                 │     └─ Meta rejects → throws Error
  │                 └─ Return result to client
  │
  ├─ Step 5: Client persists each result:
  │     ├─ Meta accepted:
  │     │     └─ persistRecipientUpdate(status='sent', whatsapp_message_id=result.id)
  │     │           ├─ Success → recipient = sent
  │     │           └─ Failure (3 retries) → recipient = failed
  │     └─ Meta rejected:
  │           └─ recipient = failed, error_message = error
  │
  └─ Step 6: Update broadcasts.status to 'sent' or 'failed'
```

### 1.2 Webhook Flow

```
Meta Webhook → POST /api/whatsapp/webhook
  │
  ├─ Status updates:
  │     ├─ Lookup broadcast_recipients by whatsapp_message_id
  │     ├─ Validate forward-only status transition
  │     ├─ Update recipient status (sent → delivered → read)
  │     └─ Aggregate trigger bumps broadcasts counters
  │
  └─ Inbound messages:
        ├─ Find/create contact + conversation
        ├─ Insert messages row
        ├─ Flag broadcast reply if applicable
        └─ Dispatch automations/flows
```

### 1.3 Aggregate Counters

Migration 005 installs an incremental trigger on `broadcast_recipients`:

```sql
-- When recipient transitions pending → sent:
--   sent_count += 1
-- When recipient transitions sent → delivered:
--   sent_count += 1, delivered_count += 1
-- When recipient transitions → failed:
--   failed_count += 1
```

The function `_bcast_cols_for_status()` defines which columns each status contributes to. The `recompute_broadcast_counts()` function is retained as a safety net for manual counter reconciliation.

### 1.4 Key Constraints

- `broadcast_recipients.whatsapp_message_id` has a **unique partial index** (`WHERE whatsapp_message_id IS NOT NULL`)
- `broadcast_recipients.status` CHECK: `'pending' | 'sent' | 'delivered' | 'read' | 'replied' | 'failed'`
- `broadcasts.status` CHECK: `'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'`
- Webhook enforces forward-only status transitions via `isValidStatusTransition()`

---

## 2. Critical Failure Modes

### 2.1 Case A — Meta Rejects (Safe)

```
Application → Meta
Meta rejects (HTTP 4xx/5xx, error body)
Database → recipient = failed, whatsapp_message_id = NULL
```

**Verdict:** Safe to retry. Meta did not accept the message. No duplicate possible.

### 2.2 Case B — Meta Accepts + DB Succeeds (Happy Path)

```
Application → Meta
Meta accepts → message_id returned
Database stores message_id, status = sent
Webhook mirrors status → delivered → read
```

**Verdict:** Must NOT retry. Message was delivered and tracked.

### 2.3 Case C — Meta Accepts + DB Fails (Critical Ambiguity)

```
Application → Meta
Meta accepts → message_id returned
Database update fails (network, constraint, timeout)
Recipient remains: status = 'failed', whatsapp_message_id = NULL
```

**Evidence in current code** (`use-broadcast-sending.ts:522-543`):

```typescript
if (result.status === 'sent') {
  const persistResult = await persistRecipientUpdate(
    supabase,
    recipient.id,
    {
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: result.whatsapp_message_id ?? null,
      error_message: null,
    },
  );

  if (!persistResult.success) {
    failedCount++;
    await supabase
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: `Failed to record send: ${persistResult.errorMessage}`,
      })
      .eq('id', recipient.id);
  }
}
```

When `persistRecipientUpdate` fails after 3 retries, the recipient is marked `failed` with `whatsapp_message_id = NULL`. But Meta already accepted the message. **Retrying blindly sends a duplicate.**

### 2.4 Case D — Application Timeout

```
Application → Meta (fetch hangs / serverless timeout)
Meta may have accepted or rejected
Application receives timeout error
Database → recipient = failed
```

**Verdict:** Ambiguous. Cannot determine Meta's result without querying the provider.

### 2.5 Case E — Client-Side Crash

```
Application → Meta → Meta accepts → messageId returned
Client browser crashes / network drops before persistRecipientUpdate
Recipient remains: status = 'pending' or 'failed'
```

**Verdict:** Ambiguous. The `whatsapp_message_id` was available in the API response but never persisted.

### 2.6 Case F — Webhook Arrives Before DB Persist

```
Application → Meta → Meta accepts
Meta webhook fires immediately
Webhook: whatsapp_message_id lookup → recipient not found (or still pending)
Webhook skips (recipient not found)
Later: DB persist succeeds → recipient = sent
But webhook already missed the status update
```

**Verdict:** The recipient stays at `sent` without `delivered` status until the next webhook replay (Meta retries webhooks, so this usually self-heals).

---

## 3. Why `failed + whatsapp_message_id IS NULL` Is Unsafe

The condition `status = 'failed' AND whatsapp_message_id IS NULL` does NOT guarantee that Meta did not send the message.

**Proof via the current code path:**

1. `sendTemplateMessage()` in `meta-api.ts:191-279` calls `fetch()` to Meta's API
2. If Meta responds with HTTP 200, `data.messages[0].id` is extracted
3. The `messageId` is returned to `broadcast/route.ts` as `result.whatsapp_message_id`
4. The broadcast API returns this to the client as part of `results[]`
5. The client calls `persistRecipientUpdate()` with the `whatsapp_message_id`
6. `persistRecipientUpdate()` has a 3-retry loop for DB writes
7. If all 3 DB writes fail, the recipient is marked `failed` with `error_message: "Failed to record send: ..."`
8. The `whatsapp_message_id` is **lost** — it was available in the API response but never persisted

**At the moment the Meta request returns successfully, the following information is available:**

| Information | Available? | Persisted on failure? |
|---|---|---|
| Meta message_id | Yes (in API response) | **NO** |
| HTTP status code | Yes (200) | **NO** |
| Provider error code | N/A (success) | N/A |
| Provider error message | N/A (success) | N/A |
| Request timing | Yes | **NO** |
| DB persistence result | Yes (after attempt) | Only if all retries fail |

**Conclusion:** The system currently has no mechanism to distinguish "Meta rejected" from "Meta accepted but DB failed." The only information saved on failure is `error_message`, which describes the *client-side* error, not Meta's response.

---

## 4. Send Attempt Model Design

### 4.1 Current Model

```
broadcast_recipients
  ├── id (PK)
  ├── broadcast_id (FK)
  ├── contact_id (FK)
  ├── status (single status)
  ├── whatsapp_message_id (single provider ID)
  ├── sent_at, delivered_at, read_at, replied_at
  ├── error_message
  └── created_at
```

This assumes **one recipient = one attempt**. Retry breaks this assumption.

### 4.2 Option A — Extend broadcast_recipients

```
broadcast_recipients
  ├── ...existing columns...
  ├── retry_count INT DEFAULT 0
  ├── current_whatsapp_message_id TEXT    -- latest attempt's provider ID
  ├── previous_whatsapp_message_id TEXT   -- prior attempt's provider ID
  ├── attempt_status TEXT                 -- 'confirmed_failed' | 'uncertain'
  └── last_retry_at TIMESTAMPTZ
```

**Evaluation:**

| Factor | Assessment |
|---|---|
| Reliability | Moderate — single row updates remain non-atomic with Meta |
| Auditability | Poor — only captures current + one previous ID |
| Webhook correlation | Problematic — must choose which whatsapp_message_id to match |
| Duplicate detection | Weak — can only compare 2 provider IDs |
| Schema complexity | Low |
| Migration complexity | Low |
| Query complexity | Low |
| Future retry support | Limited — capped at 2 tracked attempts |

### 4.3 Option B — Separate attempts table (Recommended)

```
broadcast_recipients          broadcast_recipient_attempts
  ├── id (PK)                   ├── id (PK)
  ├── broadcast_id (FK)         ├── recipient_id (FK → broadcast_recipients)
  ├── contact_id (FK)           ├── attempt_number INT
  ├── status                    ├── whatsapp_message_id TEXT
  ├── sent_at                   ├── attempt_status TEXT
  ├── delivered_at              ├── provider_http_status INT
  ├── read_at                   ├── provider_error_code INT
  ├── replied_at                ├── provider_error_message TEXT
  ├── created_at                ├── is_current BOOLEAN
  └── ...                       ├── created_at
                                ├── sent_at
                                └── completed_at
```

**Evaluation:**

| Factor | Assessment |
|---|---|
| Reliability | High — attempt creation is separate from Meta API call |
| Auditability | Excellent — full history of every attempt with all provider data |
| Webhook correlation | Clean — webhook matches whatsapp_message_id → attempt → recipient |
| Duplicate detection | Strong — can compare all previous provider IDs |
| Schema complexity | Moderate |
| Migration complexity | Moderate |
| Query complexity | Moderate (one JOIN for current state) |
| Future retry support | Unlimited — add rows, no schema changes |

### 4.4 Recommendation: Option B (Separate Attempts Table)

The attempts table provides:
- **Complete audit trail** of every send attempt
- **Clean webhook correlation** — match by whatsapp_message_id → attempt → recipient
- **Provider data preservation** — HTTP status, error codes, error messages per attempt
- **Duplicate detection** — compare whatsapp_message_id across all attempts
- **Future-proof** — unlimited retries without schema changes
- **Separation of concerns** — recipient represents the logical delivery; attempts represent physical sends

The `broadcast_recipients` row becomes the **logical delivery status** (aggregated from the latest attempt), while `broadcast_recipient_attempts` stores the **physical send history**.

---

## 5. Ambiguous Provider Result Strategy

### 5.1 The Problem

When Meta's result is unknown (timeout, network error, client crash), the system cannot determine whether Meta accepted or rejected the message. Treating unknown as "failed" risks duplicates. Treating unknown as "sent" risks false status.

### 5.2 Option A — New `uncertain` status

Add `uncertain` to the recipient status CHECK constraint:

```sql
status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'replied', 'failed', 'uncertain')
```

**Pros:** Explicitly models ambiguity
**Cons:** Increases state machine complexity; webhook must handle this status; UI must display it; counters must account for it

### 5.3 Option B — `attempt_status = uncertain` on attempts table only

Keep recipient statuses clean. Mark the *attempt* as uncertain:

```sql
attempt_status IN ('sent', 'failed', 'uncertain')
```

Then derive the recipient's logical status:
- If the latest attempt is `uncertain` → recipient status = `failed` (conservative, but with a flag)
- The retry system checks `attempt_status = 'uncertain'` separately from `attempt_status = 'failed'`

**Pros:** Keeps recipient state machine simple; webhook correlation still works; counters unaffected
**Cons:** Requires careful logic in retry eligibility

### 5.4 Option C — No explicit uncertain state; use error classification

Classify errors at the Meta API boundary:

```typescript
interface SendResult {
  status: 'accepted' | 'rejected' | 'unknown';
  messageId?: string;
  httpStatus?: number;
  errorCode?: number;
  errorMessage?: string;
}
```

- `accepted` → Meta returned 200 + messageId → `attempt_status = 'sent'`
- `rejected` → Meta returned 4xx/5xx with error body → `attempt_status = 'failed'`
- `unknown` → Network timeout, connection reset, no response → `attempt_status = 'uncertain'`

### 5.5 Recommendation: Option B + C Combined

1. Classify Meta responses into `accepted`, `rejected`, `unknown` at the API boundary
2. Store this as `attempt_status` on the attempts table
3. The recipient's logical status is derived from the latest attempt
4. `uncertain` attempts are treated conservatively for retry eligibility

### 5.6 Handling Uncertain Results

**Rule:** An `uncertain` attempt is NEVER automatically retried without a safe delay.

**Rationale:** If Meta accepted the message, an immediate retry sends a duplicate. If Meta rejected it, the user waits longer — but duplicate messages are worse than delayed retries.

**Strategy:**
1. `uncertain` attempts get a **cooldown period** (e.g., 5 minutes) before retry eligibility
2. During the cooldown, the system checks if a webhook arrives with the message_id (self-healing)
3. After the cooldown, the attempt remains `uncertain` — retry is allowed but with a flag
4. The retry creates a new attempt row (not overwriting the uncertain one)
5. Both message IDs are preserved; the webhook can correlate either

**Self-healing path:** Meta webhooks are delivered with the `whatsapp_message_id`. If a webhook arrives for an `uncertain` attempt, it means Meta accepted the message. The webhook handler updates the attempt status from `uncertain` to `sent`/`delivered`/etc.

---

## 6. Meta Recovery Mechanism Analysis

### 6.1 Does Meta Support Idempotency Keys?

**No.** The Meta WhatsApp Cloud API does not provide a client-generated idempotency key for template messages. The API accepts a JSON body with `messaging_product`, `to`, `type: 'template'`, and returns a `messages[].id` — but there is no field for an idempotency key.

### 6.2 Can We Query a Message by Client-Generated ID?

**No.** Meta's API provides `GET /{phone_number_id}/messages/{message_id}` to fetch message details, but:
- We don't have a client-generated ID (only Meta's returned ID)
- There's no way to query "did Meta accept a message with these parameters?"

### 6.3 Can We Confirm Whether a Specific Request Was Accepted?

**Partially.** If we saved the Meta `message_id` from the response, we could query it via the API to check its status. But in Case C (DB failure after Meta success), we didn't save the message_id.

### 6.4 Can We Use Webhooks as Confirmation?

**Yes.** Meta sends status webhooks for every accepted message. If we receive a webhook for a `whatsapp_message_id`, Meta definitely accepted the message. This is the only reliable confirmation mechanism.

### 6.5 Limitation Documentation

> **There is no provider-side idempotency mechanism for WhatsApp template messages.** The Meta Cloud API does not support client-generated idempotency keys, message deduplication, or pre-flight "did you already send this?" queries. The only way to confirm Meta accepted a message is to receive a status webhook for the returned `message_id`. This means the system cannot prevent all duplicates through provider-side controls alone.

---

## 7. Webhook Correlation Strategy

### 7.1 Current Behavior

```sql
-- Webhook handler:
SELECT id, status FROM broadcast_recipients
WHERE whatsapp_message_id = $1;

-- Then update:
UPDATE broadcast_recipients
SET status = $new_status
WHERE id = $recipient_id;
```

### 7.2 Problem with Multiple Attempts

```
Attempt 1 → Meta message ID A (Meta accepted, webhook fires)
Attempt 2 → Meta message ID B (Meta accepted, webhook fires)
```

If the webhook for message A arrives *after* attempt 2, and the recipient's `whatsapp_message_id` was updated to B, then webhook A finds the wrong row (or no row if B replaced A).

### 7.3 Recommended Correlation Model

The `broadcast_recipient_attempts` table provides clean correlation:

```sql
-- Webhook handler:
SELECT a.id, a.status, a.recipient_id
FROM broadcast_recipient_attempts a
WHERE a.whatsapp_message_id = $1;

-- Then update the attempt:
UPDATE broadcast_recipient_attempts
SET status = $new_status
WHERE id = $attempt_id;

-- Also update the recipient (derived from latest attempt):
UPDATE broadcast_recipients
SET status = $derived_status
WHERE id = $recipient_id;
```

**Key design decisions:**
- Each attempt has its own `whatsapp_message_id`
- The unique partial index moves to the attempts table: `UNIQUE(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL`
- The webhook matches on the attempts table, not the recipients table
- The recipient's `whatsapp_message_id` is always set to the **latest** attempt's ID (for backward compatibility)
- Previous attempt IDs are preserved in the attempts table

### 7.4 Old Webhook Safety

```
Attempt 1 → Meta ID A → status: sent
Attempt 2 → Meta ID B → status: sent
Webhook for A arrives → matches attempt 1 → updates attempt 1 to delivered
Webhook for B arrives → matches attempt 2 → updates attempt 2 to delivered
Recipient status = max(delivered, delivered) = delivered ✓
```

The recipient's status is always derived from the most advanced attempt. Old webhooks update their respective attempts without corrupting other attempts.

---

## 8. Recipient State Machine

### 8.1 Valid States

```sql
-- broadcast_recipients.status
'sending'    -- Initial state after broadcast is created
'sent'       -- At least one attempt was accepted by Meta
'delivered'  -- Meta confirmed delivery
'read'       -- Recipient read the message
'replied'    -- Recipient replied to the message
'failed'     -- All attempts failed (rejected or exhausted retries)
```

### 8.2 Removed States

- `pending` → Replaced by `sending` (the recipient is created and immediately enters the send pipeline)
- `uncertain` → Not a recipient-level status; lives on `broadcast_recipient_attempts.attempt_status`

### 8.3 Valid Transitions

```
sending → sent        (Meta accepts on any attempt)
sending → failed      (all attempts exhausted OR confirmed rejection)
sent → delivered      (webhook: delivered)
sent → read           (webhook: read, skipping delivered)
sent → replied        (inbound message from this contact)
sent → failed         (Meta sends a failure webhook — only from sent state)
delivered → read      (webhook: read)
delivered → replied   (inbound message from this contact)
read → replied        (inbound message from this contact)
```

### 8.4 Terminal States

- `failed` — No further transitions (retry creates a new attempt, but the recipient status stays `failed` until an attempt succeeds)
- `replied` — No further transitions

### 8.5 Retry Status Transitions

When a retry attempt succeeds:
```
failed → sent     (new attempt accepted by Meta)
```

This is the ONLY way to exit the `failed` state.

### 8.6 Trigger Compatibility

The incremental trigger in migration 005 uses `_bcast_cols_for_status()` which maps:
- `sending` → contributes to nothing (same as old `pending`)
- `sent` → `sent_count += 1`
- `delivered` → `sent_count + delivered_count += 1`
- etc.

Adding `sending` as a recognized status requires updating `_bcast_cols_for_status()`:

```sql
IF s = 'sending' THEN RETURN ARRAY[]::TEXT[]; END IF;
```

This is equivalent to the current `pending` behavior. The migration replaces `pending` with `sending`, so the trigger logic is unchanged.

---

## 9. Retry Eligibility Rules

### 9.1 Eligibility Table

| Condition | Retry Allowed? | Reason |
|---|---|---|
| `recipient.status = 'failed'` AND latest attempt `attempt_status = 'rejected'` | YES | Meta confirmed rejection; safe to retry |
| `recipient.status = 'failed'` AND latest attempt `attempt_status = 'sent'` | NO | Meta accepted; retrying creates duplicate |
| `recipient.status = 'failed'` AND latest attempt `attempt_status = 'uncertain'` AND cooldown elapsed | YES (with flag) | No webhook arrived after cooldown; likely a true failure |
| `recipient.status = 'failed'` AND latest attempt `attempt_status = 'uncertain'` AND cooldown NOT elapsed | NO | May still receive webhook; too early to assume failure |
| `broadcast.status = 'sending'` | NO | Original broadcast still in progress; concurrent sends unsafe |
| `broadcast.status = 'draft'` or `'scheduled'` | NO | Invalid state for retry |
| `recipient.contact_id IS NULL` (deleted contact) | NO | No phone number to send to |
| `recipient.retry_count >= MAX_RETRIES` | NO | Prevent infinite retry loops |
| Another retry operation is running (lock held) | NO | Concurrency conflict |
| `recipient.status = 'sent'`, `'delivered'`, `'read'`, `'replied'` | NO | Message was accepted; retrying creates duplicate |

### 9.2 Maximum Retry Limit

**Recommended: 3 retries** per recipient per broadcast.

This provides enough attempts to overcome transient DB failures while preventing infinite loops. The limit is configurable at the broadcast level via `broadcasts.retry_limit` (default 3).

### 9.3 Retry Count Tracking

The `retry_count` on `broadcast_recipients` increments each time a new attempt is created (excluding the initial attempt). When `retry_count >= retry_limit`, the recipient is ineligible for further retries.

---

## 10. Concurrency Protection

### 10.1 The Problem

Two concurrent retry requests could both claim the same recipients, both send to Meta, and both create attempt rows — resulting in duplicate messages.

### 10.2 Option Analysis

| Option | Mechanism | Duration | Protection Level |
|---|---|---|---|
| A: DB Transaction + Row Lock | `SELECT ... FOR UPDATE` | Transaction scope | Good for DB, but lock releases before Meta API call |
| B: Advisory Lock | `pg_advisory_lock()` | Session scope | Works across transactions, but requires explicit release |
| C: Optimistic Version | Version column on recipients | Per-update | Detects conflicts but doesn't prevent sends |
| D: Atomic Claim | Conditional UPDATE | Single statement | Best — prevents claiming without locks |

### 10.3 Recommended: Option D — Atomic Recipient Claim

```sql
UPDATE broadcast_recipients
SET status = 'sending', retry_count = retry_count + 1, last_retry_at = NOW()
WHERE id = ANY($1::uuid[])
AND status = 'failed'
AND retry_count < $2
RETURNING id, contact_id, whatsapp_message_id;
```

**How it works:**
1. The retry API identifies eligible recipients
2. An atomic `UPDATE ... WHERE status = 'failed'` claims them by changing status to `sending`
3. Only the rows that matched the condition are updated (`RETURNING` gives us the claimed IDs)
4. If another retry request tries to claim the same rows, the `WHERE status = 'failed'` condition fails (they're now `'sending'`), so zero rows are returned
5. After Meta API calls complete, the recipient is updated to the final status (`sent` or `failed`)

### 10.4 Why This Is Safe

- The atomic UPDATE is a single Postgres statement — no race condition
- `WHERE status = 'failed'` ensures only failed recipients are claimed
- `RETURNING` returns exactly the rows that were updated
- No explicit lock needed — Postgres row-level locking during the UPDATE is sufficient
- The lock duration is milliseconds (single UPDATE statement), not the duration of the Meta API call

### 10.5 Broadcast-Level Guard

Additionally, check the broadcast status before processing:

```sql
SELECT status FROM broadcasts WHERE id = $1;
-- Only proceed if status = 'sent' or 'failed'
```

This prevents retry during the original send loop.

### 0.10.6 Lock Release Strategy

If the retry API crashes after claiming recipients but before completing Meta sends:
- Recipients stay in `sending` status indefinitely
- **Solution:** A background job (or the next retry attempt) resets `sending` recipients back to `failed` if they've been in `sending` for > 5 minutes

```sql
UPDATE broadcast_recipients
SET status = 'failed', error_message = 'Retry timed out'
WHERE status = 'sending'
AND last_retry_at < NOW() - INTERVAL '5 minutes';
```

---

## 11. Retry Flow Design

### 11.1 Server-Side Sequence

```
POST /api/whatsapp/broadcast/:id/retry
  │
  ├─ 1. Authenticate admin (Supabase auth)
  ├─ 2. Load broadcast, verify status ∈ ('sent', 'failed')
  ├─ 3. Atomic claim recipients:
  │     UPDATE broadcast_recipients
  │     SET status = 'sending', retry_count = retry_count + 1
  │     WHERE broadcast_id = $1
  │     AND status = 'failed'
  │     AND retry_count < $2
  │     RETURNING id, contact_id
  ├─ 4. For each claimed recipient:
  │     ├─ 4a. Create attempt row:
  │     │     INSERT INTO broadcast_recipient_attempts
  │     │       (recipient_id, attempt_number, attempt_status)
  │     │     VALUES ($1, $next_attempt_number, 'sending')
  │     ├─ 4b. Resolve phone, params, template
  │     ├─ 4c. Call sendTemplateMessage()
  │     │     ├─ Meta accepts (HTTP 200):
  │     │     │   UPDATE attempt SET
  │     │     │     whatsapp_message_id = $id,
  │     │     │     attempt_status = 'sent',
  │     │     │     provider_http_status = 200
  │     │     ├─ Meta rejects (HTTP 4xx/5xx):
  │     │     │   UPDATE attempt SET
  │     │     │     attempt_status = 'failed',
  │     │     │     provider_http_status = $code,
  │     │     │     provider_error_code = $code,
  │     │     │     provider_error_message = $msg
  │     │     └─ Network/timeout error:
  │     │         UPDATE attempt SET
  │     │           attempt_status = 'uncertain',
  │     │           provider_error_message = $msg
  │     └─ 4d. Update recipient based on attempt result:
  │           ├─ attempt_status = 'sent':
  │           │   SET status = 'sent', sent_at = NOW(),
  │           │       whatsapp_message_id = $latest_message_id
  │           ├─ attempt_status = 'failed':
  │           │   SET status = 'failed', error_message = $error
  │           └─ attempt_status = 'uncertain':
  │               SET status = 'failed', error_message = 'Result unknown'
  ├─ 5. Return summary response
  └─ 6. Background: webhook self-heals uncertain attempts
```

### 11.2 Batch Processing

The retry processes recipients in batches of 10 (same as original send), with 1-second delays between batches to respect Meta rate limits. The atomic claim fetches all eligible recipients at once, but sends are batched.

### 11.3 Error Handling

If the retry API crashes mid-process:
- Claimed recipients are in `sending` status
- The cleanup job (see §10.6) resets them to `failed` after 5 minutes
- The user can retry again after the reset

---

## 12. Database Schema Design

### 12.1 New Table: `broadcast_recipient_attempts`

```sql
CREATE TABLE IF NOT EXISTS broadcast_recipient_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID NOT NULL REFERENCES broadcast_recipients(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  whatsapp_message_id TEXT,
  attempt_status TEXT NOT NULL DEFAULT 'sending'
    CHECK (attempt_status IN ('sending', 'sent', 'failed', 'uncertain')),
  provider_http_status INTEGER,
  provider_error_code INTEGER,
  provider_error_message TEXT,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (recipient_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_recipient
  ON broadcast_recipient_attempts (recipient_id);

-- Move the unique constraint from broadcast_recipients to attempts:
-- This index is CRITICAL for webhook correlation:
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_wamid
  ON broadcast_recipient_attempts (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;
```

### 12.2 Alter `broadcast_recipients`

```sql
-- Add retry tracking columns:
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

-- Replace 'pending' with 'sending' in the status CHECK constraint:
-- (Requires dropping and recreating the constraint)
ALTER TABLE broadcast_recipients
  DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;

ALTER TABLE broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'replied', 'failed'));
```

### 12.3 Alter `broadcasts`

```sql
-- Add retry configuration:
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS retry_limit INTEGER NOT NULL DEFAULT 3;
```

### 12.4 Drop Old Index

```sql
-- Remove the unique index from broadcast_recipients (moved to attempts):
DROP INDEX IF EXISTS idx_broadcast_recipients_wamid;
```

### 12.5 Update Incremental Trigger

```sql
-- Update _bcast_cols_for_status to handle 'sending' (replaces 'pending'):
CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  IF s = 'sending' THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### 12.6 Preserve Webhook History

Previous `whatsapp_message_id` values are preserved in the `broadcast_recipient_attempts` table. Each attempt row retains its own `whatsapp_message_id` for the lifetime of the database. The recipient's `whatsapp_message_id` column is always updated to the latest attempt's ID (for backward compatibility with the webhook handler during the transition period).

### 12.7 Counter/Trigger Impact

The incremental trigger remains correct because:
- `sending` contributes to no counters (same as old `pending`)
- When a recipient transitions `sending → sent`, the trigger bumps `sent_count`
- When a recipient transitions `sending → failed`, the trigger bumps `failed_count`
- The `recompute_broadcast_counts()` safety net can reconcile any drift

**No trigger logic changes are required** — only the `_bcast_cols_for_status()` function needs the `sending` case added (which is equivalent to the existing `pending` case).

---

## 13. API Design

### 13.1 Retry Endpoint

```
POST /api/whatsapp/broadcast/:id/retry
```

**Authorization:** Authenticated user who owns the broadcast (via RLS).

**Request Body:** None (or optional `{ recipientIds?: string[] }` for selective retry).

**Response:**

```json
{
  "broadcastId": "uuid",
  "totalEligible": 10,
  "claimed": 10,
  "sent": 7,
  "failed": 2,
  "uncertain": 1,
  "skipped": 3
}
```

**Error Responses:**

```json
// Broadcast not in retryable state:
{ "error": "Broadcast is currently sending. Please wait." }

// No eligible recipients:
{ "error": "No failed recipients eligible for retry." }

// Broadcast not found:
{ "error": "Broadcast not found." }
```

### 13.2 Retry Status Endpoint (Optional)

```
GET /api/whatsapp/broadcast/:id/retry-status
```

Returns the current retry state of all recipients, useful for the UI to poll progress.

---

## 14. UI Design

### 14.1 Retry Button Visibility

| Broadcast Status | Retry Button |
|---|---|
| `draft` | Hidden |
| `scheduled` | Hidden |
| `sending` | Hidden |
| `sent` | Visible if `failed_count > 0` and retry-eligible recipients exist |
| `failed` | Visible if retry-eligible recipients exist |

### 14.2 Retry Button Behavior

- Clicking opens a confirmation dialog: "Retry X failed recipients?"
- Button is disabled while a retry is in progress
- Progress is shown via polling the retry status endpoint
- After completion, the broadcast detail page refreshes

### 14.3 Attempt History in Recipient Detail

When expanding a recipient row, show the attempt history:

```
Attempt 1 — Sent at 14:32 — Meta ID: wamid.xxx — Status: Delivered
Attempt 2 — Sent at 15:10 — Meta ID: wamid.yyy — Status: Sent (pending delivery)
```

### 14.4 Safety Mechanism

The UI is NOT the only safety mechanism. The server-side retry eligibility rules (§9) are the authoritative check. The UI merely hides the button when retry is obviously not applicable.

---

## 15. Test Plan

### Test 1 — Normal Failure → Retry Success

```
Setup: Send template to contact → Meta rejects → recipient = failed
Action: Trigger retry
Verify: New attempt created → Meta accepts → recipient = sent → Meta webhook → delivered
```

### Test 2 — Meta Success → No Retry

```
Setup: Send template → Meta accepts → recipient = sent
Action: Attempt retry
Verify: Retry eligibility check returns 0 eligible recipients
```

### Test 3 — Meta Success + DB Failure → No Duplicate

```
Setup: Mock Meta to accept (return messageId) but mock DB persist to fail
Verify: Recipient = failed, whatsapp_message_id = NULL
Action: Trigger retry
Verify: Retry sees attempt_status = 'uncertain' (if we captured it) or
        'failed' (if DB failure was total) → retry creates new attempt
        → Meta accepts → recipient = sent
        → Webhook for original message arrives → attempt row updated
        → No duplicate message (Meta may deliver both, but we track both)
```

### Test 4 — Meta Timeout → Uncertain

```
Setup: Mock Meta fetch to timeout after 30s
Verify: Attempt created with attempt_status = 'uncertain'
Action: Immediate retry
Verify: Retry rejected (cooldown not elapsed)
Action: Retry after cooldown
Verify: Retry proceeds, new attempt created
```

### Test 5 — Two Concurrent Retries

```
Setup: 10 failed recipients
Action: Fire retry A and retry B simultaneously
Verify: Atomic claim ensures each recipient is claimed by exactly one retry
        → Total claimed = 10, not 20
        → Each recipient has exactly one new attempt
```

### Test 6 — Original Broadcast Still Sending

```
Setup: Broadcast status = 'sending'
Action: Trigger retry
Verify: Rejected with error "Broadcast is currently sending"
```

### Test 7 — Deleted Contact

```
Setup: Recipient with contact_id = NULL (contact deleted)
Action: Trigger retry
Verify: Recipient skipped (no phone to send to)
```

### Test 8 — Old Webhook After Retry

```
Setup: Attempt 1 → Meta ID A → uncertain → Retry → Attempt 2 → Meta ID B → sent
Action: Webhook for Meta ID A arrives (delivered)
Verify: Attempt 1 updated to delivered
        Attempt 2 remains sent
        Recipient status remains sent/delivered (whichever is more advanced)
```

### Test 9 — Retry Limit

```
Setup: Broadcast with retry_limit = 2, recipient with retry_count = 2
Action: Trigger retry
Verify: Recipient skipped (retry_count >= retry_limit)
```

### Test 10 — Aggregate Counters

```
Setup: Broadcast with 10 recipients: 8 sent, 2 failed
Action: Retry → 1 succeeds, 1 fails (still)
Verify: sent_count = 9, failed_count = 1
        delivered_count, read_count, replied_count unchanged
```

### Test 11 — Claim Timeout Recovery

```
Setup: Recipient in 'sending' status for > 5 minutes (stale)
Action: Cleanup job runs
Verify: Recipient reset to 'failed' with error_message = 'Retry timed out'
        → Eligible for next retry
```

### Test 12 — Attempt History Preservation

```
Setup: 3 retry attempts for one recipient
Verify: broadcast_recipient_attempts has 3 rows
        Each with correct whatsapp_message_id, attempt_status, timestamps
        → No data lost from previous attempts
```

---

## 16. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Duplicate message** | Low | High | Atomic claim prevents concurrent sends; uncertain cooldown prevents premature retry; webhook correlation tracks all attempts |
| **Webhook corruption** | Low | Medium | Each attempt has its own whatsapp_message_id; webhook matches on attempts table; old webhooks update correct attempt |
| **Concurrent retry** | Low | High | Atomic UPDATE WHERE status = 'failed' ensures single claim; RETURNING returns exactly claimed rows |
| **DB/Provider mismatch** | Medium | High | Uncertain status with cooldown; cleanup job for stale sending; attempts table preserves all provider data |
| **Data loss** | Low | Medium | Attempts table preserves full history; whatsapp_message_id preserved per attempt; audit trail complete |
| **Counter drift** | Low | Low | Incremental trigger remains correct; recompute_broadcast_counts() safety net available |
| **Infinite retry loop** | Low | Low | retry_count limit (default 3); broadcast-level retry_limit |

---

## 17. Exactly-Once Delivery

**Can the system guarantee exactly-once WhatsApp delivery?**

**NO.**

The application cannot atomically coordinate Meta's external API with its own database. There are multiple failure modes where Meta accepts a message but the database does not record it, and the only way to discover this is via a webhook that may arrive at any time.

**Practical goal: Best-effort duplicate minimization.**

The system strives for:
- **At-most-once** behavior for the common case (Meta rejects → safe retry)
- **At-least-once** behavior for the uncertain case (with cooldown to minimize duplicates)
- **Full audit trail** of all attempts so duplicates can be investigated

**Trade-off:** We accept slightly delayed retries (cooldown for uncertain cases) in exchange for reduced duplicate risk. The alternative — immediate retry on uncertainty — guarantees some duplicates for Meta-success/DB-failure cases.

**The system never makes the assumption `failed + whatsapp_message_id = NULL = Meta definitely did not send`.** Every retry decision is based on the attempt-level `attempt_status`, which is classified at the API boundary.

---

## 18. Migration Requirements

| Change | Type | Description |
|---|---|---|
| `broadcast_recipient_attempts` table | CREATE | New table for attempt tracking |
| `broadcast_recipients.retry_count` | ADD COLUMN | Default 0 |
| `broadcast_recipients.last_retry_at` | ADD COLUMN | Nullable timestamp |
| `broadcast_recipients.status` CHECK | MODIFY | Replace `pending` with `sending` |
| `broadcasts.retry_limit` | ADD COLUMN | Default 3 |
| `idx_broadcast_recipients_wamid` | DROP | Moved to attempts table |
| `idx_attempts_wamid` | CREATE | Unique partial index on attempts |
| `idx_attempts_recipient` | CREATE | Index for recipient lookup |
| `_bcast_cols_for_status()` | REPLACE | Add `sending` case (same as `pending`) |
| `cleanup_stale_sending()` | CREATE | Background job function |

---

## 19. Final Decision

**READY FOR IMPLEMENTATION**

The architecture addresses all identified failure modes:

1. **Duplicate prevention** via atomic recipient claim, attempt-level tracking, and uncertain-cooldown
2. **Webhook safety** via attempts table correlation (no whatsapp_message_id collision between attempts)
3. **Concurrency** via atomic UPDATE with WHERE conditions
4. **Audit trail** via broadcast_recipient_attempts table with full provider data
5. **Counter correctness** via unchanged incremental trigger logic
6. **Recovery** via cleanup job for stale sending states

The design explicitly handles the distributed-system gap between Meta acceptance and database persistence, and never assumes `failed + NULL` means "safe to retry."

---

*This audit covers architecture and design only. Implementation follows in subsequent phases: migration, server-side retry service, concurrency protection, webhook correlation updates, retry API, and UI.*
