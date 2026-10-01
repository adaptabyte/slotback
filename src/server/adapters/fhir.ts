import type { Config } from '../config.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Small FHIR R4 REST client. Supports a static bearer token or OAuth2 client
 * credentials (client_secret_post), which covers most sandbox and production
 * EHR "backend service" setups that use shared secrets.
 */
export class FhirClient {
  private readonly cfg: NonNullable<Config['fhir']>;
  private cached?: { token: string; expiresAt: number };

  constructor(cfg: NonNullable<Config['fhir']>) {
    this.cfg = cfg;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  private async token(): Promise<string | undefined> {
    if (this.cfg.token) return this.cfg.token;
    if (!this.cfg.clientId || !this.cfg.clientSecret || !this.cfg.tokenUrl) return undefined;
    if (this.cached && this.cached.expiresAt > Date.now() + 30000) return this.cached.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    if (this.cfg.scope) body.set('scope', this.cfg.scope);
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new HttpError(res.status, `FHIR token endpoint returned HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
    return json.access_token;
  }

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json?: T; location?: string }> {
    const token = await this.token();
    // Absolute URLs (Bundle paging links) are only followed on the configured server, so the token never leaks.
    const url = /^https?:\/\//.test(path) ? path : `${this.cfg.baseUrl}/${path.replace(/^\/+/, '')}`;
    if (!url.startsWith(`${this.cfg.baseUrl}/`)) throw new Error('Refusing to call a URL outside the configured FHIR server');
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/fhir+json',
        ...(body ? { 'content-type': 'application/fhir+json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json: T | undefined;
    try {
      json = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, location: res.headers.get('location') ?? undefined };
  }
}

interface SlotBundle {
  entry?: { resource?: Record<string, unknown> }[];
  link?: { relation: string; url: string }[];
}

export interface FhirSlot {
  id: string;
  start: string;
  end: string;
}

/** Free slots for a schedule in [from, to). Follows Bundle `next` links up to a sane limit. */
export async function fetchFreeSlots(client: FhirClient, scheduleId: string, from: Date, to: Date): Promise<FhirSlot[]> {
  const out: FhirSlot[] = [];
  let path: string | undefined =
    `Slot?schedule=Schedule/${encodeURIComponent(scheduleId)}&status=free&start=ge${from.toISOString()}&start=lt${to.toISOString()}&_count=200`;
  for (let page = 0; path && page < 10; page++) {
    const res: { status: number; json?: SlotBundle } = await client.request<SlotBundle>('GET', path);
    if (res.status >= 400) throw new HttpError(res.status, `FHIR Slot search returned HTTP ${res.status}`);
    for (const e of res.json?.entry ?? []) {
      const r = e.resource;
      if (r?.resourceType === 'Slot' && r.status === 'free' && r.id && r.start && r.end) {
        out.push({ id: String(r.id), start: String(r.start), end: String(r.end) });
      }
    }
    const next: string | undefined = res.json?.link?.find((l) => l.relation === 'next')?.url;
    path = next && next.startsWith(`${client.baseUrl}/`) ? next : undefined;
  }
  return out;
}
