import type { App } from './runtime.ts';
import type { Ctx, Handler } from './http.ts';
import { HttpError, readForm, redirect, setCookie } from './http.ts';
import type { Role, SessionRecord, UserRecord } from './db.ts';
import { safeEqual, sha256 } from './crypto.ts';
import type { Actor } from './audit.ts';

export interface StaffAuth {
  user: UserRecord;
  session: SessionRecord;
}

export function secureCookies(app: App): boolean {
  return app.config.publicUrl.startsWith('https://');
}

export function sessionCookieName(app: App): string {
  // __Host- cookies must be Secure, Path=/ and host-only: the browser enforces it.
  return secureCookies(app) ? '__Host-sb_session' : 'sb_session';
}

export function staffActor(ctx: Ctx): Actor {
  const auth = ctx.state.auth as StaffAuth | undefined;
  return { type: 'user', id: auth?.user.id, ip: ctx.ip };
}

export function auth(ctx: Ctx): StaffAuth {
  const a = ctx.state.auth as StaffAuth | undefined;
  if (!a) throw new HttpError(401, 'Not signed in');
  return a;
}

/** Resolves the session cookie, enforcing absolute expiry and the idle timeout (automatic logoff). */
export function loadSession(app: App, ctx: Ctx): StaffAuth | undefined {
  const token = ctx.cookies[sessionCookieName(app)];
  if (!token) return undefined;
  const session = app.db.getSession(token);
  if (!session) return undefined;
  const now = Date.now();
  const idleLimit = Date.parse(session.lastSeenAt) + app.config.sessionIdleMinutes * 60000;
  if (Date.parse(session.expiresAt) <= now || idleLimit <= now) {
    app.db.deleteSession(session.tokenHash);
    app.audit.record({ type: 'user', id: session.userId, ip: ctx.ip }, 'auth.session_timeout');
    return undefined;
  }
  const user = app.db.getUser(session.userId);
  if (!user || user.disabled) {
    app.db.deleteSession(session.tokenHash);
    return undefined;
  }
  if (now - Date.parse(session.lastSeenAt) > 30000) {
    app.db.touchSession(session.tokenHash, { lastSeenAt: new Date(now).toISOString() });
  }
  return { user, session };
}

export function startSession(app: App, ctx: Ctx, user: UserRecord, mfaPassed: boolean) {
  const { token } = app.db.createSession(user.id, ctx.ip, app.config.sessionMaxHours, mfaPassed);
  setCookie(ctx, sessionCookieName(app), token, { secure: secureCookies(app), maxAge: app.config.sessionMaxHours * 3600 });
}

export function endSession(app: App, ctx: Ctx) {
  const token = ctx.cookies[sessionCookieName(app)];
  if (token) app.db.deleteSession(sha256(token));
  setCookie(ctx, sessionCookieName(app), '', { secure: secureCookies(app), maxAge: 0 });
}

/** Guards staff routes: signed in, second factor done (or enrolled when required), allowed role. */
export function requireStaff(app: App, roles?: Role[]): Handler {
  return (ctx) => {
    const a = loadSession(app, ctx);
    if (!a) {
      const next = ctx.method === 'GET' ? `?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}` : '';
      redirect(ctx, `/staff/login${next}`);
      return false;
    }
    ctx.state.auth = a;
    if (!a.session.mfaPassed) {
      redirect(ctx, a.user.mfaEnabled ? '/staff/mfa' : '/staff/mfa/setup');
      return false;
    }
    if (roles && !roles.includes(a.user.role)) throw new HttpError(403, 'You do not have access to this page');
    return true;
  };
}

/** Double-submit check against the per-session CSRF token (in addition to SameSite=Strict cookies). */
export function requireCsrf(): Handler {
  return async (ctx) => {
    const a = ctx.state.auth as StaffAuth | undefined;
    const form = await readForm(ctx);
    if (!a || !safeEqual(form.get('csrf') ?? '', a.session.csrf)) throw new HttpError(403, 'Form expired. Go back, reload the page and try again.');
    return true;
  };
}
