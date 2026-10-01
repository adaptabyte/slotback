import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../../src/server/config.ts';
import { App } from '../../src/server/runtime.ts';
import { createHttpServer } from '../../src/server/server.ts';
import { hashPassword } from '../../src/server/crypto.ts';
import { DEFAULT_PRACTICE } from '../../src/server/practice.ts';
import type { PracticeSettings } from '../../src/server/practice.ts';

export function testApp(env: Record<string, string> = {}): App {
  const config = loadConfig({ SLOTBACK_ENV: 'test', SLOTBACK_PUBLIC_URL: 'http://localhost', ...env });
  const app = new App(config, { log: () => {} });
  const practice: PracticeSettings = {
    ...DEFAULT_PRACTICE,
    name: 'Test Practice',
    messageName: 'Test Practice',
    timeZone: 'America/New_York',
    engine: { ...DEFAULT_PRACTICE.engine, offers: { ...DEFAULT_PRACTICE.engine.offers, quietHours: undefined } },
    providers: [
      { id: 'dr_a', name: 'Dr. A', defaultModality: 'in_person', active: true, hl7Id: 'DRA' },
      { id: 'dr_b', name: 'Dr. B', defaultModality: 'telehealth', active: true },
    ],
  };
  const errors = app.savePractice(practice, { type: 'system' });
  if (errors.length) throw new Error(errors.join('; '));
  return app;
}

export function addStaff(app: App, username = 'frontdesk', password = 'correct horse battery staple', role: 'admin' | 'staff' = 'admin') {
  const user = app.db.createUser(username, username, role);
  user.passwordHash = hashPassword(password);
  app.db.updateUser(user);
  return { user, password };
}

export class Client {
  base: string;
  cookies = new Map<string, string>();
  constructor(base: string) {
    this.base = base;
  }
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(this.base + path, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    return res;
  }
  form(path: string, data: Record<string, string | string[]>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.request(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  async csrf(path = '/staff'): Promise<string> {
    const html = await (await this.request(path)).text();
    const m = /name="csrf" value="([^"]+)"/.exec(html);
    if (!m) throw new Error(`No CSRF token on ${path}`);
    return m[1];
  }
}

export async function listen(app: App): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
