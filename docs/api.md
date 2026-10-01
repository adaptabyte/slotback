# Integration API

Everything an EHR, interface engine or script needs to feed openings into Slotback and receive bookings back.

- Base URL: your instance, e.g. `https://waitlist.yourpractice.com`
- Auth: `Authorization: Bearer sbk_…` — create keys under **Settings → API keys** or with `npm run cli -- api-key "<name>"`. Keys are stored only as SHA-256 hashes and can be revoked at any time.
- Bodies are JSON unless noted. Timestamps are ISO-8601 **with an offset** (`2026-10-07T14:00:00Z` or `2026-10-07T10:00:00-04:00`).
- Errors return `{"error": "…"}` with a 4xx status. Rate limit: 600 requests/minute per IP.
- Every call is written to the audit log under the API key's id.

## Openings

### `POST /api/v1/openings` — a slot became free

```bash
curl -X POST https://waitlist.example.com/api/v1/openings \
  -H "Authorization: Bearer $SLOTBACK_KEY" -H "Content-Type: application/json" \
  -d '{
        "providerId": "dr_lee",
        "start": "2026-10-07T14:00:00Z",
        "end":   "2026-10-07T15:00:00Z",
        "modality": "in_person",
        "locationId": "main",
        "appointmentTypes": ["new_eval"],
        "externalId": "EHR-SLOT-8812"
      }'
```

| Field | Required | Notes |
|---|---|---|
| `providerId` | yes | A provider id from Settings |
| `start`, `end` | yes | The free span |
| `modality` | no | `in_person` or `telehealth`; defaults to the provider's default |
| `locationId` | no | Defaults to the provider's location |
| `appointmentTypes` | no | Restrict which visit types may use the slot; omit for any type that fits |
| `externalId` | no | Your id for the slot; repeated posts with the same id are de-duplicated |

Response `201 {"id": "opn_…", "status": "offering", "duplicate": false}`, or `200` with `"duplicate": true` if Slotback is already filling this slot (including slots it freed itself by moving a patient up).

### `GET /api/v1/openings/:id`

Returns status (`open`, `offering`, `booking`, `filled`, `expired`, `withdrawn`, `needs_attention`) and any bookings.

### `POST /api/v1/openings/:id/withdraw`

Stop offering a slot (for example, it was filled by phone).

### `POST /api/v1/slots/booked` — a time was booked in the source system

```json
{ "providerId": "dr_lee", "start": "2026-10-07T14:00:00Z", "end": "2026-10-07T15:00:00Z" }
```

Withdraws any overlapping opening that is still being offered, so nobody is double-booked.

## HL7 v2

### `POST /api/v1/hl7`

Send the raw ER7 message as the body (`Content-Type: text/plain`, MLLP framing optional). The response is an HL7 `ACK` (`MSA|AA` on success, `MSA|AE` on error).

| Trigger | Effect |
|---|---|
| `SIU^S15` (cancel), `SIU^S17` (delete) | Creates an opening |
| `SIU^S12` (new booking) | Withdraws an overlapping opening |
| anything else | Acknowledged and ignored |

Field mapping: provider from `AIP-3.1` (match it to each provider's **hl7Id** in Settings); start from `AIS-4` or `SCH-11.4`; end from `SCH-11.5`, else start + `AIS-7`/`SCH-9` minutes; appointment id from `SCH-2` (falls back to `SCH-1`). Times without an offset are read in the practice time zone.

Most interface engines (Mirth/NextGen Connect, Rhapsody, Cloverleaf, Iguana) can route SIU from MLLP to an HTTPS endpoint.

## Waitlist entries

### `POST /api/v1/entries` — add a patient from another system

```json
{
  "patient": {
    "firstName": "Jane", "lastName": "Doe", "dob": "1988-04-02",
    "phone": "+15550104242", "email": "jane@example.com",
    "preferredChannel": "sms", "smsConsent": true, "externalRef": "MRN-12345"
  },
  "appointmentType": "follow_up",
  "providerIds": ["dr_lee"],
  "modalities": ["in_person", "telehealth"],
  "availability": [ { "day": 2, "start": "08:00", "end": "12:00" }, { "day": 4, "start": "13:00", "end": "17:00" } ],
  "minNoticeMinutes": 180,
  "bookingMode": "confirm",
  "acuity": 3,
  "currentAppointment": { "start": "2026-11-12T15:00:00Z", "end": "2026-11-12T15:30:00Z", "providerId": "dr_lee", "externalId": "APPT-991" },
  "pendingReview": false
}
```

`day` is 0 (Sunday) – 6 (Saturday); times are local to the practice. Returns `201 {"id": "ent_…", "status": "active"}`.

## Booking write-back (webhook adapter)

With `SLOTBACK_BOOKING=webhook`, Slotback POSTs to `SLOTBACK_BOOKING_WEBHOOK_URL`:

```json
{
  "event": "booking.requested",
  "bookingId": "bkg_…",
  "appointment": {
    "start": "2026-10-07T14:00:00.000Z", "end": "2026-10-07T15:00:00.000Z",
    "providerId": "dr_lee", "locationId": "main", "modality": "in_person",
    "appointmentType": "new_eval", "appointmentTypeName": "New patient evaluation",
    "sourceSlot": { "source": "api", "externalId": "EHR-SLOT-8812" }
  },
  "patient": { "externalRef": "MRN-12345", "firstName": "Jane", "lastName": "Doe", "dob": "1988-04-02" }
}
```

Reply with:

| Status | Meaning |
|---|---|
| `200`/`201` `{"externalId": "…"}` | Booked; the patient is notified |
| `202` | Accepted, result comes later via `POST /api/v1/bookings/:id/result` |
| `409` | Slot already taken; the patient stays on the waitlist and is told |
| other `4xx` | Failed; the opening is flagged for staff |
| `5xx` / timeout | Retried with backoff (15 s → 1 h, 6 attempts), then flagged for staff |

When a patient who had a later appointment is moved up, a second event asks you to cancel the original:

```json
{ "event": "appointment.cancel_requested", "bookingId": "bkg_…", "appointment": { "start": "…", "externalId": "APPT-991", "providerId": "dr_lee" }, "patient": { … }, "reason": "Moved to an earlier appointment from the waitlist" }
```

### `POST /api/v1/bookings/:id/result`

```json
{ "ok": true, "externalId": "APPT-1203" }
{ "ok": false, "reason": "conflict", "message": "Slot taken" }
```

### Verifying webhook signatures

Every outgoing webhook (bookings and notifications) carries `X-Slotback-Signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Reject requests whose signature does not match or whose `t` is more than 5 minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(header, rawBody, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

## Notifications webhook

With `SLOTBACK_SMS=webhook` and/or `SLOTBACK_EMAIL=webhook`, messages are POSTed (signed as above) to `SLOTBACK_NOTIFY_WEBHOOK_URL` for delivery through your own platform:

```json
{ "event": "message.send", "channel": "sms", "to": "+15550104242", "subject": "…", "text": "…" }
```

## Twilio replies

Point your Twilio number's incoming-message webhook to `https://<your instance>/webhooks/twilio/sms`. Signatures are verified with your auth token. Patients can reply `YES`/`Y`/`1` or `NO`/`N`/`2` to their latest open offer; STOP/HELP are handled by Twilio.

## FHIR R4

Configured by environment (`SLOTBACK_FHIR_*`) plus per-provider ids in Settings:

- **Openings:** `GET Slot?schedule=Schedule/{fhirScheduleId}&status=free&start=ge…&start=lt…` every poll (default 120 s), 30 days ahead. Slots that stop being free are withdrawn.
- **Bookings** (`SLOTBACK_BOOKING=fhir`): `POST Appointment` with `status: booked`, participants `Patient/{externalRef}`, `Practitioner/{fhirPractitionerId}`, optional `Location/{fhirLocationId}`, and `slot` when the opening came from FHIR. `409`/`412` are treated as conflicts.
- **Cancelling the original:** `GET` then `PUT Appointment/{id}` with `status: cancelled`.
- Patients or providers without FHIR ids fall back to a front-desk task, so nothing is ever lost.
