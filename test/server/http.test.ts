import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { localToInstant, toLocal, addDays } from '../../src/core/index.ts';
import { Client, addStaff, listen, testApp } from './helpers.ts';

const app = testApp();
const { user, password } = addStaff(app);
const { server, base } = await listen(app);
after(() => {
  server.close();
  app.stop();
});

/** A weekday at least 3 days out, as local YYYY-MM-DD. */
function futureWeekday(minDays = 3): string {
  let d = addDays(toLocal(new Date(), 'America/New_York').date, minDays);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

const availability = ['1:morning', '2:morning', '3:morning', '4:morning', '5:morning', '1:afternoon', '2:afternoon', '3:afternoon', '4:afternoon', '5:afternoon'];

test('every response carries strict security headers', async () => {
  const res = await fetch(`${base}/join`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('staff pages require sign-in; forms require the CSRF token', async () => {
  const anon = new Client(base);
  const r = await anon.request('/staff/waitlist');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location') ?? '', /^\/staff\/login/);

  const c = new Client(base);
  const bad = await c.form('/staff/login', { username: user.username, password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await c.form('/staff/login', { username: user.username, password });
  assert.equal(ok.status, 303);
  assert.equal((await c.request('/staff/waitlist')).status, 200);
  const noCsrf = await c.form('/staff/openings', { providerId: 'dr_a', date: futureWeekday(), time: '10:00', duration: '30', modality: 'in_person' });
  assert.equal(noCsrf.status, 403);
});

test('end to end: patient requests → staff approves → opening → offer by text → accept → front desk books → confirmation', async () => {
  // 1. Patient joins from the public page.
  const patient = new Client(base);
  const join = await patient.form('/join', {
    firstName: 'Pat',
    lastName: 'Example',
    dob: '1990-01-01',
    phone: '555-010-4242',
    preferredChannel: 'sms',
    smsConsent: '1',
    appointmentType: 'follow_up',
    modality: ['in_person', 'telehealth'],
    slot: availability,
    minNotice: '60',
    bookingMode: 'confirm',
  });
  assert.equal(join.status, 303);
  const manage = join.headers.get('location')!;
  assert.match(manage, /^\/m\/[\w-]+\?welcome=1$/);
  assert.match(await (await patient.request(manage)).text(), /review your request/);

  // 2. Staff approves with an acuity.
  const staff = new Client(base);
  await staff.form('/staff/login', { username: user.username, password });
  const csrf = await staff.csrf('/staff/requests');
  const entry = app.store.listEntries({ status: 'pending_review' })[0];
  const approve = await staff.form(`/staff/entries/${entry.id}/approve`, { csrf, action: 'approve', acuity: '4', externalRef: 'MRN-1' });
  assert.equal(approve.status, 303);
  assert.equal(app.store.getEntry(entry.id)!.status, 'active');
  assert.equal(app.store.getEntry(entry.id)!.acuity, 4);

  // 3. A slot opens (posted by staff); the patient is offered it by text.
  const date = futureWeekday();
  const post = await staff.form('/staff/openings', { csrf, providerId: 'dr_a', date, time: '10:00', duration: '30', modality: 'in_person' });
  assert.equal(post.status, 303);
  await app.processOutbox();
  const text = app.devInbox!.inbox.find((m) => m.to === '+15550104242')!;
  assert.ok(text, 'offer text sent');
  assert.match(text.text, /earlier appointment opened up/);
  const offerPath = new URL(/https?:\/\/\S+/.exec(text.text)![0]).pathname;

  // 4. Patient accepts through the secure link.
  const page = await (await patient.request(offerPath)).text();
  assert.match(page, /Yes, book me/);
  const accept = await patient.form(offerPath, { action: 'accept' });
  assert.match(await accept.text(), /You're booked/);
  await app.processOutbox();

  // 5. Manual adapter: front desk confirms it is in the EHR → patient gets confirmation.
  const task = app.db.listTasks('open').find((t) => t.kind === 'book')!;
  assert.ok(task);
  const done = await staff.form(`/staff/tasks/${task.id}`, { csrf, result: 'done', externalId: 'EHR-77' });
  assert.equal(done.status, 303);
  await app.processOutbox();
  assert.equal(app.store.getEntry(entry.id)!.status, 'booked');
  const confirmation = app.devInbox!.inbox.find((m) => m.to === '+15550104242' && /confirmed/.test(m.text));
  assert.ok(confirmation, 'confirmation text sent');
  assert.equal(app.audit.verify().ok, true);
});

test('integration API: API key auth, openings, HL7 SIU', async () => {
  const unauth = await fetch(`${base}/api/v1/openings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);

  const { key } = app.db.createApiKey('test-engine');
  const date = futureWeekday(5);
  const start = localToInstant(date, '09:00', 'America/New_York');
  const body = { providerId: 'dr_b', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), modality: 'telehealth', externalId: 'X-1' };
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const created = await fetch(`${base}/api/v1/openings`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  const again = await fetch(`${base}/api/v1/openings`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  const invalid = await fetch(`${base}/api/v1/openings`, { method: 'POST', headers, body: JSON.stringify({ ...body, start: '2026-10-07 09:00' }) });
  assert.equal(invalid.status, 422);

  const hl7Date = futureWeekday(6).replace(/-/g, '');
  const siu = [
    'MSH|^~\\&|EHR|C|SB|C|20261001120000||SIU^S15|M42|P|2.5',
    `SCH||FL-9|||||||||^^30^${hl7Date}1300^${hl7Date}1330`,
    'AIP|1||DRA',
  ].join('\r');
  const ack = await fetch(`${base}/api/v1/hl7`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' }, body: siu });
  assert.match(await ack.text(), /MSA\|AA\|M42/);
  assert.ok(app.store.listOpenings().some((o) => o.source === 'hl7' && o.externalId === 'FL-9'));
});

test('cascade openings are not imported twice when the EHR later reports the same cancellation', () => {
  const ids = app.store.listOpenings().length;
  const date = futureWeekday(10);
  const start = localToInstant(date, '15:00', 'America/New_York');
  const now = new Date();
  // Simulate an opening that our own move-up freed.
  const { opening } = app.run({ type: 'system' }, (e) =>
    e.createOpening({ providerId: 'dr_a', modality: 'in_person', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), source: 'cascade', origin: { kind: 'moved_up' }, chainDepth: 1 }, now),
  );
  app.run({ type: 'system' }, (e) => e.withdrawOpening(opening.id, now));
  app.store.saveOpening({ ...app.store.getOpening(opening.id)!, status: 'filled' });
  const dup = app.ingestFreedSlot({ type: 'integration' }, { providerId: 'dr_a', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), source: 'ical:dr_a' });
  assert.equal(dup.duplicate, true);
  assert.equal(app.store.listOpenings().length, ids + 1);
});
