import { describeWindows, formatSlot, localToInstant, scoreEntry } from '../../core/index.ts';
import type { Acuity, Opening, WaitlistEntry } from '../../core/index.ts';
import type { App } from '../runtime.ts';
import { MODALITY_LABEL } from '../runtime.ts';
import type { Ctx, Router } from '../http.ts';
import { HttpError, RateLimiter, readForm, redirect, sendHtml } from '../http.ts';
import { html, layout, csrfField } from '../html.ts';
import type { SafeHtml } from '../html.ts';
import { auth, endSession, loadSession, requireCsrf, requireStaff, staffActor, startSession } from '../auth.ts';
import { hashPassword, newTotpSecret, passwordProblems, totpUri, verifyPassword, verifyTotp } from '../crypto.ts';
import type { PatientRecord, Role, UserRecord } from '../db.ts';
import { locationName, providerName, typeName } from '../practice.ts';
import type { PracticeSettings } from '../practice.ts';
import {
  ACUITY_LABEL,
  STATUS_LABEL,
  entryFormFields,
  fullName,
  parseEntryForm,
  rankingFields,
  relativeTime,
  shortDateTime,
  statusBadge,
} from '../views.ts';
import type { AuditRecord } from '../audit.ts';

const FLASH: Record<string, string> = {
  saved: 'Saved.',
  added: 'Patient added to the waitlist.',
  approved: 'Request approved — the patient is now on the waitlist.',
  posted: 'Opening posted. Matching has started.',
  duplicate: 'That opening is already being filled.',
  withdrawn: 'Opening withdrawn.',
  task_done: 'Task completed.',
  password_set: 'Password set. Sign in to continue.',
  mfa_on: 'Two-factor authentication is on.',
  signed_out: 'You have been signed out.',
  timeout: 'Your session ended after inactivity.',
  key_revoked: 'API key revoked.',
};

export function staffRoutes(router: Router, app: App) {
  const staff = requireStaff(app);
  const admin = requireStaff(app, ['admin']);
  const csrf = requireCsrf();
  const loginLimiter = new RateLimiter(10, 5 * 60000);
  const dev = app.config.env !== 'production';

  function nav(ctx: Ctx, active: string) {
    const a = auth(ctx);
    const pending = app.store.listEntries({ status: 'pending_review' }).length;
    const tasks = app.db.listTasks('open').length + app.store.listOpenings({ status: 'needs_attention' }).length;
    const items = [
      { href: '/staff', label: 'Today', key: 'home' },
      { href: '/staff/waitlist', label: 'Waitlist', key: 'waitlist' },
      { href: '/staff/requests', label: 'Requests', key: 'requests', badge: pending },
      { href: '/staff/openings', label: 'Openings', key: 'openings' },
      { href: '/staff/tasks', label: 'Tasks', key: 'tasks', badge: tasks },
    ];
    if (a.user.role === 'admin') {
      items.push({ href: '/staff/settings', label: 'Settings', key: 'settings' }, { href: '/staff/audit', label: 'Audit log', key: 'audit' });
    }
    if (dev && app.devInbox) items.push({ href: '/dev/phone', label: 'Demo phone', key: 'phone' });
    return items.map((i) => ({ ...i, active: i.key === active }));
  }

  function page(ctx: Ctx, title: string, body: SafeHtml, active = '', status?: number) {
    const a = auth(ctx);
    const code = ctx.url.searchParams.get('ok');
    const err = ctx.state.error as string | undefined;
    sendHtml(
      ctx,
      layout({
        title,
        body,
        nav: nav(ctx, active),
        user: { displayName: a.user.displayName, role: a.user.role },
        csrf: a.session.csrf,
        practiceName: app.practice().name,
        flash: err ? { kind: 'error', text: err } : code && FLASH[code] ? { kind: 'ok', text: FLASH[code] } : undefined,
        devBanner: dev,
      }),
      status,
    );
  }

  function publicPage(ctx: Ctx, title: string, body: SafeHtml, flash?: { kind: 'ok' | 'error' | 'info'; text: string }) {
    const code = ctx.url.searchParams.get('ok');
    sendHtml(
      ctx,
      layout({
        title,
        body,
        narrow: true,
        practiceName: app.practice().name,
        flash: flash ?? (code && FLASH[code] ? { kind: 'info', text: FLASH[code] } : undefined),
        devBanner: dev,
      }),
    );
  }

  const patients = new Map<string, PatientRecord | undefined>();
  function patientOf(patientId: string): PatientRecord | undefined {
    if (!patients.has(patientId)) patients.set(patientId, app.db.getPatient(patientId));
    return patients.get(patientId);
  }
  function nameOfEntry(entryId: string | undefined): string {
    if (!entryId) return '';
    const e = app.store.getEntry(entryId);
    return e ? fullName(patientOf(e.patientId)) : 'a patient';
  }
  function freshCache() {
    patients.clear();
  }

  // ------------------------------------------------------------------ login

  const loginPage = (ctx: Ctx) => {
    if (loadSession(app, ctx)?.session.mfaPassed) return redirect(ctx, '/staff');
    const none = app.db.countUsers() === 0;
    publicPage(
      ctx,
      'Sign in',
      html`<section class="card auth">
        <h1>Staff sign in</h1>
        ${none ? html`<p class="hint">No accounts exist yet. On the server run <code>npm run cli -- create-user admin --role admin</code> and open the setup link it prints.</p>` : ''}
        <form method="post" action="/staff/login${ctx.url.search}">
          <label>Username<input name="username" autocomplete="username" required autofocus></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary">Sign in</button>
        </form>
      </section>`,
      ctx.state.error ? { kind: 'error', text: String(ctx.state.error) } : undefined,
    );
  };
  router.get('/staff/login', loginPage);

  router.post('/staff/login', async (ctx) => {
    const form = await readForm(ctx);
    const username = (form.get('username') ?? '').trim();
    const fail = (msg = 'Incorrect username or password.') => {
      ctx.state.error = msg;
      ctx.res.statusCode = 401;
      return loginPage(ctx);
    };
    if (!loginLimiter.allow(`ip:${ctx.ip}`) || !loginLimiter.allow(`user:${username.toLowerCase()}`)) {
      return fail('Too many attempts. Wait a few minutes and try again.');
    }
    const user = app.db.getUserByUsername(username);
    const now = new Date();
    if (!user || user.disabled || !user.passwordHash) {
      app.audit.record({ type: 'user', ip: ctx.ip }, 'auth.login_failed', undefined, { reason: 'unknown_user' });
      return fail();
    }
    if (user.lockedUntil && user.lockedUntil > now.toISOString()) {
      app.audit.record({ type: 'user', id: user.id, ip: ctx.ip }, 'auth.login_failed', undefined, { reason: 'locked' });
      return fail('Account temporarily locked after repeated failures. Try again in 15 minutes.');
    }
    if (!verifyPassword(form.get('password') ?? '', user.passwordHash)) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= 5) {
        user.lockedUntil = new Date(now.getTime() + 15 * 60000).toISOString();
        user.failedAttempts = 0;
      }
      app.db.updateUser(user);
      app.audit.record({ type: 'user', id: user.id, ip: ctx.ip }, 'auth.login_failed', undefined, { reason: 'password' });
      return fail();
    }
    user.failedAttempts = 0;
    user.lockedUntil = undefined;
    app.db.updateUser(user);
    const mfaPassed = !user.mfaEnabled && !app.config.requireMfa;
    startSession(app, ctx, user, mfaPassed);
    app.audit.record({ type: 'user', id: user.id, ip: ctx.ip }, 'auth.login');
    const next = ctx.url.searchParams.get('next');
    const dest = next && next.startsWith('/staff') && !next.startsWith('//') ? next : '/staff';
    redirect(ctx, mfaPassed ? dest : user.mfaEnabled ? '/staff/mfa' : '/staff/mfa/setup');
  });

  function pendingAuth(ctx: Ctx) {
    const a = loadSession(app, ctx);
    if (!a) {
      redirect(ctx, '/staff/login');
      return undefined;
    }
    return a;
  }

  const mfaPage = (ctx: Ctx) => {
    const a = pendingAuth(ctx);
    if (!a) return;
    if (!a.user.mfaEnabled) return redirect(ctx, '/staff/mfa/setup');
    publicPage(
      ctx,
      'Two-factor',
      html`<section class="card auth"><h1>Enter your 6-digit code</h1>
        <form method="post"><label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required autofocus></label>
        <button class="primary">Verify</button></form></section>`,
      ctx.state.error ? { kind: 'error', text: String(ctx.state.error) } : undefined,
    );
  };
  router.get('/staff/mfa', mfaPage);

  router.post('/staff/mfa', async (ctx) => {
    const a = pendingAuth(ctx);
    if (!a) return;
    const form = await readForm(ctx);
    if (!loginLimiter.allow(`mfa:${a.user.id}`) || !a.user.totpSecret || !verifyTotp(a.user.totpSecret, form.get('code') ?? '')) {
      app.audit.record({ type: 'user', id: a.user.id, ip: ctx.ip }, 'auth.mfa_failed');
      ctx.state.error = 'That code did not work. Check the time on your phone and try again.';
      ctx.res.statusCode = 401;
      return mfaPage(ctx);
    }
    app.db.touchSession(a.session.tokenHash, { mfaPassed: true });
    app.audit.record({ type: 'user', id: a.user.id, ip: ctx.ip }, 'auth.mfa_passed');
    redirect(ctx, '/staff');
  });

  const mfaSetupPage = (ctx: Ctx) => {
    const a = pendingAuth(ctx);
    if (!a) return;
    if (a.user.mfaEnabled && !a.session.mfaPassed) return redirect(ctx, '/staff/mfa');
    if (!a.user.totpSecret || !a.user.mfaEnabled) {
      a.user.totpSecret = a.user.totpSecret ?? newTotpSecret();
      app.db.updateUser(a.user);
    }
    const secret = a.user.totpSecret!;
    publicPage(
      ctx,
      'Set up two-factor',
      html`<section class="card auth"><h1>Set up two-factor authentication</h1>
        <ol class="steps">
          <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
          <li>Add an account → <em>enter a setup key</em>:<br><code class="secret">${secret.replace(/(.{4})/g, '$1 ').trim()}</code><br>
            <small>Account: ${a.user.username} · Type: time-based</small></li>
          <li>Type the 6-digit code it shows:</li>
        </ol>
        <p class="hint">Some apps accept this link instead: <code class="wrap">${totpUri(secret, a.user.username, app.practice().name)}</code></p>
        <form method="post"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>
        <button class="primary">Turn on</button></form></section>`,
      ctx.state.error ? { kind: 'error', text: String(ctx.state.error) } : undefined,
    );
  };
  router.get('/staff/mfa/setup', mfaSetupPage);

  router.post('/staff/mfa/setup', async (ctx) => {
    const a = pendingAuth(ctx);
    if (!a) return;
    if (a.user.mfaEnabled && !a.session.mfaPassed) return redirect(ctx, '/staff/mfa');
    const form = await readForm(ctx);
    if (!a.user.totpSecret || !verifyTotp(a.user.totpSecret, form.get('code') ?? '')) {
      ctx.state.error = 'That code did not match. Try the newest code.';
      return mfaSetupPage(ctx);
    }
    a.user.mfaEnabled = true;
    app.db.updateUser(a.user);
    app.db.touchSession(a.session.tokenHash, { mfaPassed: true });
    app.audit.record({ type: 'user', id: a.user.id, ip: ctx.ip }, 'auth.mfa_enrolled');
    redirect(ctx, '/staff?ok=mfa_on');
  });

  const setupPage = (ctx: Ctx) => {
    const userId = app.db.resolveLinkToken('setup', ctx.params.token);
    const user = userId ? app.db.getUser(userId) : undefined;
    if (!user) throw new HttpError(404, 'This setup link is invalid or has expired. Ask an administrator for a new one.');
    publicPage(
      ctx,
      'Set your password',
      html`<section class="card auth"><h1>Welcome, ${user.displayName}</h1><p>Choose a password for <strong>${user.username}</strong> (12+ characters; a passphrase works well).</p>
      <form method="post"><label>New password<input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
      <label>Repeat password<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
      <button class="primary">Set password</button></form></section>`,
      ctx.state.error ? { kind: 'error', text: String(ctx.state.error) } : undefined,
    );
  };
  router.get('/staff/setup/:token', setupPage);

  router.post('/staff/setup/:token', async (ctx) => {
    const userId = app.db.resolveLinkToken('setup', ctx.params.token);
    const user = userId ? app.db.getUser(userId) : undefined;
    if (!user) throw new HttpError(404, 'This setup link is invalid or has expired.');
    const form = await readForm(ctx);
    const pw = form.get('password') ?? '';
    const problem = pw !== form.get('confirm') ? 'Passwords do not match.' : passwordProblems(pw);
    if (problem) {
      ctx.state.error = problem;
      return setupPage(ctx);
    }
    user.passwordHash = hashPassword(pw);
    user.failedAttempts = 0;
    user.lockedUntil = undefined;
    app.db.updateUser(user);
    app.db.revokeLinkTokens('setup', user.id);
    app.db.deleteUserSessions(user.id);
    app.audit.record({ type: 'user', id: user.id, ip: ctx.ip }, 'auth.password_set');
    redirect(ctx, '/staff/login?ok=password_set');
  });

  router.post('/staff/logout', staff, csrf, (ctx) => {
    app.audit.record(staffActor(ctx), 'auth.logout');
    endSession(app, ctx);
    redirect(ctx, '/staff/login?ok=signed_out');
  });

  // -------------------------------------------------------------- dashboard

  router.get('/staff', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const now = new Date();
    const live = app.store.listOpenings({ status: ['new', 'open', 'offering', 'booking', 'needs_attention'] });
    const active = app.store.listEntries({ status: ['active', 'offered', 'booking'] }).length;
    const pending = app.store.listEntries({ status: 'pending_review' }).length;
    const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
    const recent = app.store.listRecentOpenings(500).filter((o) => o.createdAt >= monthAgo);
    const filled = recent.filter((o) => o.status === 'filled');
    const resolved = recent.filter((o) => ['filled', 'expired', 'withdrawn'].includes(o.status)).length;
    const fillRate = resolved ? Math.round((filled.length / resolved) * 100) : undefined;
    const tasks = app.db.listTasks('open').length;
    const activity = app.audit
      .list({ limit: 60 })
      .filter((r) => ACTIVITY[r.action])
      .slice(0, 15);
    if (!p.providers.length && auth(ctx).user.role === 'admin') {
      ctx.state.error = 'Finish setup: add your providers under Settings → Providers & visit types.';
    }
    page(
      ctx,
      'Today',
      html`<h1>Today</h1>
      <div class="stats">
        <div class="stat"><span class="n">${active}</span><span>patients waiting</span></div>
        <div class="stat"><span class="n">${live.length}</span><span>openings in progress</span></div>
        <div class="stat"><span class="n">${filled.length}</span><span>slots filled (30 days)${fillRate !== undefined ? ` · ${fillRate}% fill rate` : ''}</span></div>
        <div class="stat ${pending + tasks ? 'warn' : ''}"><span class="n">${pending + tasks}</span><span>need staff (${pending} request${pending === 1 ? '' : 's'}, ${tasks} task${tasks === 1 ? '' : 's'})</span></div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Openings being filled</h2><a class="button" href="/staff/openings#post">Post an opening</a></div>
        ${live.length ? openingsTable(live, now) : html`<p class="empty">No open slots right now. Cancellations detected from your calendar/EHR appear here automatically.</p>`}
      </section>
      <section class="card">
        <h2>Recent activity</h2>
        ${activity.length ? html`<ul class="activity">${activity.map((r) => html`<li><time title="${r.at}">${relativeTime(r.at, now)}</time> ${ACTIVITY[r.action](r)}</li>`)}</ul>` : html`<p class="empty">Nothing yet.</p>`}
      </section>`,
      'home',
    );
  });

  const ACTIVITY: Record<string, (r: AuditRecord) => string> = {
    'opening.created': (r) => `New opening ${slotOf(r)} (${sourceLabel(String(r.details?.source ?? ''))}).`,
    'offer.sent': (r) => `Offered ${slotOf(r)} to ${nameOfEntry(r.details?.entryId as string)} (rank #${r.details?.rank}).`,
    'offer.auto_accepted': (r) => `Auto-booking ${nameOfEntry(r.details?.entryId as string)} into ${slotOf(r)} (rank #1).`,
    'offer.accepted': (r) => `${nameOfEntry(r.details?.entryId as string)} accepted ${slotOf(r)}.`,
    'offer.declined': (r) => `${nameOfEntry(r.details?.entryId as string)} declined ${slotOf(r)}.`,
    'offer.expired': (r) => `${nameOfEntry(r.details?.entryId as string)} did not reply in time.`,
    'booking.confirmed': (r) => `Booked ${nameOfEntry(r.details?.entryId as string)} — ${slotOf(r)}.`,
    'booking.failed': (r) => `Booking failed for ${nameOfEntry(r.details?.entryId as string)} (${r.details?.reason}).`,
    'chain.freed': (r) => `${nameOfEntry(r.details?.entryId as string)} moved up; their old slot is being re-offered.`,
    'opening.expired': (r) => `${slotOf(r)} could not be filled in time.`,
    'opening.no_match': (r) => `No eligible patient yet for ${slotOf(r)}.`,
    'opening.deferred': (r) => `${slotOf(r)} will be offered when quiet hours end.`,
    'notification.undeliverable': (r) => `Could not message ${nameOfEntry(r.entityId)} — please call.`,
    'source.error': (r) => `Calendar/EHR connection problem (${r.entityId}): ${r.details?.message}`,
    'source.suspicious': (r) => `Ignored a suspicious calendar update (${r.entityId}).`,
  };

  function slotOf(r: AuditRecord): string {
    const id = (r.details?.openingId as string) ?? (r.entityType === 'opening' ? r.entityId : undefined);
    const o = id ? app.store.getOpening(id) : undefined;
    return o ? app.slotLabel(o) : 'a slot';
  }

  function sourceLabel(source: string): string {
    if (source.startsWith('ical')) return 'calendar feed';
    return ({ fhir: 'EHR (FHIR)', hl7: 'EHR (HL7)', api: 'API', manual: 'posted by staff', cascade: 'freed by a move-up' } as Record<string, string>)[source] ?? source;
  }

  function openingsTable(list: Opening[], now: Date): SafeHtml {
    const p = app.practice();
    return html`<table class="table">
      <thead><tr><th>Slot</th><th>Source</th><th>Status</th><th>Who</th><th></th></tr></thead>
      <tbody>${list.map((o) => {
        const offers = app.store.listOffers({ openingId: o.id }).filter((x) => x.status === 'pending' || x.status === 'accepted');
        const who = offers.length
          ? offers.map((x) => html`<div>${nameOfEntry(x.entryId)} <small>#${x.rank}${x.status === 'pending' ? ` · expires ${relativeTime(x.expiresAt, now)}` : ''}</small></div>`)
          : html`<small class="muted">—</small>`;
        return html`<tr>
          <td><strong>${formatSlot(o.start, p.timeZone)}</strong><br><small>${providerName(p, o.providerId)} · ${MODALITY_LABEL[o.modality]}${o.chainDepth ? ` · chain step ${o.chainDepth}` : ''}</small></td>
          <td>${sourceLabel(o.source)}</td>
          <td>${statusBadge(o.status)}</td>
          <td>${who}</td>
          <td><a href="/staff/openings/${o.id}">Details</a></td>
        </tr>`;
      })}</tbody></table>`;
  }

  // --------------------------------------------------------------- waitlist

  router.get('/staff/waitlist', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const now = new Date();
    const provider = ctx.url.searchParams.get('provider') || undefined;
    const ranked = app.engine.rankedWaitlist(now, provider);
    app.audit.record(staffActor(ctx), 'waitlist.viewed', undefined, { count: ranked.length, provider });
    page(
      ctx,
      'Waitlist',
      html`<div class="page-head"><h1>Waitlist</h1><a class="button primary" href="/staff/entries/new">Add patient</a></div>
      <form class="filters" method="get"><label>Provider<select name="provider" data-autosubmit>
        <option value="">All providers</option>${p.providers.map((x) => html`<option value="${x.id}" ${provider === x.id ? 'selected' : ''}>${x.name}</option>`)}
      </select></label><noscript><button>Filter</button></noscript></form>
      <p class="hint">Order = who gets the next matching slot. Clinical acuity carries the most weight (${p.engine.priority.acuityPoints} pts per level); pin or adjust to override. Click a score to see why.</p>
      ${
        ranked.length
          ? html`<table class="table waitlist">
        <thead><tr><th>#</th><th>Patient</th><th>Visit</th><th>Availability</th><th>Priority</th><th>Score</th><th>Status</th></tr></thead>
        <tbody>${ranked.map((c) => {
          const pt = patientOf(c.entry.patientId);
          const e = c.entry;
          return html`<tr>
            <td class="rank">${c.rank}</td>
            <td><a href="/staff/entries/${e.id}"><strong>${fullName(pt)}</strong></a><br><small>${e.currentAppointment ? `Has ${formatSlot(e.currentAppointment.start, p.timeZone)}` : 'No appointment yet'} · ${e.bookingMode === 'auto' ? 'auto-book' : 'ask first'}</small></td>
            <td>${typeName(p, e.appointmentType)}<br><small>${e.providerIds.length ? e.providerIds.map((id) => providerName(p, id)).join(', ') : 'Any provider'} · ${e.modalities.map((m) => MODALITY_LABEL[m]).join(' / ')}</small></td>
            <td><small>${describeWindows(e.availability.weekly)}</small></td>
            <td>${rankControls(ctx, e)}</td>
            <td><details class="score"><summary>${c.score.total}</summary><ul>${c.score.parts.map((x) => html`<li><span>${x.label}</span><b>${x.points > 0 ? '+' : ''}${x.points}</b></li>`)}${e.pinned ? html`<li><span>Pinned by provider</span><b>top</b></li>` : ''}</ul></details></td>
            <td>${statusBadge(e.status)}</td>
          </tr>`;
        })}</tbody></table>`
          : html`<p class="empty card">Nobody is waiting. Share your waitlist link (<code>${app.config.publicUrl}/join</code>) or add patients yourself.</p>`
      }`,
      'waitlist',
    );
  });

  function rankControls(ctx: Ctx, e: WaitlistEntry): SafeHtml {
    return html`<form method="post" action="/staff/entries/${e.id}/rank" class="inline-rank">
      ${csrfField(auth(ctx).session.csrf)}
      <input type="hidden" name="back" value="${ctx.url.pathname + ctx.url.search}">
      <select name="acuity" aria-label="Acuity" data-autosubmit>${([1, 2, 3, 4, 5] as Acuity[]).map((a) => html`<option value="${a}" ${e.acuity === a ? 'selected' : ''}>${ACUITY_LABEL[a]}</option>`)}</select>
      <input type="number" name="boost" value="${e.boost}" min="-200" max="200" aria-label="Provider adjustment" title="Provider adjustment (± points)">
      <label class="check" title="Always offer to this patient first"><input type="checkbox" name="pinned" value="1" ${e.pinned ? 'checked' : ''} data-autosubmit> Pin</label>
      <button class="small">Save</button>
    </form>`;
  }

  router.post('/staff/entries/:id/rank', staff, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const acuity = Number(form.get('acuity'));
    if (![1, 2, 3, 4, 5].includes(acuity)) throw new HttpError(400, 'Invalid acuity');
    const boost = Math.max(-200, Math.min(200, Math.round(Number(form.get('boost')) || 0)));
    app.run(staffActor(ctx), (e, now) => e.updateEntry(ctx.params.id, { acuity: acuity as Acuity, boost, pinned: form.get('pinned') === '1' }, now));
    const back = form.get('back') ?? '';
    const target = new URL(back.startsWith('/staff/waitlist') ? back : '/staff/waitlist', 'http://x');
    target.searchParams.set('ok', 'saved');
    redirect(ctx, target.pathname + target.search);
  });

  // --------------------------------------------------------------- requests

  router.get('/staff/requests', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const list = app.store.listEntries({ status: 'pending_review' });
    page(
      ctx,
      'Requests',
      html`<h1>Waitlist requests</h1>
      <p class="hint">Patients who asked to be seen sooner from your public page (<code>${app.config.publicUrl}/join</code>). Confirm they are your patient, set clinical acuity, and approve.</p>
      ${
        list.length
          ? list.map((e) => {
              const pt = patientOf(e.patientId);
              return html`<section class="card request">
              <div class="card-head"><h2>${fullName(pt)}</h2><small>Requested ${relativeTime(e.addedAt)}</small></div>
              <p><strong>DOB</strong> ${pt?.dob ?? '—'} · <strong>Phone</strong> ${pt?.phone ?? '—'} · <strong>Email</strong> ${pt?.email ?? '—'}</p>
              <p>${typeName(p, e.appointmentType)} · ${e.providerIds.length ? e.providerIds.map((id) => providerName(p, id)).join(', ') : 'any provider'} · ${e.modalities.map((m) => MODALITY_LABEL[m]).join(' / ')} · ${e.bookingMode === 'auto' ? 'auto-book' : 'ask first'}</p>
              <p><small>${describeWindows(e.availability.weekly)}${e.currentAppointment ? ` · says current appointment is ${formatSlot(e.currentAppointment.start, p.timeZone)}` : ''}</small></p>
              <form method="post" action="/staff/entries/${e.id}/approve" class="row">
                ${csrfField(auth(ctx).session.csrf)}
                <label>Acuity<select name="acuity">${([1, 2, 3, 4, 5] as Acuity[]).map((a) => html`<option value="${a}" ${a === p.defaultAcuity ? 'selected' : ''}>${ACUITY_LABEL[a]}</option>`)}</select></label>
                <label>EHR patient ID / MRN<input name="externalRef" maxlength="100"></label>
                <button class="primary" name="action" value="approve">Approve</button>
                <button name="action" value="reject" data-confirm="Remove this request?">Reject</button>
                <a href="/staff/entries/${e.id}">Edit details</a>
              </form>
            </section>`;
            })
          : html`<p class="empty card">No requests waiting.</p>`
      }`,
      'requests',
    );
  });

  router.post('/staff/entries/:id/approve', staff, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const entry = app.store.getEntry(ctx.params.id);
    if (!entry) throw new HttpError(404, 'Not found');
    if (form.get('action') === 'reject') {
      app.run(staffActor(ctx), (e, now) => e.updateEntry(entry.id, { status: 'removed' }, now));
      return redirect(ctx, '/staff/requests?ok=saved');
    }
    const acuity = Number(form.get('acuity'));
    const ref = (form.get('externalRef') ?? '').trim();
    if (ref) {
      const pt = app.db.getPatient(entry.patientId);
      if (pt) app.db.updatePatient({ ...pt, externalRef: ref });
    }
    app.run(staffActor(ctx), (e, now) =>
      e.updateEntry(entry.id, { status: 'active', acuity: ([1, 2, 3, 4, 5].includes(acuity) ? acuity : app.practice().defaultAcuity) as Acuity }, now),
    );
    redirect(ctx, '/staff/requests?ok=approved');
  });

  // ---------------------------------------------------------------- entries

  const newEntryPage = (ctx: Ctx) => {
    const p = app.practice();
    page(
      ctx,
      'Add patient',
      html`<h1>Add a patient to the waitlist</h1>
      <form method="post" action="/staff/entries" class="card form">
        ${csrfField(auth(ctx).session.csrf)}
        ${entryFormFields(p, 'staff', (ctx.state.patient as PatientRecord) ?? undefined, (ctx.state.entry as WaitlistEntry) ?? undefined)}
        ${rankingFields(p, ctx.state.entry as WaitlistEntry)}
        <button class="primary">Add to waitlist</button>
      </form>`,
      'waitlist',
    );
  };
  router.get('/staff/entries/new', staff, newEntryPage);

  router.post('/staff/entries', staff, csrf, async (ctx) => {
    const p = app.practice();
    const form = await readForm(ctx);
    const { values, errors, draft } = parseEntryForm(form, p, 'staff');
    if (!values) {
      ctx.state.error = errors.join(' ');
      ctx.state.patient = draft.patient;
      ctx.state.entry = draft.entry;
      ctx.res.statusCode = 400;
      return newEntryPage(ctx);
    }
    const entryId = app.newEntryId();
    app.db.tx(() => {
      const patient = app.db.insertPatient(values.patient);
      app.audit.record(staffActor(ctx), 'patient.created', { type: 'patient', id: patient.id });
      const entry: WaitlistEntry = { ...values.entry, id: entryId, patientId: patient.id, status: 'active', addedAt: new Date().toISOString(), declines: 0 };
      app.run(staffActor(ctx), (e, now) => e.addEntry(entry, now));
    });
    redirect(ctx, `/staff/entries/${entryId}?ok=added`);
  });

  const entryPage = (ctx: Ctx) => {
    freshCache();
    const p = app.practice();
    const entry = app.store.getEntry(ctx.params.id);
    if (!entry) throw new HttpError(404, 'Not found');
    const patient = app.db.getPatient(entry.patientId);
    app.audit.record(staffActor(ctx), 'patient.viewed', { type: 'entry', id: entry.id });
    const now = new Date();
    const score = scoreEntry(entry, p.engine.priority, now);
    const offers = app.store.listOffers({ entryId: entry.id });
    const notes = app.db.listNotifications(entry.patientId);
    const editable = !['booking', 'booked'].includes(entry.status);
    page(
      ctx,
      fullName(patient),
      html`<div class="page-head"><h1>${fullName(patient)} ${statusBadge(entry.status)}</h1>
        <form method="post" action="/staff/entries/${entry.id}/status" class="actions">
          ${csrfField(auth(ctx).session.csrf)}
          ${entry.status === 'pending_review' ? html`<button class="primary" name="status" value="active">Approve</button>` : ''}
          ${['active', 'offered'].includes(entry.status) ? html`<button name="status" value="paused">Pause</button>` : ''}
          ${entry.status === 'paused' ? html`<button name="status" value="active">Resume</button>` : ''}
          ${editable && entry.status !== 'removed' ? html`<button name="status" value="removed" data-confirm="Take this patient off the waitlist?">Remove</button>` : ''}
          ${entry.status === 'removed' ? html`<button name="status" value="active">Restore</button>` : ''}
        </form></div>
      <div class="split">
        <form method="post" action="/staff/entries/${entry.id}" class="card form">
          ${csrfField(auth(ctx).session.csrf)}
          ${entryFormFields(p, 'staff', (ctx.state.patient as PatientRecord) ?? patient, (ctx.state.entry as WaitlistEntry) ?? entry)}
          ${rankingFields(p, entry)}
          ${editable ? html`<button class="primary">Save changes</button>` : html`<p class="hint">This entry is ${STATUS_LABEL[entry.status]}; it can no longer be edited.</p>`}
        </form>
        <aside>
          <section class="card"><h2>Priority score: ${score.total}</h2>
            <ul class="breakdown">${score.parts.map((x) => html`<li><span>${x.label}</span><b>${x.points > 0 ? '+' : ''}${x.points}</b></li>`)}${entry.pinned ? html`<li><span>Pinned</span><b>top</b></li>` : ''}</ul>
            <p class="hint">Plus up to ${p.engine.priority.timeSavedPointsMax} pts per opening for how much sooner it would see them.</p></section>
          <section class="card"><h2>Offers</h2>${
            offers.length
              ? html`<ul class="plain">${offers.map((o) => {
                  const op = app.store.getOpening(o.openingId);
                  return html`<li>${op ? formatSlot(op.start, p.timeZone) : '?'} ${statusBadge(o.status)} <small>${o.mode === 'auto' ? 'auto-book' : `#${o.rank}`} · ${relativeTime(o.createdAt, now)}</small></li>`;
                })}</ul>`
              : html`<p class="empty">None yet.</p>`
          }</section>
          <section class="card"><h2>Messages</h2>${
            notes.length
              ? html`<ul class="plain">${notes.map((n) => html`<li>${n.kind.replace('_', ' ')} · ${n.channel} · ${n.status} <small>${relativeTime(n.createdAt, now)}</small></li>`)}</ul>`
              : html`<p class="empty">None sent.</p>`
          }</section>
          <section class="card"><h2>Record</h2><p><small>Added ${shortDateTime(entry.addedAt, p.timeZone)}${entry.expiresAt ? html` · expires ${shortDateTime(entry.expiresAt, p.timeZone)}` : ''}<br>Declined/missed offers: ${entry.declines}</small></p></section>
        </aside>
      </div>`,
      'waitlist',
    );
  };
  router.get('/staff/entries/:id', staff, entryPage);

  router.post('/staff/entries/:id', staff, csrf, async (ctx) => {
    const p = app.practice();
    const entry = app.store.getEntry(ctx.params.id);
    if (!entry) throw new HttpError(404, 'Not found');
    const form = await readForm(ctx);
    const { values, errors, draft } = parseEntryForm(form, p, 'staff');
    if (!values) {
      ctx.state.error = errors.join(' ');
      ctx.state.patient = draft.patient;
      ctx.state.entry = { ...entry, ...draft.entry };
      ctx.res.statusCode = 400;
      ctx.params.id = entry.id;
      return entryPage(ctx);
    }
    const patient = app.db.getPatient(entry.patientId)!;
    app.db.tx(() => {
      app.db.updatePatient({ ...patient, ...values.patient });
      app.audit.record(staffActor(ctx), 'patient.updated', { type: 'patient', id: patient.id });
      const { expiresAt: _ignored, ...rest } = values.entry;
      app.run(staffActor(ctx), (e, now) => e.updateEntry(entry.id, rest, now));
    });
    redirect(ctx, `/staff/entries/${entry.id}?ok=saved`);
  });

  router.post('/staff/entries/:id/status', staff, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const status = form.get('status');
    if (!status || !['active', 'paused', 'removed'].includes(status)) throw new HttpError(400, 'Invalid status');
    try {
      app.run(staffActor(ctx), (e, now) => e.updateEntry(ctx.params.id, { status: status as WaitlistEntry['status'] }, now));
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    redirect(ctx, `/staff/entries/${ctx.params.id}?ok=saved`);
  });

  // --------------------------------------------------------------- openings

  router.get('/staff/openings', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const now = new Date();
    const recent = app.store.listRecentOpenings(100);
    page(
      ctx,
      'Openings',
      html`<h1>Openings</h1>
      <section class="card">${recent.length ? openingsTable(recent, now) : html`<p class="empty">No openings yet.</p>`}</section>
      <section class="card" id="post">
        <h2>Post an opening</h2>
        <p class="hint">Use this when a slot opens that your calendar/EHR connection did not catch (for example a phone cancellation). Matching starts immediately.</p>
        ${
          p.providers.length
            ? html`<form method="post" action="/staff/openings" class="row">
          ${csrfField(auth(ctx).session.csrf)}
          <label>Provider<select name="providerId" required>${p.providers.filter((x) => x.active).map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></label>
          <label>Date<input type="date" name="date" required></label>
          <label>Start<input type="time" name="time" required></label>
          <label>Length (min)<input type="number" name="duration" value="60" min="5" max="480" required></label>
          <label>How<select name="modality"><option value="in_person">In person</option><option value="telehealth">Telehealth</option></select></label>
          ${p.locations.length ? html`<label>Location<select name="locationId"><option value="">—</option>${p.locations.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select></label>` : ''}
          <button class="primary">Post & start matching</button>
        </form>`
            : html`<p>Add providers in Settings first.</p>`
        }
      </section>`,
      'openings',
    );
  });

  router.post('/staff/openings', staff, csrf, async (ctx) => {
    const p = app.practice();
    const form = await readForm(ctx);
    const date = form.get('date') ?? '';
    const time = form.get('time') ?? '';
    const duration = Number(form.get('duration'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !(duration >= 5 && duration <= 480)) {
      throw new HttpError(400, 'Enter a valid date, time and length.');
    }
    const start = localToInstant(date, time, p.timeZone);
    if (start.getTime() <= Date.now()) throw new HttpError(400, 'That time has already passed.');
    const modality = form.get('modality') === 'telehealth' ? 'telehealth' : 'in_person';
    if (!p.providers.some((x) => x.id === form.get('providerId'))) throw new HttpError(400, 'Choose a provider.');
    const res = app.ingestFreedSlot(staffActor(ctx), {
      providerId: form.get('providerId') ?? '',
      start: start.toISOString(),
      end: new Date(start.getTime() + duration * 60000).toISOString(),
      source: 'manual',
      modality,
      locationId: form.get('locationId') || undefined,
    });
    redirect(ctx, `/staff/openings/${res.opening.id}?ok=${res.duplicate ? 'duplicate' : 'posted'}`);
  });

  router.get('/staff/openings/:id', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const o = app.store.getOpening(ctx.params.id);
    if (!o) throw new HttpError(404, 'Not found');
    const now = new Date();
    const offers = app.store.listOffers({ openingId: o.id });
    const bookings = app.store.listBookings().filter((b) => b.openingId === o.id);
    const ex = app.engine.explain(o.id, now);
    const offeredIds = new Set(offers.map((x) => x.entryId));
    app.audit.record(staffActor(ctx), 'opening.viewed', { type: 'opening', id: o.id });
    page(
      ctx,
      'Opening',
      html`<div class="page-head"><h1>${formatSlot(o.start, p.timeZone)} ${statusBadge(o.status)}</h1>
        ${
          ['new', 'open', 'offering', 'needs_attention'].includes(o.status)
            ? html`<form method="post" action="/staff/openings/${o.id}/withdraw">${csrfField(auth(ctx).session.csrf)}<button data-confirm="Stop offering this slot?">Withdraw</button></form>`
            : ''
        }</div>
      <p>${providerName(p, o.providerId)} · ${MODALITY_LABEL[o.modality]}${o.locationId ? ` · ${locationName(p, o.locationId)}` : ''} · ${Math.round((Date.parse(o.end) - Date.parse(o.start)) / 60000)} min · from ${sourceLabel(o.source)}${o.chainDepth ? ` · chain step ${o.chainDepth}` : ''}</p>
      ${o.status === 'needs_attention' ? html`<div class="flash error">Automatic booking failed. Book the accepted patient manually in your EHR, then resolve the task under Tasks.</div>` : ''}
      <section class="card"><h2>Offers & bookings</h2>${
        offers.length
          ? html`<table class="table"><thead><tr><th>Patient</th><th>Rank</th><th>Score</th><th>Mode</th><th>Status</th><th>Sent</th></tr></thead><tbody>${offers.map(
              (x) => html`<tr><td><a href="/staff/entries/${x.entryId}">${nameOfEntry(x.entryId)}</a></td><td>#${x.rank}</td><td>${x.score}</td><td>${x.mode === 'auto' ? 'auto-book' : 'ask first'}</td><td>${statusBadge(x.status)}${x.status === 'pending' ? html` <small>expires ${relativeTime(x.expiresAt, now)}</small>` : ''}</td><td>${relativeTime(x.createdAt, now)}</td></tr>`,
            )}</tbody></table>`
          : html`<p class="empty">No offers yet.</p>`
      }
      ${bookings.map((b) => html`<p>Booking for ${nameOfEntry(b.entryId)}: ${statusBadge(b.status)}${b.externalId ? html` · EHR id <code>${b.externalId}</code>` : ''}${b.error ? html` · <span class="muted">${b.error}</span>` : ''}</p>`)}
      </section>
      <section class="card"><h2>Who else could take it (${ex.eligible.length})</h2>
        ${
          ex.eligible.length
            ? html`<ol class="ranked">${ex.eligible.map(
                (c) => html`<li><a href="/staff/entries/${c.entry.id}">${nameOfEntry(c.entry.id)}</a> — <b>${c.score.total}</b> <small>${c.score.parts.map((x) => `${x.label} ${x.points > 0 ? '+' : ''}${x.points}`).join(' · ')}</small>${offeredIds.has(c.entry.id) ? html` <span class="badge">already offered</span>` : ''}</li>`,
              )}</ol>`
            : html`<p class="empty">Nobody else currently matches.</p>`
        }
        ${
          ex.ineligible.length
            ? html`<details><summary>Not eligible (${ex.ineligible.length})</summary><ul class="plain">${ex.ineligible.map(
                (i) => html`<li><a href="/staff/entries/${i.entry.id}">${nameOfEntry(i.entry.id)}</a>: <small>${i.reasons.map((r) => r.message).join('; ')}</small></li>`,
              )}</ul></details>`
            : ''
        }
      </section>`,
      'openings',
    );
  });

  router.post('/staff/openings/:id/withdraw', staff, csrf, (ctx) => {
    app.run(staffActor(ctx), (e, now) => e.withdrawOpening(ctx.params.id, now));
    redirect(ctx, `/staff/openings/${ctx.params.id}?ok=withdrawn`);
  });

  // ------------------------------------------------------------------ tasks

  router.get('/staff/tasks', staff, (ctx) => {
    freshCache();
    const p = app.practice();
    const tasks = app.db.listTasks('open');
    const attention = app.store.listOpenings({ status: 'needs_attention' });
    page(
      ctx,
      'Tasks',
      html`<h1>Front-desk tasks</h1>
      <p class="hint">${
        app.booking.name === 'manual'
          ? 'Slotback is in manual-booking mode: it matches and notifies, you enter the result in your EHR with one click. Connect FHIR or a webhook to automate this.'
          : 'Bookings are written to your EHR automatically. Tasks appear here only when that is not possible.'
      }</p>
      ${tasks.length ? '' : html`<p class="empty card">All caught up.</p>`}
      ${tasks.map((t) => {
        const b = app.store.getBooking(t.bookingId);
        const e = app.store.getEntry(t.entryId);
        const pt = e ? patientOf(e.patientId) : undefined;
        if (t.kind === 'book' && b) {
          return html`<section class="card task">
            <h2>Book ${fullName(pt)} → ${formatSlot(b.start, p.timeZone)}</h2>
            <p><strong>${providerName(p, b.providerId)}</strong> · ${typeName(p, b.appointmentType)} · ${Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000)} min · ${MODALITY_LABEL[b.modality]}${b.locationId ? ` · ${locationName(p, b.locationId)}` : ''}</p>
            <p><small>DOB ${pt?.dob ?? '—'} · EHR ID ${pt?.externalRef ?? '—'} · ${b.mode === 'auto' ? 'auto-booked (pre-authorized)' : 'patient accepted the offer'}${e?.currentAppointment ? ` · also cancel their ${formatSlot(e.currentAppointment.start, p.timeZone)} appointment` : ''}</small></p>
            <form method="post" action="/staff/tasks/${t.id}" class="row">
              ${csrfField(auth(ctx).session.csrf)}
              <label>EHR appointment ID <small>(optional)</small><input name="externalId" maxlength="100"></label>
              <button class="primary" name="result" value="done">Booked in EHR — notify patient</button>
              <button name="result" value="conflict" data-confirm="Slot already taken? The patient stays on the waitlist.">Slot was taken</button>
              <button name="result" value="error">Couldn't book</button>
            </form></section>`;
        }
        const appt = (t.data?.appointment ?? {}) as { start?: string; externalId?: string; providerId?: string };
        return html`<section class="card task">
          <h2>Cancel ${fullName(pt)}'s original appointment</h2>
          <p>${appt.start ? formatSlot(appt.start, p.timeZone) : ''} with ${providerName(p, appt.providerId ?? '')}${appt.externalId ? html` · EHR id <code>${appt.externalId}</code>` : ''}. They were moved to an earlier slot; the old time is already being re-offered.</p>
          <form method="post" action="/staff/tasks/${t.id}">${csrfField(auth(ctx).session.csrf)}<button class="primary" name="result" value="done">Cancelled in EHR</button></form>
        </section>`;
      })}
      ${
        attention.length
          ? html`<section class="card"><h2>Openings needing attention</h2>${openingsTable(attention, new Date())}</section>`
          : ''
      }`,
      'tasks',
    );
  });

  router.post('/staff/tasks/:id', staff, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const task = app.db.getTask(ctx.params.id);
    if (!task || task.status !== 'open') throw new HttpError(404, 'Task not found or already resolved');
    const result = form.get('result');
    const actor = staffActor(ctx);
    app.db.tx(() => {
      app.db.resolveTask(task.id, result === 'done' ? 'done' : 'failed', auth(ctx).user.id);
      app.audit.record(actor, `task.${result}`, { type: 'task', id: task.id }, { kind: task.kind, bookingId: task.bookingId });
      if (task.kind === 'book') {
        const externalId = (form.get('externalId') ?? '').trim() || undefined;
        app.run(actor, (e, now) =>
          e.bookingResult(
            task.bookingId,
            result === 'done' ? { ok: true, externalId } : { ok: false, reason: result === 'conflict' ? 'conflict' : 'error', message: 'Resolved by staff' },
            now,
          ),
        );
      }
    });
    redirect(ctx, '/staff/tasks?ok=task_done');
  });

  // --------------------------------------------------------------- settings

  const settingsPage = (ctx: Ctx) => {
    const p = (ctx.state.draft as PracticeSettings) ?? app.practice();
    const pr = p.engine.priority;
    const of = p.engine.offers;
    const num = (name: string, label: string, value: number, hint = '') =>
      html`<label>${label}${hint ? html` <small>${hint}</small>` : ''}<input type="number" name="${name}" value="${value}" step="any" required></label>`;
    const advanced = JSON.stringify(
      { providers: p.providers, locations: p.locations, appointmentTypes: p.appointmentTypes, timeBlocks: p.timeBlocks, weekdays: p.weekdays },
      null,
      2,
    );
    const c = app.config;
    page(
      ctx,
      'Settings',
      html`<h1>Settings</h1>
      <form method="post" action="/staff/settings" class="card form">
        ${csrfField(auth(ctx).session.csrf)}
        <h2>Practice</h2>
        <div class="row">
          <label>Practice name<input name="name" value="${p.name}" required maxlength="120"></label>
          <label>Name in texts/emails <small>(can be neutral)</small><input name="messageName" value="${p.messageName}" required maxlength="60"></label>
          <label>Front-desk phone<input name="phone" value="${p.phone}" maxlength="30"></label>
          <label>Time zone<input name="timeZone" value="${p.timeZone}" required></label>
        </div>
        <label class="radio"><input type="radio" name="privacyMode" value="standard" ${p.privacyMode === 'standard' ? 'checked' : ''}><span><strong>Standard messages</strong> include the date, time and clinician.</span></label>
        <label class="radio"><input type="radio" name="privacyMode" value="minimal" ${p.privacyMode === 'minimal' ? 'checked' : ''}><span><strong>Minimal messages</strong> say only "you have an appointment update" with a secure link — recommended for behavioral health.</span></label>
        <label class="check"><input type="checkbox" name="autoApproveRequests" value="1" ${p.autoApproveRequests ? 'checked' : ''}> Put public requests straight on the waitlist (skip staff review)</label>
        <label class="check"><input type="checkbox" name="allowPatientAutoBook" value="1" ${p.allowPatientAutoBook ? 'checked' : ''}> Let patients choose automatic booking</label>
        <div class="row">
          <label>Default acuity<select name="defaultAcuity">${([1, 2, 3, 4, 5] as Acuity[]).map((a) => html`<option value="${a}" ${p.defaultAcuity === a ? 'selected' : ''}>${ACUITY_LABEL[a]}</option>`)}</select></label>
          ${num('requestExpiryDays', 'Requests expire after (days)', p.requestExpiryDays)}
        </div>

        <h2>Prioritization</h2>
        <p class="hint">Every patient's score is the sum of these parts, and staff can see the breakdown for any decision.</p>
        <div class="row">
          ${num('acuityPoints', 'Points per acuity level', pr.acuityPoints)}
          ${num('waitPointsPerDay', 'Points per day waiting', pr.waitPointsPerDay)}
          ${num('waitPointsMax', 'Max waiting points', pr.waitPointsMax)}
          ${num('unscheduledPoints', 'Bonus: no appointment yet', pr.unscheduledPoints)}
        </div>
        <div class="row">
          ${num('timeSavedPointsPerDay', 'Points per day seen sooner', pr.timeSavedPointsPerDay)}
          ${num('timeSavedPointsMax', 'Max time-saved points', pr.timeSavedPointsMax)}
          ${num('declinePenalty', 'Penalty per declined offer', pr.declinePenalty)}
        </div>

        <h2>Offers</h2>
        <div class="row">
          ${num('holdMinutes', 'Hold an offer for (min)', of.holdMinutes)}
          ${num('minLeadMinutes', 'Stop filling when start is within (min)', of.minLeadMinutes)}
          ${num('parallelWithinHours', 'Offer to several at once within (hours)', of.parallelWithinHours)}
          ${num('parallelCount', '…to how many patients', of.parallelCount)}
          ${num('minImprovementHours', 'Only move booked patients if ≥ (hours) sooner', of.minImprovementHours)}
        </div>
        <div class="row">
          <label>Quiet hours start <small>(blank = off)</small><input type="time" name="quietStart" value="${of.quietHours?.start}"></label>
          <label>Quiet hours end<input type="time" name="quietEnd" value="${of.quietHours?.end}"></label>
        </div>
        <p class="hint">During quiet hours no offers needing a reply go out (they would expire while patients sleep) and texts are held until morning. Auto-book patients can still be booked.</p>
        <label class="check"><input type="checkbox" name="cascadeFreedSlots" value="1" ${p.engine.cascadeFreedSlots ? 'checked' : ''}> When someone moves up, re-offer the slot they vacated (chain fill)</label>

        <h2 id="providers">Providers, locations & visit types</h2>
        <p class="hint">JSON. Providers: <code>id, name, defaultModality, locationId?, active, icalUrl?, icalIgnore?, fhirScheduleId?, fhirPractitionerId?, hl7Id?</code>. Visit types: <code>id, name, durationMinutes, modalities, patientSelectable</code>.</p>
        <textarea name="advanced" rows="18" spellcheck="false" class="code">${advanced}</textarea>
        <button class="primary">Save settings</button>
      </form>

      <section class="card"><h2>Connections</h2>
        <table class="table kv"><tbody>
          <tr><th>Public waitlist page</th><td><code>${c.publicUrl}/join</code></td></tr>
          <tr><th>Text messages</th><td>${c.sms.provider}</td></tr>
          <tr><th>Email</th><td>${c.email.provider}</td></tr>
          <tr><th>Booking write-back</th><td>${app.booking.name}</td></tr>
          <tr><th>FHIR server</th><td>${c.fhir ? c.fhir.baseUrl : 'not configured'}</td></tr>
          <tr><th>Calendar feeds</th><td>${p.providers.filter((x) => x.icalUrl).length} provider(s), polled every ${c.pollSeconds}s</td></tr>
          <tr><th>Outbox</th><td>${(() => {
            const s = app.db.outboxStats();
            return `${s.pending} pending, ${s.dead} failed permanently`;
          })()}</td></tr>
        </tbody></table>
        <p><a href="/staff/users">Manage staff accounts</a> · <a href="/staff/api-keys">API keys</a></p>
      </section>`,
      'settings',
    );
  };
  router.get('/staff/settings', admin, settingsPage);

  router.post('/staff/settings', admin, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const cur = app.practice();
    const n = (k: string) => Number(form.get(k));
    const next: PracticeSettings = structuredClone(cur);
    next.name = (form.get('name') ?? '').trim();
    next.messageName = (form.get('messageName') ?? '').trim();
    next.phone = (form.get('phone') ?? '').trim();
    next.timeZone = (form.get('timeZone') ?? '').trim();
    next.privacyMode = form.get('privacyMode') === 'minimal' ? 'minimal' : 'standard';
    next.autoApproveRequests = form.get('autoApproveRequests') === '1';
    next.allowPatientAutoBook = form.get('allowPatientAutoBook') === '1';
    next.defaultAcuity = n('defaultAcuity') as Acuity;
    next.requestExpiryDays = n('requestExpiryDays');
    next.engine = {
      priority: {
        acuityPoints: n('acuityPoints'),
        waitPointsPerDay: n('waitPointsPerDay'),
        waitPointsMax: n('waitPointsMax'),
        unscheduledPoints: n('unscheduledPoints'),
        timeSavedPointsPerDay: n('timeSavedPointsPerDay'),
        timeSavedPointsMax: n('timeSavedPointsMax'),
        declinePenalty: n('declinePenalty'),
      },
      offers: {
        holdMinutes: n('holdMinutes'),
        minLeadMinutes: n('minLeadMinutes'),
        parallelWithinHours: n('parallelWithinHours'),
        parallelCount: n('parallelCount'),
        minImprovementHours: n('minImprovementHours'),
        quietHours: form.get('quietStart') && form.get('quietEnd') ? { start: form.get('quietStart')!, end: form.get('quietEnd')! } : undefined,
      },
      cascadeFreedSlots: form.get('cascadeFreedSlots') === '1',
    };
    let errors: string[] = [];
    try {
      const adv = JSON.parse(form.get('advanced') ?? '{}') as Partial<PracticeSettings>;
      next.providers = adv.providers ?? [];
      next.locations = adv.locations ?? [];
      next.appointmentTypes = adv.appointmentTypes ?? [];
      next.timeBlocks = adv.timeBlocks ?? next.timeBlocks;
      next.weekdays = adv.weekdays ?? next.weekdays;
    } catch {
      errors = ['The providers/visit types box is not valid JSON.'];
    }
    if (!errors.length) errors = app.savePractice(next, staffActor(ctx));
    if (errors.length) {
      ctx.state.error = errors.join(' ');
      ctx.state.draft = next;
      ctx.res.statusCode = 400;
      return settingsPage(ctx);
    }
    redirect(ctx, '/staff/settings?ok=saved');
  });

  // ------------------------------------------------------------------ users

  const usersPage = (ctx: Ctx) => {
    const users = app.db.listUsers();
    const link = ctx.state.setupLink as string | undefined;
    page(
      ctx,
      'Staff accounts',
      html`<h1>Staff accounts</h1>
      ${link ? html`<div class="flash ok">Send this one-time setup link to the user (valid 72 hours): <code class="wrap">${link}</code></div>` : ''}
      <section class="card"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Two-factor</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map(
          (u) => html`<tr><td><strong>${u.displayName}</strong><br><small>${u.username}</small></td><td>${u.role}</td><td>${u.mfaEnabled ? 'on' : 'not set up'}</td>
          <td>${u.disabled ? 'disabled' : u.passwordHash ? 'active' : 'invited'}</td>
          <td><form method="post" action="/staff/users/${u.id}" class="actions">${csrfField(auth(ctx).session.csrf)}
            <button name="action" value="setup_link" class="small">New setup link</button>
            ${u.mfaEnabled ? html`<button name="action" value="reset_mfa" class="small" data-confirm="Reset two-factor for ${u.username}?">Reset 2FA</button>` : ''}
            ${u.id !== auth(ctx).user.id ? html`<button name="action" value="${u.disabled ? 'enable' : 'disable'}" class="small">${u.disabled ? 'Enable' : 'Disable'}</button>` : ''}
          </form></td></tr>`,
        )}
      </tbody></table></section>
      <section class="card"><h2>Invite someone</h2>
        <form method="post" action="/staff/users" class="row">${csrfField(auth(ctx).session.csrf)}
          <label>Username<input name="username" required pattern="[A-Za-z0-9._-]{2,40}"></label>
          <label>Display name<input name="displayName" maxlength="80"></label>
          <label>Role<select name="role"><option value="staff">Staff (front desk)</option><option value="provider">Provider</option><option value="admin">Admin</option></select></label>
          <button class="primary">Create & get setup link</button>
        </form>
        <p class="hint">Give each person their own account — shared logins defeat the audit trail.</p>
      </section>`,
      'settings',
    );
  };
  router.get('/staff/users', admin, usersPage);

  function setupLink(user: UserRecord): string {
    app.db.revokeLinkTokens('setup', user.id);
    const token = app.db.createLinkToken('setup', user.id, new Date(Date.now() + 72 * 3600000).toISOString());
    return `${app.config.publicUrl}/staff/setup/${token}`;
  }

  router.post('/staff/users', admin, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const username = (form.get('username') ?? '').trim();
    const role = form.get('role') as Role;
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(username) || !['admin', 'staff', 'provider'].includes(role)) throw new HttpError(400, 'Invalid username or role');
    if (app.db.getUserByUsername(username)) throw new HttpError(409, 'That username is taken');
    const user = app.db.createUser(username, form.get('displayName') ?? username, role);
    app.audit.record(staffActor(ctx), 'user.created', { type: 'user', id: user.id }, { role });
    ctx.state.setupLink = setupLink(user);
    return usersPage(ctx);
  });

  router.post('/staff/users/:id', admin, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const user = app.db.getUser(ctx.params.id);
    if (!user) throw new HttpError(404, 'Not found');
    const action = form.get('action');
    if (action === 'setup_link') ctx.state.setupLink = setupLink(user);
    else if (action === 'reset_mfa') {
      user.mfaEnabled = false;
      user.totpSecret = undefined;
      app.db.updateUser(user);
      app.db.deleteUserSessions(user.id);
    } else if ((action === 'disable' || action === 'enable') && user.id !== auth(ctx).user.id) {
      user.disabled = action === 'disable';
      app.db.updateUser(user);
      if (user.disabled) app.db.deleteUserSessions(user.id);
    } else throw new HttpError(400, 'Unknown action');
    app.audit.record(staffActor(ctx), `user.${action}`, { type: 'user', id: user.id });
    return usersPage(ctx);
  });

  // --------------------------------------------------------------- api keys

  const apiKeysPage = (ctx: Ctx) => {
    const keys = app.db.listApiKeys();
    const created = ctx.state.createdKey as string | undefined;
    page(
      ctx,
      'API keys',
      html`<h1>API keys</h1>
      ${created ? html`<div class="flash ok">Copy this key now — it will not be shown again:<br><code class="wrap">${created}</code></div>` : ''}
      <p class="hint">For interface engines and scripts that post openings, HL7 SIU messages or booking results. See <code>docs/api.md</code>.</p>
      <section class="card"><table class="table"><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
      ${keys.map(
        (k) => html`<tr><td>${k.name}</td><td>${relativeTime(k.createdAt)}</td><td>${k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}</td>
        <td>${k.revokedAt ? 'revoked' : html`<form method="post" action="/staff/api-keys/${k.id}/revoke">${csrfField(auth(ctx).session.csrf)}<button class="small" data-confirm="Revoke this key?">Revoke</button></form>`}</td></tr>`,
      )}
      </tbody></table>
      <form method="post" action="/staff/api-keys" class="row">${csrfField(auth(ctx).session.csrf)}
        <label>Name<input name="name" required maxlength="60" placeholder="Mirth interface"></label><button class="primary">Create key</button></form>
      </section>`,
      'settings',
    );
  };
  router.get('/staff/api-keys', admin, apiKeysPage);

  router.post('/staff/api-keys', admin, csrf, async (ctx) => {
    const form = await readForm(ctx);
    const name = (form.get('name') ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name required');
    const { id, key } = app.db.createApiKey(name);
    app.audit.record(staffActor(ctx), 'api_key.created', { type: 'api_key', id });
    ctx.state.createdKey = key;
    return apiKeysPage(ctx);
  });

  router.post('/staff/api-keys/:id/revoke', admin, csrf, (ctx) => {
    app.db.revokeApiKey(ctx.params.id);
    app.audit.record(staffActor(ctx), 'api_key.revoked', { type: 'api_key', id: ctx.params.id });
    redirect(ctx, '/staff/api-keys?ok=key_revoked');
  });

  // ------------------------------------------------------------------ audit

  router.get('/staff/audit', admin, (ctx) => {
    const before = Number(ctx.url.searchParams.get('before')) || undefined;
    const rows = app.audit.list({ limit: 100, beforeSeq: before });
    const check = app.audit.verify();
    const users = new Map(app.db.listUsers().map((u) => [u.id, u.username]));
    app.audit.record(staffActor(ctx), 'audit.viewed');
    page(
      ctx,
      'Audit log',
      html`<h1>Audit log</h1>
      <div class="flash ${check.ok ? 'ok' : 'error'}">${check.ok ? `Integrity verified: ${check.count} entries, hash chain intact.` : `Integrity check FAILED at entry #${check.brokenAt}. The log has been altered.`}</div>
      <section class="card"><table class="table audit"><thead><tr><th>#</th><th>When (UTC)</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>
      ${rows.map(
        (r) => html`<tr><td>${r.seq}</td><td><small>${r.at.replace('T', ' ').slice(0, 19)}</small></td>
        <td>${r.actorType === 'user' ? (users.get(r.actorId ?? '') ?? r.actorId ?? 'anonymous') : r.actorType}${r.ip ? html`<br><small>${r.ip}</small>` : ''}</td>
        <td><code>${r.action}</code></td><td><small>${r.entityType ? `${r.entityType} ${r.entityId}` : ''}</small></td>
        <td><small>${r.details ? JSON.stringify(r.details) : ''}</small></td></tr>`,
      )}
      </tbody></table>
      ${rows.length === 100 ? html`<p><a href="/staff/audit?before=${rows[rows.length - 1].seq}">Older →</a></p>` : ''}
      </section>`,
      'audit',
    );
  });

  // ------------------------------------------------------------- dev phone

  if (dev) {
    router.get('/dev/phone', staff, (ctx) => {
      const inbox = app.devInbox?.inbox ?? [];
      page(
        ctx,
        'Demo phone',
        html`<h1>Demo phone</h1><p class="hint">Development only. Texts and emails that would have been sent appear here instead. Links work — open them to accept or decline as the patient.</p>
        <div class="phone-list">${
          inbox.length
            ? inbox.map(
                (m) => html`<div class="bubble"><div class="meta">${m.channel === 'sms' ? 'Text' : 'Email'} to ${m.to} · ${relativeTime(m.at)}</div>${linkify(m.text)}</div>`,
              )
            : html`<p class="empty">No messages yet. Post an opening to see the pipeline run.</p>`
        }</div>`,
        'phone',
      );
    });
  }
}

function linkify(text: string): SafeHtml {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return html`${parts.map((p, i) => (i % 2 ? html`<a href="${p}">${p}</a>` : p))}`;
}
