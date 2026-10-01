/** Auto-escaping HTML templates: interpolated values are escaped unless wrapped in {@link raw}. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  nav?: { href: string; label: string; active?: boolean; badge?: number }[];
  user?: { displayName: string; role: string };
  csrf?: string;
  flash?: { kind: 'ok' | 'error' | 'info'; text: string };
  practiceName?: string;
  narrow?: boolean;
  devBanner?: boolean;
}

export function layout(o: LayoutOptions): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${o.title} · ${o.practiceName ?? 'Slotback'}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="/static/app.js" defer></script>
</head>
<body class="${o.narrow ? 'narrow' : ''}">
${o.devBanner ? html`<div class="dev-banner">Development mode: synthetic data only — never enter real patient information.</div>` : ''}
<header class="top">
  <div class="brand"><svg class="logo" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="6" width="16" height="3" rx="1" fill="currentColor" opacity=".25"/><rect x="4" y="11.5" width="18" height="4" rx="1" fill="#ffd43b"/><rect x="5" y="18" width="16" height="3" rx="1" fill="currentColor" opacity=".25"/></svg>${o.practiceName ?? 'Slotback'}</div>
  ${
    o.nav
      ? html`<nav>${o.nav.map(
          (n) => html`<a href="${n.href}" class="${n.active ? 'active' : ''}">${n.label}${n.badge ? html` <span class="pill">${n.badge}</span>` : ''}</a>`,
        )}</nav>`
      : ''
  }
  ${
    o.user
      ? html`<form method="post" action="/staff/logout" class="whoami"><span>${o.user.displayName}</span><input type="hidden" name="csrf" value="${o.csrf}"><button class="link">Sign out</button></form>`
      : ''
  }
</header>
<main>
${o.flash ? html`<div class="flash ${o.flash.kind}" role="status">${o.flash.text}</div>` : ''}
${o.body}
</main>
<footer class="foot">Protected health information · access is logged</footer>
</body>
</html>`;
}

export function csrfField(token: string | undefined): SafeHtml {
  return html`<input type="hidden" name="csrf" value="${token}">`;
}

export function badge(text: string, kind = ''): SafeHtml {
  return html`<span class="badge ${kind}">${text}</span>`;
}
