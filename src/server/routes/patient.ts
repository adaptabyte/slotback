import { describeWindows, formatSlot } from '../../core/index.ts';
import type { WaitlistEntry } from '../../core/index.ts';
import type { App } from '../runtime.ts';
import { MODALITY_LABEL } from '../runtime.ts';
import type { Ctx, Router } from '../http.ts';
import { HttpError, RateLimiter, readForm, redirect, sendHtml } from '../http.ts';
import { html, layout } from '../html.ts';
import type { SafeHtml } from '../html.ts';
import type { Actor } from '../audit.ts';
import { providerName, typeName, locationName } from '../practice.ts';
import { entryFormFields, parseEntryForm } from '../views.ts';

/** Public pages: waitlist request form and the secure links patients receive by text/email. */
export function patientRoutes(router: Router, app: App) {
  const joinLimiter = new RateLimiter(5, 60 * 60000);
  const tokenLimiter = new RateLimiter(60, 10 * 60000);
  const dev = app.config.env !== 'production';

  function page(ctx: Ctx, title: string, body: SafeHtml, status?: number, flash?: { kind: 'ok' | 'error' | 'info'; text: string }) {
    sendHtml(ctx, layout({ title, body, narrow: true, practiceName: app.practice().name, flash, devBanner: dev }), status);
  }

  const patientActor = (ctx: Ctx, id?: string): Actor => ({ type: 'patient', id, ip: ctx.ip });

  function guard(ctx: Ctx) {
    if (!tokenLimiter.allow(ctx.ip)) throw new HttpError(429, 'Too many requests. Please wait a few minutes.');
  }

  // ------------------------------------------------------------------- join

  const joinPage = (ctx: Ctx) => {
    const p = app.practice();
    if (!p.providers.length) {
      return page(ctx, 'Waitlist', html`<section class="card"><h1>Waitlist coming soon</h1><p>${p.name} has not opened its online waitlist yet. Please call the office${p.phone ? ` at ${p.phone}` : ''}.</p></section>`);
    }
    const errors = ctx.state.errors as string[] | undefined;
    page(
      ctx,
      'Get seen sooner',
      html`<section class="card intro">
        <h1>Get seen sooner at ${p.name}</h1>
        <p>Tell us when you could come in on short notice. When a matching appointment opens up — usually because someone cancels — we'll ${p.allowPatientAutoBook ? 'book you automatically or ' : ''}text you right away.</p>
        <p class="hint">For existing and referred patients. This form is not monitored for urgent needs. <strong>If you are in crisis, call or text 988 or call 911.</strong></p>
      </section>
      <form method="post" action="/join" class="card form" novalidate>
        <div class="hp" aria-hidden="true"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
        ${entryFormFields(p, 'patient', ctx.state.patient as never, ctx.state.entry as never)}
        <p class="hint">Your information is encrypted and used only to schedule you at ${p.name}. Staff will confirm your request${p.autoApproveRequests ? '' : ' before you are matched'}.</p>
        <button class="primary big">Join the waitlist</button>
      </form>`,
      errors ? 400 : undefined,
      errors ? { kind: 'error', text: errors.join(' ') } : undefined,
    );
  };
  router.get('/join', joinPage);

  router.post('/join', async (ctx) => {
    const p = app.practice();
    const form = await readForm(ctx);
    if (form.get('website')) return redirect(ctx, '/join/thanks'); // honeypot: pretend success
    if (!joinLimiter.allow(ctx.ip)) throw new HttpError(429, 'Too many requests from this network. Please call the office.');
    const { values, errors, draft } = parseEntryForm(form, p, 'patient');
    if (!values) {
      ctx.state.errors = errors;
      ctx.state.patient = draft.patient;
      ctx.state.entry = draft.entry;
      return joinPage(ctx);
    }
    const now = new Date();
    app.db.tx(() => {
      const patient = app.db.insertPatient(values.patient);
      const entry: WaitlistEntry = {
        ...values.entry,
        id: app.newEntryId(),
        patientId: patient.id,
        status: p.autoApproveRequests ? 'active' : 'pending_review',
        addedAt: now.toISOString(),
        declines: 0,
      };
      app.audit.record(patientActor(ctx, patient.id), 'patient.self_registered', { type: 'patient', id: patient.id });
      app.run(patientActor(ctx, patient.id), (e) => e.addEntry(entry, now), now);
      ctx.state.manage = app.db.createLinkToken('manage', entry.id, entry.expiresAt ?? new Date(now.getTime() + 90 * 86400000).toISOString());
    });
    redirect(ctx, `/m/${ctx.state.manage}?welcome=1`);
  });

  router.get('/join/thanks', (ctx) => {
    page(ctx, 'Thank you', html`<section class="card"><h1>Thank you</h1><p>We received your request.</p></section>`);
  });

  // ------------------------------------------------------------------ offer

  const offerPage = (ctx: Ctx) => {
    guard(ctx);
    const offerId = app.db.resolveLinkToken('offer', ctx.params.token);
    const offer = offerId ? app.store.getOffer(offerId) : undefined;
    if (!offer) throw new HttpError(404, 'This link has expired. If you still need an earlier appointment, you are still on the waitlist.');
    const opening = app.store.getOpening(offer.openingId)!;
    const p = app.practice();
    const result = ctx.state.result as string | undefined;
    app.audit.record(patientActor(ctx, offer.patientId), 'offer.viewed', { type: 'offer', id: offer.id });
    const details = html`<dl class="slot">
      <dt>When</dt><dd>${formatSlot(opening.start, p.timeZone)}</dd>
      <dt>With</dt><dd>${providerName(p, opening.providerId)}</dd>
      <dt>Where</dt><dd>${opening.modality === 'telehealth' ? 'Telehealth (video)' : locationName(p, opening.locationId) || 'In person'}</dd>
    </dl>`;
    if (offer.status === 'pending' && offer.expiresAt > new Date().toISOString()) {
      const entry = app.store.getEntry(offer.entryId);
      return page(
        ctx,
        'Earlier appointment',
        html`<section class="card offer"><h1>An earlier appointment is available</h1>${details}
        ${entry?.currentAppointment ? html`<p>If you accept, your current appointment on <strong>${formatSlot(entry.currentAppointment.start, p.timeZone)}</strong> will be released.</p>` : ''}
        <p class="hint">Held for you until <strong>${new Intl.DateTimeFormat('en-US', { timeZone: p.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(offer.expiresAt))}</strong>.</p>
        <form method="post" class="choice">
          <button class="primary big" name="action" value="accept">Yes, book me</button>
          <button class="big" name="action" value="decline">No thanks, keep me on the list</button>
        </form></section>`,
      );
    }
    const messages: Record<string, SafeHtml> = {
      accepted: html`<h1>You're booked!</h1><p>We're confirming it with the office now and will text you a confirmation.</p>`,
      declined: html`<h1>No problem</h1><p>You're still on the waitlist and we'll let you know about the next opening.</p>`,
      expired: html`<h1>This offer has expired</h1><p>The hold time passed, so the slot went to the next patient. You're still on the waitlist.</p>`,
      unavailable: html`<h1>Sorry, this slot was just taken</h1><p>Another patient accepted first. You're still on the waitlist.</p>`,
    };
    const state = result ?? (offer.status === 'accepted' ? 'accepted' : offer.status === 'declined' ? 'declined' : offer.status === 'expired' || offer.expiresAt <= new Date().toISOString() ? 'expired' : 'unavailable');
    page(ctx, 'Appointment offer', html`<section class="card offer">${messages[state] ?? messages.unavailable}${state === 'accepted' ? details : ''}</section>`);
  };
  router.get('/o/:token', offerPage);

  router.post('/o/:token', async (ctx) => {
    guard(ctx);
    const offerId = app.db.resolveLinkToken('offer', ctx.params.token);
    if (!offerId) throw new HttpError(404, 'This link has expired.');
    const form = await readForm(ctx);
    const action = form.get('action') === 'accept' ? 'accept' : 'decline';
    const offer = app.store.getOffer(offerId)!;
    const res = app.run(patientActor(ctx, offer.patientId), (e, now) => e.respond(offerId, action, now));
    ctx.state.result = res.result === 'already_responded' ? undefined : res.result;
    offerPage(ctx);
  });

  // ----------------------------------------------------------------- manage

  const managePage = (ctx: Ctx) => {
    guard(ctx);
    const entryId = app.db.resolveLinkToken('manage', ctx.params.token);
    const entry = entryId ? app.store.getEntry(entryId) : undefined;
    if (!entry) throw new HttpError(404, 'This link has expired. Please contact the office.');
    const p = app.practice();
    app.audit.record(patientActor(ctx, entry.patientId), 'entry.viewed_by_patient', { type: 'entry', id: entry.id });
    const welcome = ctx.url.searchParams.get('welcome') === '1';
    const booking = app.store.listBookings({ entryId: entry.id }).filter((b) => b.status !== 'failed').pop();
    const statusText: Record<string, string> = {
      pending_review: 'Received — the office will review your request shortly.',
      active: "You're on the waitlist. We'll contact you when a matching time opens.",
      offered: "We've sent you an offer — check your texts/email.",
      booking: 'We are confirming your new appointment.',
      booked: 'You have been moved to an earlier appointment.',
      paused: 'Paused — you will not receive offers until you resume.',
      removed: 'You are no longer on the waitlist.',
    };
    page(
      ctx,
      'Your waitlist request',
      html`<section class="card">
        <h1>${welcome ? "You're on the list" : 'Your waitlist request'}</h1>
        <p class="status">${statusText[entry.status] ?? entry.status}</p>
        ${
          booking && entry.status === 'booked'
            ? html`<dl class="slot"><dt>New appointment</dt><dd>${formatSlot(booking.start, p.timeZone)}</dd><dt>With</dt><dd>${providerName(p, booking.providerId)}</dd><dt>How</dt><dd>${MODALITY_LABEL[booking.modality]}</dd></dl>`
            : html`<dl class="slot"><dt>Visit</dt><dd>${typeName(p, entry.appointmentType)}</dd><dt>Times</dt><dd>${describeWindows(entry.availability.weekly)}</dd>
              <dt>When matched</dt><dd>${entry.bookingMode === 'auto' ? 'Book me automatically' : 'Ask me first'}</dd></dl>`
        }
        ${welcome ? html`<p class="hint">Bookmark this page to pause or leave the waitlist later. We'll also include a link in our messages.</p>` : ''}
        ${
          ['active', 'pending_review', 'paused', 'offered'].includes(entry.status)
            ? html`<form method="post" class="choice">
                ${entry.status === 'paused' ? html`<button class="primary" name="action" value="resume">Resume</button>` : ''}
                ${entry.status === 'active' || entry.status === 'offered' ? html`<button name="action" value="pause">Pause for now</button>` : ''}
                <button name="action" value="leave" data-confirm="Leave the waitlist?">Leave the waitlist</button>
              </form>`
            : ''
        }
        <p class="hint">Need to change your times or details? Call ${p.phone || 'the office'}.</p>
      </section>`,
    );
  };
  router.get('/m/:token', managePage);

  router.post('/m/:token', async (ctx) => {
    guard(ctx);
    const entryId = app.db.resolveLinkToken('manage', ctx.params.token);
    const entry = entryId ? app.store.getEntry(entryId) : undefined;
    if (!entry) throw new HttpError(404, 'This link has expired.');
    const form = await readForm(ctx);
    const action = form.get('action');
    // Patients can pause/resume an approved entry and leave at any time; approval stays with staff.
    const allowed: Record<string, { from: string[]; to: WaitlistEntry['status'] }> = {
      pause: { from: ['active', 'offered'], to: 'paused' },
      resume: { from: ['paused'], to: 'active' },
      leave: { from: ['active', 'offered', 'paused', 'pending_review'], to: 'removed' },
    };
    const rule = action ? allowed[action] : undefined;
    if (!rule) throw new HttpError(400, 'Unknown action');
    if (rule.from.includes(entry.status)) {
      app.run(patientActor(ctx, entry.patientId), (e, now) => e.updateEntry(entry.id, { status: rule.to }, now));
    }
    redirect(ctx, `/m/${ctx.params.token}`);
  });
}
