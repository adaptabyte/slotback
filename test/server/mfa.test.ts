import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { totpCode } from '../../src/server/crypto.ts';
import { Client, addStaff, listen, testApp } from './helpers.ts';

const app = testApp({ SLOTBACK_REQUIRE_MFA: 'true' });
const { user, password } = addStaff(app, 'mfa-user');
const { server, base } = await listen(app);
after(() => server.close());

test('two-factor: enrollment is forced, then required at every sign-in', async () => {
  const c = new Client(base);
  const login = await c.form('/staff/login', { username: user.username, password });
  assert.equal(login.headers.get('location'), '/staff/mfa/setup');
  // Nothing behind the login is reachable before the second factor.
  const blocked = await c.request('/staff/waitlist');
  assert.equal(blocked.headers.get('location'), '/staff/mfa/setup');

  const setup = await (await c.request('/staff/mfa/setup')).text();
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(setup)![1].replace(/ /g, '');
  const wrong = await c.form('/staff/mfa/setup', { code: '000000' });
  assert.equal(wrong.status, 200);
  const enrolled = await c.form('/staff/mfa/setup', { code: totpCode(secret) });
  assert.equal(enrolled.headers.get('location'), '/staff?ok=mfa_on');
  assert.equal((await c.request('/staff/waitlist')).status, 200);

  const again = new Client(base);
  const second = await again.form('/staff/login', { username: user.username, password });
  assert.equal(second.headers.get('location'), '/staff/mfa');
  assert.equal((await again.form('/staff/mfa', { code: '123456' })).status, 401);
  const ok = await again.form('/staff/mfa', { code: totpCode(secret) });
  assert.equal(ok.headers.get('location'), '/staff');
  const actions = app.audit.list({ limit: 50 }).map((r) => r.action);
  for (const a of ['auth.login', 'auth.mfa_enrolled', 'auth.mfa_failed', 'auth.mfa_passed']) assert.ok(actions.includes(a), a);
});

test('accounts lock after five wrong passwords', async () => {
  const { user: u } = addStaff(app, 'locky');
  const c = new Client(base);
  for (let i = 0; i < 5; i++) await c.form('/staff/login', { username: u.username, password: 'wrong password!!' });
  assert.ok(app.db.getUser(u.id)!.lockedUntil, 'locked');
  const res = await c.form('/staff/login', { username: u.username, password: 'correct horse battery staple' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /locked|Too many/);
});
