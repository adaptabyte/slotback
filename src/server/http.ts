import type { IncomingMessage, ServerResponse } from 'node:http';
import { SafeHtml } from './html.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  ip: string;
  cookies: Record<string, string>;
  /** Parsed lazily by {@link readForm} / {@link readJson} / {@link readText}. */
  rawBody?: string;
  state: Record<string, unknown>;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Route {
  method: string;
  parts: string[];
  handlers: Handler[];
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, ...handlers: Handler[]) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handlers });
  }
  get(pattern: string, ...h: Handler[]) {
    this.add('GET', pattern, ...h);
  }
  post(pattern: string, ...h: Handler[]) {
    this.add('POST', pattern, ...h);
  }

  match(method: string, path: string): { handlers: Handler[]; params: Record<string, string> } | 'method' | undefined {
    const segs = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i].startsWith(':')) {
          try {
            params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            ok = false;
          }
        } else if (r.parts[i] !== segs[i]) ok = false;
        if (!ok) break;
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { handlers: r.handlers, params };
    }
    return pathMatched ? 'method' : undefined;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      try {
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // ignore malformed cookie
      }
    }
  }
  return out;
}

export function setCookie(ctx: Ctx, name: string, value: string, opts: { maxAge?: number; secure: boolean; path?: string }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Strict'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = ctx.res.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  ctx.res.setHeader('set-cookie', [...list, parts.join('; ')]);
}

const MAX_BODY = 512 * 1024;

export async function readBody(ctx: Ctx): Promise<string> {
  if (ctx.rawBody !== undefined) return ctx.rawBody;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  ctx.rawBody = Buffer.concat(chunks).toString('utf8');
  return ctx.rawBody;
}

export async function readForm(ctx: Ctx): Promise<URLSearchParams> {
  const type = ctx.req.headers['content-type'] ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Expected a form submission');
  return new URLSearchParams(await readBody(ctx));
}

export async function readJson<T = Record<string, unknown>>(ctx: Ctx): Promise<T> {
  const type = ctx.req.headers['content-type'] ?? '';
  if (!type.includes('json')) throw new HttpError(415, 'Expected application/json');
  try {
    return JSON.parse(await readBody(ctx)) as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON');
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(res: ServerResponse, secure: boolean) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  // Link tokens live in URLs: never leak them through Referer.
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  // Pages may contain PHI: never cache them anywhere.
  res.setHeader('cache-control', 'no-store');
  if (secure) res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
}

/** Leaves an already-set status (e.g. 401 on a re-rendered form) unless one is passed. */
export function sendHtml(ctx: Ctx, body: SafeHtml | string, status?: number) {
  if (status !== undefined) ctx.res.statusCode = status;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.end(body instanceof SafeHtml ? body.value : body);
}

export function sendJson(ctx: Ctx, body: unknown, status = 200) {
  ctx.res.statusCode = status;
  ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
  ctx.res.end(JSON.stringify(body));
}

export function sendText(ctx: Ctx, body: string, status = 200, type = 'text/plain; charset=utf-8') {
  ctx.res.statusCode = status;
  ctx.res.setHeader('content-type', type);
  ctx.res.end(body);
}

export function redirect(ctx: Ctx, location: string, status = 303) {
  ctx.res.statusCode = status;
  ctx.res.setHeader('location', location);
  ctx.res.end();
}

/** Fixed-window in-memory rate limiter (per process). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      if (this.hits.size > 10000) this.hits.clear();
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
