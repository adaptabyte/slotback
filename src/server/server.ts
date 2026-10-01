import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { App } from './runtime.ts';
import { HttpError, Router, parseCookies, securityHeaders, sendHtml, sendJson } from './http.ts';
import type { Ctx } from './http.ts';
import { html, layout } from './html.ts';
import { staffRoutes } from './routes/staff.ts';
import { patientRoutes } from './routes/patient.ts';
import { apiRoutes } from './routes/api.ts';

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');
const STATIC: Record<string, { file: string; type: string }> = {
  '/static/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/static/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/static/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

export function buildRouter(app: App): Router {
  const router = new Router();
  router.get('/', (ctx) => {
    ctx.res.statusCode = 303;
    ctx.res.setHeader('location', '/join');
    ctx.res.end();
  });
  router.get('/robots.txt', (ctx) => {
    ctx.res.setHeader('content-type', 'text/plain');
    ctx.res.end('User-agent: *\nDisallow: /\n');
  });
  staffRoutes(router, app);
  patientRoutes(router, app);
  apiRoutes(router, app);
  return router;
}

function clientIp(app: App, req: IncomingMessage): string {
  if (app.config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createHttpServer(app: App): Server {
  const router = buildRouter(app);
  const secure = app.config.publicUrl.startsWith('https://');
  const statics = new Map<string, Buffer>();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    securityHeaders(res, secure);

    if (app.config.env === 'production' && app.config.trustProxy && req.headers['x-forwarded-proto'] === 'http') {
      res.statusCode = 308;
      res.setHeader('location', `${app.config.publicUrl}${url.pathname}${url.search}`);
      return res.end();
    }

    const asset = STATIC[url.pathname];
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      let buf = statics.get(asset.file);
      if (!buf) {
        buf = readFileSync(join(STATIC_DIR, asset.file));
        statics.set(asset.file, buf);
      }
      res.setHeader('content-type', asset.type);
      res.setHeader('cache-control', 'public, max-age=3600');
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }

    const ctx: Ctx = {
      req,
      res,
      method: req.method ?? 'GET',
      url,
      path: url.pathname,
      params: {},
      ip: clientIp(app, req),
      cookies: parseCookies(req.headers.cookie),
      state: {},
    };
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/');
    try {
      const match = router.match(ctx.method, url.pathname);
      if (match === 'method') throw new HttpError(405, 'Method not allowed');
      if (!match) throw new HttpError(404, 'Page not found');
      ctx.params = match.params;
      for (const handler of match.handlers) {
        const result = await handler(ctx);
        if (result === false || res.writableEnded) break;
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Something went wrong. The error has been logged.';
      if (status === 500) app.log(`error on ${ctx.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      if (res.headersSent) return res.end();
      if (isApi) return sendJson(ctx, { error: message }, status);
      sendHtml(
        ctx,
        layout({
          title: status === 404 ? 'Not found' : 'Error',
          narrow: true,
          practiceName: app.practice().name,
          body: html`<section class="card"><h1>${status === 404 ? 'Not found' : 'Sorry'}</h1><p>${message}</p><p><a href="${url.pathname.startsWith('/staff') ? '/staff' : '/join'}">Back to start</a></p></section>`,
        }),
        status,
      );
    }
  });
}
