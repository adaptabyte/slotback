import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Vault, base32Encode, totpCode, verifyTotp, hashPassword, verifyPassword } from '../../src/server/crypto.ts';
import { loadConfig, ConfigError } from '../../src/server/config.ts';
import { testApp } from './helpers.ts';

test('vault: AES-256-GCM round trip, row binding and tamper detection', () => {
  const v = new Vault(randomBytes(32));
  const ct = v.encrypt('Jane Doe 555-0100', 'patients:pat_1');
  assert.equal(v.decrypt(ct, 'patients:pat_1'), 'Jane Doe 555-0100');
  assert.notEqual(v.encrypt('same', 'x'), v.encrypt('same', 'x'), 'random IV per encryption');
  assert.throws(() => v.decrypt(ct, 'patients:pat_2'), 'ciphertext cannot be moved to another row');
  const tampered = ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => v.decrypt(tampered, 'patients:pat_1'));
  assert.equal(v.blindIndex('phone:+15550100'), v.blindIndex('phone:+15550100'));
  assert.notEqual(new Vault(randomBytes(32)).blindIndex('phone:+15550100'), v.blindIndex('phone:+15550100'));
});

test('TOTP matches the RFC 6238 reference vector', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1_111_111_109_000), '081804');
  assert.ok(verifyTotp(secret, '287082', 59_000));
  assert.ok(!verifyTotp(secret, '287083', 59_000));
});

test('passwords are salted scrypt hashes', () => {
  const h = hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('correct horse battery staple', h));
  assert.ok(!verifyPassword('correct horse battery stapler', h));
});

test('production config refuses insecure setups', () => {
  assert.throws(() => loadConfig({ SLOTBACK_ENV: 'production', SLOTBACK_PUBLIC_URL: 'https://x.example' }), ConfigError);
  const key = randomBytes(32).toString('base64');
  assert.throws(() => loadConfig({ SLOTBACK_ENCRYPTION_KEY: key, SLOTBACK_PUBLIC_URL: 'http://x.example' }), /https/);
  assert.throws(() => loadConfig({ SLOTBACK_ENCRYPTION_KEY: key, SLOTBACK_PUBLIC_URL: 'https://x.example', SLOTBACK_SMS: 'console' }), /Console/);
  const ok = loadConfig({ SLOTBACK_ENCRYPTION_KEY: key, SLOTBACK_PUBLIC_URL: 'https://x.example' });
  assert.equal(ok.requireMfa, true);
  assert.equal(ok.sessionIdleMinutes, 15);
});

test('patient identifiers are never stored in plaintext', () => {
  const app = testApp();
  app.db.insertPatient({
    firstName: 'Zebulon',
    lastName: 'Quixotefield',
    dob: '1980-02-03',
    phone: '+15550109999',
    email: 'zq@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const dump = JSON.stringify(app.db.sql.prepare('SELECT * FROM patients').all());
  for (const needle of ['Zebulon', 'Quixotefield', '1980-02-03', '5550109999', 'zq@example.com']) {
    assert.ok(!dump.includes(needle), `${needle} leaked into the database`);
  }
  assert.equal(app.db.findPatientIdsByPhone('(555) 010-9999').length, 1, 'blind index still finds the patient');
});

test('audit log is append-only and its hash chain detects tampering', () => {
  const app = testApp();
  app.audit.record({ type: 'user', id: 'u1' }, 'patient.viewed', { type: 'entry', id: 'e1' });
  app.audit.record({ type: 'user', id: 'u1' }, 'patient.updated', { type: 'patient', id: 'p1' });
  assert.deepEqual(app.audit.verify(), { ok: true, count: 3 }); // + settings.updated from testApp
  assert.throws(() => app.db.sql.exec("UPDATE audit_log SET action = 'x' WHERE seq = 2"), /append-only/);
  assert.throws(() => app.db.sql.exec('DELETE FROM audit_log'), /append-only/);
  // Even someone with raw database access who drops the triggers is caught by the chain.
  app.db.sql.exec('DROP TRIGGER audit_no_update');
  app.db.sql.exec("UPDATE audit_log SET actor_id = 'someone-else' WHERE seq = 2");
  assert.deepEqual(app.audit.verify(), { ok: false, brokenAt: 2 });
});
