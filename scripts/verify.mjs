// Audits dist/ after `npm run build`. Exits non-zero if anything essential is wrong.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SITE_URL = (process.env.SITE_URL || 'https://blog.adeepag.com').replace(/\/+$/, '');
const errors = [];
const fail = (msg) => errors.push(msg);
const read = (p) => fs.readFile(path.join(DIST, p), 'utf8');
const exists = (p) => fs.access(path.join(DIST, p)).then(() => true, () => false);
const attr = (html, re) => (html.match(re) || [])[1];

const sitemap = await read('sitemap.xml');
const robots = await read('robots.txt');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

if (!sitemap.startsWith('<?xml') || !sitemap.includes('http://www.sitemaps.org/schemas/sitemap/0.9')) fail('sitemap.xml: bad header/namespace');
if (!locs.includes(`${SITE_URL}/`)) fail('sitemap.xml: homepage missing');
if (new Set(locs).size !== locs.length) fail('sitemap.xml: duplicate URLs');
if (!new RegExp(`^Sitemap:\\s*${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml\\s*$`, 'm').test(robots)) fail('robots.txt: missing Sitemap line');
if (/^\s*Disallow:\s*\S/m.test(robots)) fail('robots.txt: contains a Disallow rule');

const titles = new Map();
const descriptions = new Map();
const postUrls = locs.filter((l) => l.startsWith(`${SITE_URL}/posts/`));
const home = await read('index.html');

for (const url of postUrls) {
  const slug = url.slice(`${SITE_URL}/posts/`.length).replace(/\/$/, '');
  const file = `posts/${slug}/index.html`;
  if (!(await exists(file))) { fail(`${url}: ${file} not generated`); continue; }
  const html = await read(file);
  const title = attr(html, /<title>([^<]+)<\/title>/);
  const desc = attr(html, /<meta name="description" content="([^"]*)"/);
  const need = {
    canonical: attr(html, /<link rel="canonical" href="([^"]+)"/),
    'og:title': attr(html, /<meta property="og:title" content="([^"]+)"/),
    'og:description': attr(html, /<meta property="og:description" content="([^"]+)"/),
    'og:url': attr(html, /<meta property="og:url" content="([^"]+)"/),
    'og:image': attr(html, /<meta property="og:image" content="([^"]+)"/),
    'twitter:card': attr(html, /<meta name="twitter:card" content="([^"]+)"/),
    'twitter:title': attr(html, /<meta name="twitter:title" content="([^"]+)"/),
    'twitter:image': attr(html, /<meta name="twitter:image" content="([^"]+)"/),
  };
  if (!title) fail(`${url}: missing <title>`);
  if (!desc) fail(`${url}: missing meta description`);
  for (const [k, v] of Object.entries(need)) if (!v) fail(`${url}: missing ${k}`);
  if (need.canonical !== url) fail(`${url}: canonical is ${need.canonical}`);
  if (need['og:url'] !== url) fail(`${url}: og:url is ${need['og:url']}`);
  for (const k of ['og:image', 'twitter:image']) if (need[k] && !/^https:\/\//.test(need[k])) fail(`${url}: ${k} is not absolute`);
  if (titles.has(title)) fail(`${url}: <title> duplicates ${titles.get(title)}`); else titles.set(title, url);
  if (descriptions.has(desc)) fail(`${url}: description duplicates ${descriptions.get(desc)}`); else descriptions.set(desc, url);
  if (/loading\.\.\./i.test(html)) fail(`${url}: still contains the loading placeholder`);
  if (!/<article class="article" id="article"><h1>[^<]+<\/h1>/.test(html)) fail(`${url}: article <h1> missing from initial HTML`);
  if (!/<\/time><\/div>\s*<(p|h[2-6]|ul|ol|pre|table|blockquote|figure)\b/.test(html)) fail(`${url}: no article body content after the byline in initial HTML`);

  const ld = attr(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  try {
    const j = JSON.parse(ld);
    if (j['@type'] !== 'BlogPosting') fail(`${url}: JSON-LD @type is ${j['@type']}`);
    for (const k of ['headline', 'description', 'image', 'datePublished', 'dateModified', 'author', 'mainEntityOfPage']) if (!j[k]) fail(`${url}: JSON-LD missing ${k}`);
    if (j.mainEntityOfPage?.['@id'] !== url) fail(`${url}: JSON-LD mainEntityOfPage mismatch`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.datePublished)) fail(`${url}: JSON-LD datePublished malformed`);
  } catch { fail(`${url}: JSON-LD is missing or not valid JSON`); }

  // every root-relative src/href must resolve to a generated file
  for (const m of html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)) {
    const p = decodeURIComponent(m[1]);
    const target = p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1);
    if (target && !(await exists(target)) && !(await exists(`${p.slice(1)}/index.html`))) fail(`${url}: broken link/asset ${m[1]}`);
    if (!p.startsWith('/') ) fail(`${url}: unexpected path ${m[1]}`);
  }
  // no non-root-relative asset paths (would break on a nested URL)
  for (const m of html.matchAll(/\b(?:src|href)="(?!https?:|mailto:|\/|#|data:)([^"]+)"/g)) fail(`${url}: relative path ${m[1]} will break on a nested URL`);

  if (!home.includes(`href="/posts/${slug}/"`)) fail(`homepage does not link to /posts/${slug}/`);
}

if (!/<link rel="canonical" href="[^"]*\/">/.test(home) || !home.includes(`<link rel="canonical" href="${SITE_URL}/">`)) fail(`index.html: canonical should be ${SITE_URL}/`);
if (/loading posts/i.test(home)) fail('index.html: still has the loading placeholder');
if (!(await exists('post.html')) || !(await exists('404.html'))) fail('post.html (legacy shim) or 404.html missing');
for (const f of ['style.css', 'avatar.png', 'favicon.png']) if (!(await exists(f))) fail(`${f} missing from dist/`);

if (errors.length) {
  console.error(`verify: ${errors.length} problem(s)\n` + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`verify: OK (${postUrls.length} post page(s), ${locs.length} sitemap URL(s))`);
