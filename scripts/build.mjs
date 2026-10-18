// Static build for blog.adeepag.com
//
//   posts/*.md  ->  dist/posts/<slug>/index.html   (full article HTML + unique SEO metadata)
//   index.html  ->  dist/index.html                (post list rendered into the HTML)
//   generated   ->  dist/sitemap.xml, dist/robots.txt, dist/post.html (legacy shim), dist/404.html
//
// No framework, no database. The only dependency is `marked` (pinned to the same
// version the site used from the CDN, so Markdown renders exactly as before).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

// ---------------------------------------------------------------- config ---
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = path.join(ROOT, 'posts');
const OUT = path.join(ROOT, 'dist');

// Override with the SITE_URL env var (e.g. for a staging domain).
const SITE_URL = (process.env.SITE_URL || 'https://blog.adeepag.com').replace(/\/+$/, '');
const SITE_NAME = 'adeep ag';
const BLOG_TITLE = 'adeep ag - blog';
const BLOG_DESCRIPTION =
  "adeep ag's blog on backend, servers, electronics, cyber and building toward a defence startup.";
const TWITTER_HANDLE = '@adeep_ag';
const DEFAULT_IMAGE = '/avatar.png'; // used for sharing when a post has no image
const AUTHOR = {
  '@type': 'Person',
  name: 'adeep ag',
  url: 'https://adeepag.com',
  sameAs: ['https://x.com/adeep_ag', 'https://github.com/ADEEP13'],
};
// Root-level files with these extensions are copied to dist/ as-is.
const STATIC_EXT = new Set(['.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.woff', '.woff2']);
// Files copied from posts/ (images and other attachments a post may reference).
const POST_ASSET_EXT = new Set([...STATIC_EXT, '.pdf', '.mp4', '.webm', '.mp3', '.txt', '.zip']);

// --------------------------------------------------------------- helpers ---
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// JSON for an inline <script type="application/ld+json">; '<' is escaped so
// post content can never close the script tag.
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

// {{name}} = HTML-escaped value, {{{name}}} = raw value. Unknown keys are left as-is.
function render(tpl, vars) {
  return tpl.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (m, rawKey, escKey) => {
    const key = rawKey || escKey;
    if (!(key in vars)) return m;
    return rawKey ? String(vars[key]) : esc(vars[key]);
  });
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
const htmlToText = (html) => decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const inlineText = (md) => htmlToText(marked.parseInline(md));

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[\s,;:.\-]+$/, '') + '\u2026';
}

const absUrl = (u) => (/^https?:\/\//i.test(u) ? u : SITE_URL + (u.startsWith('/') ? u : '/' + u));
const humanize = (slug) => slug.replace(/-+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const displayDate = (d) => d.replace(/-/g, '.');

function normalizeDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || Number.isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}`))) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Date the file was first committed, but only when the full git history is
// available (Vercel clones can be shallow, where this would be wrong).
function gitFirstCommitDate(file) {
  const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (run(['rev-parse', '--is-shallow-repository']) !== 'false') return null;
    const last = run(['log', '--diff-filter=A', '--follow', '--format=%aI', '--', file]).split('\n').pop();
    return normalizeDate(last);
  } catch {
    return null;
  }
}

// Optional "---" front matter at the very top of a post. Simple `key: value` lines.
function parseFrontMatter(src) {
  src = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    data[kv[1].toLowerCase()] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, body: src.slice(m[0].length) };
}

// Relative links/images inside a post are resolved against /posts/ (the folder
// the Markdown file lives in), so `![x](images/a.png)` and `[y](other-post.md)` work
// from the nested article URL.
function rewriteRelativeUrls(html) {
  return html.replace(/\b(src|href)="([^"]*)"/g, (m, attr, val) => {
    if (!val || /^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(val)) return m;
    const clean = val.replace(/^(\.\/)+/, '');
    const md = clean.match(/^([^#?]+)\.md([#?].*)?$/i);
    if (md && !md[1].includes('/')) return `${attr}="/posts/${slugify(md[1])}/${md[2] || ''}"`;
    return `${attr}="/posts/${clean}"`;
  });
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function copyDir(src, dest, filter) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to, filter);
    else if (filter(entry.name)) await fs.copyFile(from, to);
  }
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const warn = (msg) => console.warn(`WARNING: ${msg}`);

// ----------------------------------------------------------------- posts ---
async function loadLegacyMeta() {
  // posts.json is optional now: it only supplies title/date/description for posts
  // that don't have front matter. Posts missing from it are still published.
  let raw;
  try {
    raw = await fs.readFile(path.join(ROOT, 'posts.json'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw e;
  }
  return new Map(JSON.parse(raw).map((p) => [p.slug, p]));
}

async function loadPosts() {
  const legacy = await loadLegacyMeta();
  const files = (await fs.readdir(POSTS_DIR)).filter((f) => f.toLowerCase().endsWith('.md') && !/^[._]/.test(f)).sort();
  const posts = [];
  const seen = new Map();

  for (const file of files) {
    const base = file.replace(/\.md$/i, '');
    const slug = slugify(base);
    if (!slug) { warn(`skipping ${file}: cannot derive a URL slug from the file name`); continue; }
    if (slug !== base) warn(`posts/${file} is published at /posts/${slug}/ (file names should be lowercase letters, digits and hyphens)`);
    if (seen.has(slug)) throw new Error(`posts/${file} and posts/${seen.get(slug)} would both be published at /posts/${slug}/`);
    seen.set(slug, file);

    const { data, body } = parseFrontMatter(await fs.readFile(path.join(POSTS_DIR, file), 'utf8'));
    if (/^(true|yes)$/i.test(data.draft || '')) { console.log(`skipping draft: ${file}`); continue; }
    const old = legacy.get(base) || legacy.get(slug) || {};

    const tokens = marked.lexer(body);

    // title: front matter > posts.json > leading "# Heading" > file name
    let title = data.title || old.title;
    if (!title) {
      const i = tokens.findIndex((t) => t.type !== 'space');
      if (i >= 0 && tokens[i].type === 'heading' && tokens[i].depth === 1) {
        title = inlineText(tokens[i].text);
        tokens.splice(i, 1); // the page template already renders the <h1>
      }
    }
    if (!title) { title = humanize(slug); warn(`posts/${file} has no title; using "${title}". Add "title:" front matter.`); }

    // date: front matter > posts.json > first git commit (full history only) > today
    let date = normalizeDate(data.date) || normalizeDate(old.date) || gitFirstCommitDate(`posts/${file}`);
    if (!date) {
      date = new Date().toISOString().slice(0, 10);
      warn(`posts/${file} has no date; using today (${date}). Add "date: YYYY-MM-DD" front matter so it stays stable across builds.`);
    }
    const updated = normalizeDate(data.updated || data.modified) || date;

    // description: front matter > posts.json > first real paragraph
    let description = data.description || old.description;
    if (!description) {
      const paras = tokens.filter((t) => t.type === 'paragraph' && inlineText(t.text));
      const para = paras.find((t) => !/!\[/.test(t.text)) || paras[0];
      description = para ? inlineText(para.text) : BLOG_DESCRIPTION;
    }
    description = truncate(description.replace(/\s+/g, ' ').trim(), 160);

    const html = rewriteRelativeUrls(marked.parser(tokens));

    // sharing image: front matter > first image in the post > default avatar
    let image = data.image ? rewriteRelativeUrls(`src="${data.image}"`).slice(5, -1) : (html.match(/<img\b[^>]*?\ssrc="([^"]+)"/i) || [])[1];
    const hasPostImage = Boolean(image);
    image = absUrl(image || DEFAULT_IMAGE);

    // warn about local images that don't exist
    for (const m of html.matchAll(/<img\b[^>]*?\ssrc="(\/posts\/[^"#?]+)"/gi)) {
      if (!(await exists(path.join(ROOT, decodeURIComponent(m[1]).replace(/^\//, ''))))) warn(`posts/${file}: image ${m[1]} not found`);
    }

    posts.push({
      slug, file, title, description, date, updated, html, image, hasPostImage,
      url: `${SITE_URL}/posts/${slug}/`,
      wordCount: htmlToText(html).split(' ').filter(Boolean).length,
    });
  }

  for (const slug of legacy.keys()) {
    if (!seen.has(slug)) warn(`posts.json lists "${slug}" but posts/${slug}.md does not exist`);
  }
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return posts;
}

// ----------------------------------------------------------------- pages ---
function postPage(tpl, p) {
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: { '@type': 'WebPage', '@id': p.url },
    url: p.url,
    headline: truncate(p.title, 110),
    description: p.description,
    image: [p.image],
    datePublished: p.date,
    dateModified: p.updated,
    inLanguage: 'en',
    wordCount: p.wordCount,
    author: AUTHOR,
    publisher: { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url },
    isPartOf: { '@type': 'Blog', '@id': `${SITE_URL}/`, name: BLOG_TITLE, url: `${SITE_URL}/` },
  };
  return render(tpl, {
    title: p.title,
    description: p.description,
    url: p.url,
    image: p.image,
    date: p.date,
    updated: p.updated,
    date_display: displayDate(p.date),
    twitter_card: p.hasPostImage ? 'summary_large_image' : 'summary',
    site_name: SITE_NAME,
    twitter_handle: TWITTER_HANDLE,
    author_name: AUTHOR.name,
    author_url: AUTHOR.url,
    jsonld: jsonLd(structured),
    content: p.html,
  });
}

function indexPage(tpl, posts) {
  const items = posts.length
    ? posts.map((p) => `    <li><time datetime="${esc(p.date)}">${esc(displayDate(p.date))}</time><a href="/posts/${esc(p.slug)}/">${esc(p.title)}</a></li>`).join('\n')
    : '    <li class="sub">no posts yet.</li>';
  if (!tpl.includes('<!--POSTS-->')) throw new Error('index.html must contain the <!--POSTS--> marker inside <ul class="posts">');
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': `${SITE_URL}/`,
    url: `${SITE_URL}/`,
    name: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    inLanguage: 'en',
    author: AUTHOR,
    blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: truncate(p.title, 110), url: p.url, datePublished: p.date })),
  };
  return render(tpl.replace('<!--POSTS-->', () => items), { site_url: SITE_URL, jsonld: jsonLd(structured) });
}

function sitemap(posts) {
  const latest = posts.reduce((m, p) => (p.updated > m ? p.updated : m), '');
  const urls = [{ loc: `${SITE_URL}/`, lastmod: latest }, ...posts.map((p) => ({ loc: p.url, lastmod: p.updated }))];
  const body = urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;

// Old links look like /post.html?p=<slug>. On Vercel, vercel.json redirects them
// (301) before this file is served; this page is the fallback for any other host.
function legacyShim(posts) {
  const slugs = jsonLd(posts.map((p) => p.slug));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(BLOG_TITLE)}</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(SITE_URL)}/">
<link rel="stylesheet" href="/style.css">
<script>
(function(){var s=new URLSearchParams(location.search).get('p')||'';var known=${slugs};
location.replace(known.indexOf(s)>-1?'/posts/'+s+'/':'/');})();
</script>
</head>
<body>
<main>
  <p>this page has moved. <a href="/">go to the blog home</a>.</p>
</main>
</body>
</html>
`;
}

const notFoundPage = () => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>page not found - ${esc(SITE_NAME)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
  <p>page not found. <a href="/">back to home</a></p>
</main>
</body>
</html>
`;

// ------------------------------------------------------------------ main ---
async function main() {
  const posts = await loadPosts();

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  // static assets: root-level css/images/fonts, and images/attachments inside posts/ (never the .md sources)
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && STATIC_EXT.has(path.extname(entry.name).toLowerCase())) {
      await fs.copyFile(path.join(ROOT, entry.name), path.join(OUT, entry.name));
    }
  }
  await copyDir(POSTS_DIR, path.join(OUT, 'posts'), (name) => POST_ASSET_EXT.has(path.extname(name).toLowerCase()));

  const postTpl = await fs.readFile(path.join(ROOT, 'templates', 'post.html'), 'utf8');
  for (const p of posts) {
    const dir = path.join(OUT, 'posts', p.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), postPage(postTpl, p));
  }

  await fs.writeFile(path.join(OUT, 'index.html'), indexPage(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'), posts));
  await fs.writeFile(path.join(OUT, 'sitemap.xml'), sitemap(posts));
  await fs.writeFile(path.join(OUT, 'robots.txt'), robots());
  await fs.writeFile(path.join(OUT, 'post.html'), legacyShim(posts));
  await fs.writeFile(path.join(OUT, '404.html'), notFoundPage());

  console.log(`built ${posts.length} post(s) -> dist/  (site: ${SITE_URL})`);
  for (const p of posts) console.log(`  ${p.date}  /posts/${p.slug}/  "${p.title}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
