# Security controls description

Practices can attach this document to their HIPAA risk analysis. It describes what the Slotback software does; the hosted service's operational controls are described in the Business Associate Agreement packet.

## Data inventory

| Data | Where | Protection |
|---|---|---|
| Patient name, DOB, phone, email, EHR id, staff note | `patients` table | AES-256-GCM per row, row-bound AAD; phone/email searchable only via HMAC-SHA256 blind index |
| Waitlist entry (availability, visit type, acuity, current appointment) | `entries` table | AES-256-GCM per row |
| Openings, offers, bookings | respective tables | Contain ids and times only |
| Practice settings (incl. calendar feed URLs) | `settings` | AES-256-GCM |
| Calendar/FHIR polling state | `source_state` | AES-256-GCM; event titles are never stored |
| Staff TOTP secrets | `users.totp_enc` | AES-256-GCM |
| Passwords | `users.password_hash` | scrypt (N=2^15, r=8, p=1), 16-byte salt |
| Sessions, API keys, patient link tokens | respective tables | SHA-256 hashes only |
| Audit log | `audit_log` | Append-only (DB triggers), SHA-256 hash chain; ids only, no names |

Encryption keys are derived with HKDF-SHA256 from one 32-byte master key supplied via `SLOTBACK_ENCRYPTION_KEY`. The key never touches the database or logs.

## HIPAA Security Rule — technical safeguards (45 CFR 164.312)

| Standard | Implementation |
|---|---|
| (a)(1) Access control | Role-based staff accounts (admin, staff, provider); admin-only settings, users, API keys and audit log. Patients access only their own offer/manage pages through unguessable, expiring, single-purpose links. |
| (a)(2)(i) Unique user identification | Named accounts created by invitation; no shared or default accounts. |
| (a)(2)(ii) Emergency access procedure | Practice procedure. Supported by: CLI can issue a new setup link for any account (`npm run cli -- setup-link <user>`); database backups plus the key restore full access. |
| (a)(2)(iii) Automatic logoff | 15-minute idle timeout, 12-hour absolute session lifetime (configurable). |
| (a)(2)(iv) Encryption and decryption | As in the data inventory. |
| (b) Audit controls | Every sign-in (success and failure), MFA event, patient record view, waitlist view, change, automated decision, message, integration call and setting change. Integrity verifiable in the UI and via `npm run cli -- audit-verify`. |
| (c)(1) Integrity | GCM authentication tags on all encrypted data; transactional writes; hash-chained audit. |
| (d) Person or entity authentication | Passwords ≥ 12 chars, TOTP MFA (required in production by default), lockout for 15 min after 5 failures, per-IP and per-user rate limits; API keys for systems; Twilio request signatures verified. |
| (e)(1) Transmission security | Production refuses non-HTTPS public URL and integration endpoints; HSTS; SMTP requires TLS; outgoing webhooks HMAC-signed. |

## Application hardening

- Strict Content-Security-Policy (`script-src 'self'`, no inline script), `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer` (link tokens never leak), `Cache-Control: no-store` on every page.
- All HTML output is escaped by default (tagged templates); forms use per-session CSRF tokens plus `SameSite=Strict`, `HttpOnly`, `Secure`, `__Host-` cookies.
- Request bodies capped at 512 KB; public form has a honeypot and rate limit.
- FHIR paging follows links only on the configured server, so bearer tokens are never sent elsewhere.
- No third-party scripts, fonts, analytics or trackers on any page served by the application.
- Console notification mode and demo data are refused in production.

## Minimum necessary

- The matching engine has no access to identifiers.
- No diagnoses or clinical notes are collected; acuity is an integer 1–5.
- "Minimal" message mode sends no visit details by text/email.
- EHR write-back sends only the EHR patient id (FHIR) or id, name and DOB (webhook) needed to locate the chart.

## Retention and disposal

- Identifiers of patients whose entries are booked or removed are irreversibly replaced after `SLOTBACK_RETENTION_DAYS` (default 90); SQLite `secure_delete` overwrites freed pages.
- Waitlist requests expire after the practice's configured period (default 90 days).
- Sessions, link tokens and completed outbox items are deleted when expired.
- The audit log is never deleted by the application.

## Operator checklist (self-hosted)

- [ ] Host on HIPAA-eligible infrastructure with a BAA; full-disk encryption on.
- [ ] `SLOTBACK_ENCRYPTION_KEY` in a secrets manager; backed up separately from data.
- [ ] Encrypted, access-controlled backups of the `data` volume; restore tested.
- [ ] TLS terminated by the bundled Caddy (or equivalent) with access logs off or scrubbed of URLs.
- [ ] BAAs with your SMS (e.g. Twilio) and email providers.
- [ ] OS and container image updated regularly; `npm audit` clean.
- [ ] Staff accounts reviewed quarterly; departed staff disabled the same day.
- [ ] Audit chain verified periodically (`audit-verify`).

## Automated test coverage

`npm test` includes tests that: confirm identifiers are absent from the raw database; ciphertexts cannot be moved between rows or altered; the audit log rejects edits and detects tampering after triggers are dropped; TOTP matches the RFC 6238 vectors; MFA enrollment is forced; accounts lock after repeated failures; staff pages require authentication and CSRF tokens; security headers are present; production configuration refuses insecure settings; and minimal-mode messages contain no visit details.
