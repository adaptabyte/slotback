# Slotback

**Cancelled appointments, filled automatically.** Slotback is a HIPAA-ready waitlist and cancellation-backfill system for medical and psychiatric practices. Patients join a waitlist and mark the times they can make. Clinicians prioritize them by acuity. When a slot opens in any EHR or calendar, Slotback books the right patient (or offers it with a hold), writes the booking back, and texts them. If that patient was moving up from a later appointment, their old slot is re-offered automatically.

- **Website & live demo:** `site/` (deployed to GitHub Pages by `.github/workflows/pages.yml`). The demo runs the real engine in the browser with synthetic patients.
- **Application:** `src/server/`, a self-contained Node.js app with an encrypted SQLite database.
- **Engine:** `src/core/`, deterministic, explainable matching shared by the app and the demo.

## Why it exists

| | Typical EHR waitlist | Enterprise patient-access platforms | Slotback |
|---|---|---|---|
| Works across EHRs and calendars | No | Per-vendor integrations | iCal, FHIR R4, HL7 v2, REST, or manual |
| Prioritization | First come, first served | Rules, varies | Clinician acuity + explainable score, pin, adjust |
| Fills without staff | Notifies only | Yes | Auto-book or offer-and-hold, chain re-offer |
| Price | Bundled with that EHR | Quote only | Free self-hosted; $49/provider hosted |

## Try it locally (synthetic data)

Requires Node.js 22.18 or newer.

```bash
npm install
npm run demo
```

Open <http://localhost:8080/staff> and sign in as `demo` / `demo-password-2026`. Post an opening under **Openings** and watch the pipeline: patients' texts appear under **Demo phone** (their links work), front-desk tasks under **Tasks**. The patient waitlist form is at <http://localhost:8080/join>.

To preview the website and in-browser demo:

```bash
npm run build:site
cd _site && python3 -m http.server 8000   # http://localhost:8000
```

## Deploy (production)

```bash
cp .env.example .env
# set SLOTBACK_DOMAIN and SLOTBACK_ENCRYPTION_KEY (npm run cli -- gen-key)
docker compose up -d
docker compose exec app node src/server/cli.ts create-user admin --role admin
```

Caddy obtains TLS certificates automatically. Open the printed link to set a password and enroll two-factor, then configure providers, visit types and connections under **Settings**. See `.env.example` for texting (Twilio), email (SMTP), FHIR and webhook settings, and [the setup guide](site/implementation.html) for every connection option.

## How matching works

1. **Eligibility:** provider, visit type, slot length, in-person/telehealth, location, notice needed, weekly availability (DST-safe), blackout dates, and for patients who already have an appointment, whether the slot is at least a day sooner.
2. **Priority:** acuity (50 pts per level, enough to outweigh everything else combined), time waiting, having no appointment yet, days saved, past declines, provider adjustment, pin. Every score shows its breakdown.
3. **Action:** auto-book patients are booked immediately; others get an offer held for 30 minutes. Slots within 24 hours go to the top 3 at once, first to accept wins. Quiet hours hold messages overnight.
4. **Cascade:** declines and expiries move to the next patient; a patient moving up frees their old slot, which is filled the same way.

Details: [docs/architecture.md](docs/architecture.md).

## Integrations

| Openings from | Bookings to | Messages via |
|---|---|---|
| iCal feeds (Google, Microsoft 365, Apple, EHR calendar sync), FHIR R4 `Slot`, HL7 v2 `SIU`, `POST /api/v1/openings`, staff | FHIR R4 `Appointment`, signed webhook, or a one-click front-desk task | Twilio SMS (with YES/NO replies), SMTP over TLS, or webhook |

API reference: [docs/api.md](docs/api.md).

## Security & HIPAA

Field-level AES-256-GCM encryption, hash-chained append-only audit log, TOTP two-factor, 15-minute automatic logoff, account lockout, strict CSP, HTTPS-only production config, minimal-disclosure messaging, automatic identifier purge. Mapped to the HIPAA Security Rule in [docs/security-controls.md](docs/security-controls.md).

## Development

```bash
npm test            # engine, security controls, adapters, HTTP end-to-end
npm run typecheck
npm run build:site
npm run dev         # server with auto-reload (development mode)
npm run cli -- help # admin CLI: create-user, setup-link, api-key, audit-verify, poll
```

TypeScript runs directly on Node's built-in type stripping, with no build step for the server.

```
src/core/        matching engine (no I/O): types, time zones, availability, priority, matcher, engine, store
src/server/      config, crypto, db, audit, auth, http, html views, routes/, adapters/ (ical, fhir, hl7, booking, notify)
site/            marketing pages, live demo, fonts (self-hosted), build partials
scripts/         build-site.mjs
test/            node:test suites
docs/            architecture, API, security controls, launch checklist
```

## Before launch

See [docs/launch-checklist.md](docs/launch-checklist.md) for the owner-only steps: domain, search indexing, BAA, pricing confirmation and license.
