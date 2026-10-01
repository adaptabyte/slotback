# Architecture

```
 openings in                         Slotback                                   out
 ───────────                         ────────                                   ───
 iCal feed poll  ─┐                                                       ┌─▶ FHIR Appointment / webhook / staff task
 FHIR Slot poll  ─┤   ingest + dedupe ─▶ Engine (pure, sync) ─▶ outbox ───┤
 HL7 SIU (HTTP)  ─┤        │                 │        ▲          (SQLite) ├─▶ SMS (Twilio) / email (SMTP) / webhook
 REST API        ─┤        │                 ▼        │                   └─▶ audit log (hash-chained)
 staff "post"    ─┘        └──────▶ SQLite store (field-encrypted) ◀── booking results, replies, clock ticks
```

## Layers

| Path | What it is |
|---|---|
| `src/core/` | The matching engine. No I/O, no Node APIs, no patient identifiers. Runs unchanged in the server and in the browser demo (`site/assets/slotback-core.js` is a bundle of it). |
| `src/server/` | HTTP server, storage, security, integrations. Zero web framework; `node:http`, `node:sqlite`, `node:crypto`. One runtime dependency (`nodemailer`, loaded only when SMTP is used). |
| `site/` | Static marketing site and live demo, deployed to GitHub Pages. |

## The engine (`src/core/engine.ts`)

A synchronous state machine over a `Store`. Every method takes `now` explicitly and returns an `Outcome`:

- `events` — what happened (`opening.created`, `opening.ranked`, `offer.sent`, `booking.confirmed`, `chain.freed`…), used for the audit trail and the UI.
- `commands` — side effects the host must perform: `book`, `cancel_original`, `notify`.

Asynchronous results flow back in as method calls (`bookingResult`, `respond`, `tick`). Because time is a parameter, the whole engine is deterministic: the tests drive weeks of scheduling in milliseconds and the demo runs a simulated clock.

### Filling an opening

1. **Eligibility** (`matcher.ts`): status active, provider, visit type, slot length, modality, location, notice, earliest date, blackout dates, weekly availability windows (in the practice time zone, DST-safe), and — for patients who already hold an appointment — whether the slot is meaningfully earlier (24 h by default). Every failed check has a human-readable reason.
2. **Ranking** (`priority.ts`): an explainable additive score. Defaults: acuity 50 pts/level above 1; +1/day waiting (max 20); +10 with no appointment yet; +0.5/day the opening would save (max 15); −5 per declined or unanswered offer; ± provider adjustment; pinned patients first. One acuity level outweighs all non-clinical factors combined, so acuity decides and the rest breaks ties. Deterministic tie-breaks: longest waiting, then id.
3. **Action:**
   - Top patient chose auto-book → booked immediately (`book` command).
   - Otherwise → offer with a hold (30 min, never past start − 60 min). If the opening starts within 24 h, the top 3 ask-first patients are offered at once and the first acceptance wins; the batch never skips past an auto-book patient.
   - During quiet hours (21:00–08:00 by default) ask-first offers wait for morning; auto-book still proceeds and its text is delivered at 08:00.
4. **Cascade:** decline/expiry → next candidate. Booking confirmed for a patient who had a later appointment → `cancel_original` + a new opening for the freed slot (`chainDepth + 1`), filled the same way.
5. Nobody eligible → the opening stays `open` and is re-tried whenever an entry is added or changed or the clock ticks; it expires at start − 60 min.

## Server runtime (`src/server/runtime.ts`)

- **Atomicity:** each engine call, its audit rows and its outbox rows commit in one SQLite transaction (`App.run`). A crash can't leave a booking without its notification or audit entry.
- **Outbox:** commands are executed asynchronously with retries (15 s → 1 h, 6 attempts). A booking that keeps failing becomes `needs_attention` for staff; a failed cancellation becomes a front-desk task; an undeliverable message is audited so staff can call.
- **Ingestion & dedupe:** every "slot is free" signal goes through `ingestFreedSlot`, which ignores slots already being filled and recognizes slots Slotback freed itself (so an EHR echo of our own cancellation is not offered twice). "Slot was booked" signals withdraw overlapping offers.
- **Timers:** engine tick + outbox every 15 s, source polling every 120 s, maintenance hourly (expire requests, purge identifiers, delete expired sessions/tokens).

## Storage (`src/server/db.ts`)

SQLite in WAL mode with `secure_delete`. Patients and waitlist entries are AES-256-GCM encrypted per row with the row id as associated data; openings/offers/bookings hold only ids and times. Phone/email lookups use HMAC blind indexes. The audit table is append-only (triggers) and hash-chained. Schema migrations run automatically on start (`PRAGMA user_version`).

## Security model

See [security-controls.md](security-controls.md).
