'use strict';

// ===========================================================================
// Builds the EnDesk website (download page, landing pages and blog) into a
// directory of static files:  node deploy/site-src/build.js <out-dir>
//
// pages/*.html and posts/*.html start with a JSON header in an HTML comment:
//   <!-- {"title": "...", "description": "...", ...} -->
// Pages set "path"; posts live at /blog/<file name>/ and set "date".
// Everything in static/ is copied as is.
// ===========================================================================

const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.resolve(process.argv[2] || path.join(SRC, '..', 'site-build'));
const ORIGIN = 'https://endesk.enfinito.cloud';
const OG_IMAGE = ORIGIN + '/assets/og.png';
const GITHUB = 'https://github.com/itsxifat/endesk';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function read(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\s*/);
  if (!m) throw new Error(`${file}: missing JSON header comment`);
  return { meta: JSON.parse(m[1]), body: raw.slice(m[0].length) };
}

function list(dir) {
  const full = path.join(SRC, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).filter((f) => f.endsWith('.html')).sort().map((f) => path.join(full, f)) : [];
}

// FAQ structured data from the visible <details><summary>Q</summary><p>A</p></details> items.
function faqLd(body) {
  const items = [...body.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)];
  if (!items.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(([, q, a]) => ({
      '@type': 'Question',
      name: strip(q).replace(/\s+/g, ' ').trim(),
      acceptedAnswer: { '@type': 'Answer', text: strip(a).replace(/\s+/g, ' ').trim() },
    })),
  };
}

function breadcrumbLd(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: ORIGIN + url })),
  };
}

const ORG = { '@type': 'Organization', name: 'EnDesk', url: ORIGIN + '/', logo: ORIGIN + '/assets/icon-512.png' };

const APP_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'EnDesk',
  description: 'Free remote desktop app for Windows and Mac. Control another computer with an ID and a password, in either direction.',
  applicationCategory: 'UtilitiesApplication',
  applicationSubCategory: 'Remote desktop',
  operatingSystem: 'Windows 10, Windows 11, macOS 12 or later',
  url: ORIGIN + '/',
  downloadUrl: [ORIGIN + '/downloads/EnDesk-Setup.exe', ORIGIN + '/downloads/EnDesk-mac.dmg'],
  image: OG_IMAGE,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  publisher: ORG,
  sameAs: [GITHUB],
};

const NAV = [
  ['Download', '/#download'],
  ['Features', '/#features'],
  ['Blog', '/blog/'],
  ['FAQ', '/#faq'],
];

function layout({ url, title, description, body, jsonld = [], type = 'website', extraHead = '' }) {
  const canonical = ORIGIN + url;
  const nav = NAV.map(([name, href]) => {
    const current = href === '/blog/' && url.startsWith('/blog/') ? ' aria-current="page"' : '';
    return `<a href="${href}"${current}>${name}</a>`;
  }).join('\n        ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${canonical}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0b0b0b" media="(prefers-color-scheme: dark)" />
  <meta property="og:site_name" content="EnDesk" />
  <meta property="og:type" content="${type}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="alternate" type="application/rss+xml" title="EnDesk blog" href="/blog/feed.xml" />
  <link rel="stylesheet" href="/assets/site.css" />
  ${jsonld.filter(Boolean).map(ld).join('\n  ')}${extraHead}
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <symbol id="i-win" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5.1 10.4 4v7.2H3zM11.4 3.9 21 2.5v8.7h-9.6zM3 12.3h7.4v7.2L3 18.4zM11.4 12.3H21V21l-9.6-1.4z"/></symbol>
      <symbol id="i-mac" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></symbol>
    </defs>
  </svg>

  <header class="nav">
    <div class="wrap nav-in">
      <a class="brand" href="/"><span class="mark" aria-hidden="true">E</span>EnDesk</a>
      <nav class="links" aria-label="Main">
        ${nav}
      </nav>
      <a class="btn btn-sm" href="/#download">Download</a>
    </div>
  </header>

${body.trim()}

  <footer>
    <div class="wrap foot">
      <div>
        <span class="status"><span class="dot" id="dot"></span><span id="status">EnDesk — free remote desktop for Windows and Mac</span></span>
        <p>Only connect to computers you own or are allowed to access.</p>
      </div>
      <nav aria-label="Footer">
        <a href="/#download">Download</a>
        <a href="/blog/">Blog</a>
        <a href="/anydesk-alternative/">AnyDesk alternative</a>
        <a href="/teamviewer-alternative/">TeamViewer alternative</a>
        <a href="/#help">Install help</a>
        <a href="${GITHUB}" rel="noopener">Source code</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;
}

function write(url, html) {
  const file = path.join(OUT, url, url.endsWith('/') ? 'index.html' : '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(SRC, 'static'), OUT);

const sitemap = [];

// Blog posts.
const posts = list('posts')
  .map((file) => {
    const { meta, body } = read(file);
    const slug = path.basename(file, '.html');
    const words = strip(body).split(/\s+/).filter(Boolean).length;
    return { ...meta, slug, body, url: `/blog/${slug}/`, minutes: Math.max(1, Math.round(words / 220)) };
  })
  .sort((a, b) => (a.date < b.date ? 1 : -1));

const ctaBox = `
      <aside class="cta-box">
        <h2>Try EnDesk</h2>
        <p>Free remote desktop for Windows and Mac. No account needed.</p>
        <div class="cta">
          <a class="btn" href="/downloads/EnDesk-Setup.exe" download><svg><use href="#i-win"/></svg>Download for Windows</a>
          <a class="btn btn-2" href="/downloads/EnDesk-mac.dmg" download><svg><use href="#i-mac"/></svg>Download for Mac</a>
        </div>
      </aside>`;

for (const post of posts) {
  const related = posts.filter((p) => p !== post).slice(0, 3);
  const body = `
  <main class="wrap">
    <article class="article">
      <p class="crumbs"><a href="/blog/">Blog</a></p>
      <h1>${esc(post.title)}</h1>
      <p class="dek">${esc(post.description)}</p>
      <p class="meta"><time datetime="${post.date}">${fmtDate(post.date)}</time> · ${post.minutes} min read</p>
      <div class="prose">
${post.body.trim()}
      </div>
${ctaBox}
      <section class="related">
        <h2>More from the blog</h2>
        <ul class="posts">
          ${related.map((p) => `<li><a href="${p.url}"><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p></a></li>`).join('\n          ')}
        </ul>
      </section>
    </article>
  </main>`;
  write(post.url, layout({
    url: post.url,
    title: `${post.seoTitle || post.title} | EnDesk`,
    description: post.description,
    type: 'article',
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.description,
        datePublished: post.date,
        dateModified: post.updated || post.date,
        author: ORG,
        publisher: ORG,
        image: OG_IMAGE,
        mainEntityOfPage: ORIGIN + post.url,
        keywords: (post.keywords || []).join(', '),
      },
      breadcrumbLd([['Home', '/'], ['Blog', '/blog/'], [post.title, post.url]]),
      faqLd(post.body),
    ],
  }));
  sitemap.push({ url: post.url, lastmod: post.updated || post.date });
}

// Blog index.
const blogUpdated = posts.length ? posts[0].updated || posts[0].date : undefined;
write('/blog/', layout({
  url: '/blog/',
  title: 'Blog — remote desktop guides for Windows and Mac | EnDesk',
  description: 'Guides for remote desktop on Windows and Mac: controlling a Mac from a PC and back, unattended access, staying safe, and choosing a free remote desktop app.',
  body: `
  <main class="wrap">
    <div class="article">
      <h1>Blog</h1>
      <p class="dek">Practical guides for remote desktop on Windows and Mac.</p>
      <ul class="posts" style="margin-top:44px">
        ${posts.map((p) => `<li><a href="${p.url}"><h2>${esc(p.title)}</h2><p>${esc(p.description)}</p><time datetime="${p.date}">${fmtDate(p.date)} · ${p.minutes} min read</time></a></li>`).join('\n        ')}
      </ul>
    </div>
  </main>`,
  jsonld: [
    { '@context': 'https://schema.org', '@type': 'Blog', name: 'EnDesk blog', url: ORIGIN + '/blog/', publisher: ORG },
    breadcrumbLd([['Home', '/'], ['Blog', '/blog/']]),
  ],
}));
sitemap.push({ url: '/blog/', lastmod: blogUpdated });

// RSS feed.
fs.writeFileSync(path.join(OUT, 'blog', 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>EnDesk blog</title>
  <link>${ORIGIN}/blog/</link>
  <atom:link href="${ORIGIN}/blog/feed.xml" rel="self" type="application/rss+xml" />
  <description>Remote desktop guides for Windows and Mac.</description>
  <language>en</language>
${posts.map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${ORIGIN}${p.url}</link>
    <guid>${ORIGIN}${p.url}</guid>
    <pubDate>${new Date(p.date + 'T00:00:00Z').toUTCString()}</pubDate>
    <description>${esc(p.description)}</description>
  </item>`).join('\n')}
</channel>
</rss>
`);

// Pages (home, landing pages). A page's body may use {{posts}} for a list of recent posts.
for (const file of list('pages')) {
  const { meta, body } = read(file);
  const recent = posts.slice(0, meta.postCount || 3)
    .map((p) => `<div class="item"><a href="${p.url}"><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p></a></div>`).join('\n          ');
  const trail = meta.path === '/' ? null : breadcrumbLd([['Home', '/'], [meta.crumb || meta.title, meta.path]]);
  write(meta.path, layout({
    url: meta.path,
    title: meta.title,
    description: meta.description,
    body: body.replace('{{posts}}', recent),
    jsonld: [meta.app ? APP_LD : null, trail, faqLd(body)],
  }));
  sitemap.push({ url: meta.path, lastmod: meta.updated });
}

// sitemap.xml and robots.txt.
sitemap.sort((a, b) => (a.url === '/' ? -1 : b.url === '/' ? 1 : a.url.localeCompare(b.url)));
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map((s) => `  <url><loc>${ORIGIN}${s.url}</loc>${s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *
Allow: /
Disallow: /relay
Disallow: /health
Disallow: /downloads/

Sitemap: ${ORIGIN}/sitemap.xml
`);

console.log(`built ${sitemap.length} pages into ${OUT}`);
