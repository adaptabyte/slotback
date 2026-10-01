#!/usr/bin/env node
// Builds the public website into _site/ (or $SITE_OUT):
//   - bundles the real matching engine (src/core) for the in-browser demo
//   - expands {{> head}} / {{> header page}} / {{> footer}} partials and URL/contact tokens
//   - writes sitemap.xml, robots.txt and .nojekyll for GitHub Pages
// Usage: SITE_URL=https://example.com node scripts/build-site.mjs [--artifact]
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'site');
const out = resolve(root, process.env.SITE_OUT || '_site');
const artifact = process.argv.includes('--artifact');

function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const repo = process.env.GITHUB_REPOSITORY; // owner/name, set inside GitHub Actions
  if (repo) {
    const [owner, name] = repo.split('/');
    return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name}` : `https://${owner}.github.io/${name}`;
  }
  return 'http://localhost:8000';
}
const SITE_URL = siteUrl().replace(/\/+$/, '');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'hello@example.com';
const SECURITY_EMAIL = process.env.SECURITY_EMAIL || 'security@example.com';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(src, 'assets'), join(out, 'assets'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/core/index.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  outfile: join(out, 'assets/slotback-core.js'),
  legalComments: 'none',
  logLevel: 'warning',
});

const partial = (name) => readFileSync(join(src, 'partials', `${name}.html`), 'utf8');
const pages = readdirSync(src).filter((f) => f.endsWith('.html'));

for (const file of pages) {
  let html = readFileSync(join(src, file), 'utf8')
    .replace('{{> head}}', partial('head'))
    .replace('{{> footer}}', partial('footer'))
    .replace(/\{\{> header (\w+)\}\}/, (_, page) =>
      partial('header').replace(`data-nav="${page}"`, `data-nav="${page}" aria-current="page"`),
    );
  if (file === '404.html') html = html.replace('<head>', `<head>\n<base href="${SITE_URL}/">`);
  html = html
    .replaceAll('{{SITE_URL}}', SITE_URL)
    .replaceAll('{{CONTACT_EMAIL}}', CONTACT_EMAIL)
    .replaceAll('{{SECURITY_EMAIL}}', SECURITY_EMAIL);
  if (/\{\{[^}]+\}\}/.test(html)) throw new Error(`Unreplaced token in ${file}: ${html.match(/\{\{[^}]+\}\}/)[0]}`);
  if (artifact && file === 'index.html') {
    // Artifact previews wrap the entry page in their own document skeleton.
    html = html
      .replace(/<!doctype html>\s*/i, '')
      .replace(/<\/?html[^>]*>\s*/gi, '')
      .replace(/<\/?head>\s*/gi, '')
      .replace(/<\/?body>\s*/gi, '');
  }
  writeFileSync(join(out, file), html);
}

const today = new Date().toISOString().slice(0, 10);
const indexed = pages.filter((p) => p !== '404.html');
writeFileSync(
  join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexed
    .map((p) => `  <url><loc>${SITE_URL}/${p === 'index.html' ? '' : p}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
writeFileSync(join(out, '.nojekyll'), '');
if (existsSync(join(src, 'CNAME'))) cpSync(join(src, 'CNAME'), join(out, 'CNAME'));

console.log(`Built ${pages.length} pages into ${out} for ${SITE_URL}`);
