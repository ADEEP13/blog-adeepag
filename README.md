# blog.adeepag.com

Static blog. Write Markdown in `posts/`, push to GitHub, Vercel builds the site.

## Publishing

Add or edit `posts/<slug>.md` and commit. The file name is the URL: `posts/my-post.md` is published at `/posts/my-post/`.
Use lowercase letters, digits and hyphens. Nothing else needs to be touched (no HTML, no `posts.json`).

Optional front matter at the very top of the file:

```
---
title: My Post Title
date: 2026-10-18
updated: 2026-10-20
description: One or two sentences for search results and link previews (about 150 characters).
image: images/my-post.png
draft: true
---
```

| Field | If missing |
|---|---|
| `title` | `posts.json` entry, else the first `# Heading`, else the file name |
| `date` | `posts.json` entry, else first git commit date (full history only), else today with a build warning. Set it explicitly. |
| `updated` | same as `date` |
| `description` | `posts.json` entry, else the first text paragraph, trimmed to 160 characters |
| `image` | first image in the post, else `/avatar.png` (used for link previews and structured data) |
| `draft: true` | post is skipped entirely |

Files in `posts/` starting with `_` or `.` are ignored. Images go in `posts/images/` and can be referenced as
`![alt](/posts/images/x.png)` or `![alt](images/x.png)`. Links to other posts can be `[text](other-post.md)`.

`posts.json` is now optional. If present, it still supplies `title`, `date` and `description` for posts without front matter.

## What the build produces (`dist/`)

- `posts/<slug>/index.html`: full article HTML, unique title/description, canonical, Open Graph, Twitter Card, `BlogPosting` JSON-LD
- `index.html`: homepage with the post list rendered into the HTML (edit the bio text in the root `index.html`)
- `sitemap.xml`, `robots.txt`
- `post.html`: legacy `?p=<slug>` fallback (Vercel also redirects these with a 308, see `vercel.json`)
- `404.html`, `style.css`, images

The page layout lives in `templates/post.html`. The site URL, author and defaults are constants at the top of `scripts/build.mjs`.

## Local use

```
npm ci
npm test                      # build + verify
python3 -m http.server -d dist
```

`npm run verify` audits `dist/`: unique titles/descriptions, canonicals, OG/Twitter tags, JSON-LD, sitemap, robots, broken links/images.
