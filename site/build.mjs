// Builds the Dragonvale GitHub Pages site from the Markdown in this repository.
//
//   node build.mjs            -> writes ../_site
//
// Besides rendering each page, it walks each page's git history and writes a
// rendered snapshot of every earlier version to _site/versions/<page>/<sha>.html.
// The browser (assets/chronicle.js) fetches one of those snapshots and diffs it
// against the current page to highlight what changed.
//
// Needs the full git history: in CI, check out with fetch-depth: 0.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import GithubSlugger from 'github-slugger';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SITE_DIR, '..');
const OUT = path.join(REPO, '_site');
const config = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'config.json'), 'utf8'));

// ---------------------------------------------------------------- git helpers

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const isExcluded = (p) =>
  config.exclude.some((pattern) => p === pattern || p.startsWith(pattern.replace(/\/?$/, '/')));

const tracked = git('ls-files', '-z')
  .split('\0')
  .filter(Boolean)
  .filter((p) => !isExcluded(p))
  .filter((p) => fs.existsSync(path.join(REPO, p))); // deleted locally but not yet committed

const pages = tracked.filter((p) => p.endsWith('.md'));
const assets = tracked.filter((p) => !p.endsWith('.md') && !/(^|\/)\.git(attributes|ignore)$/.test(p));

if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
  console.warn('warning: shallow clone - page histories will be incomplete (use fetch-depth: 0)');
}

/** Versions of one file, newest first, following renames. Unchanged-content commits are dropped. */
function history(file) {
  const out = git('log', '--follow', '--name-only', '--format=%x00%H%x09%aI%x09%s', '--', file);
  const versions = [];
  for (const chunk of out.split('\0').filter((c) => c.trim())) {
    const [header, ...rest] = chunk.split('\n');
    const [sha, date, ...subject] = header.split('\t');
    const pathAtCommit = rest.map((l) => l.trim()).find(Boolean);
    if (!pathAtCommit) continue;
    let source;
    try {
      source = git('show', `${sha}:${pathAtCommit}`);
    } catch {
      continue; // deleted at this commit
    }
    versions.push({ sha: sha.slice(0, 10), date, subject: subject.join('\t'), path: pathAtCommit, source });
  }
  // Collapse runs where the content did not change (e.g. pure renames).
  return versions.filter((v, i) => i === versions.length - 1 || v.source !== versions[i + 1].source);
}

// ------------------------------------------------------------- markdown setup

const outPath = (mdPath) =>
  /(^|\/)readme\.md$/i.test(mdPath) ? mdPath.replace(/readme\.md$/i, 'index.html') : mdPath.replace(/\.md$/i, '.html');

function makeRenderer() {
  const slugger = new GithubSlugger();
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(anchor, {
      slugify: (s) => slugger.slug(s),
      permalink: anchor.permalink.linkInsideHeader({ symbol: '¶', placement: 'after', class: 'heading-anchor', ariaHidden: true }),
    })
    .use(footnote)
    .use(taskLists, { enabled: false });

  // Rewrite relative links to other Markdown pages so they point at the rendered .html.
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, e, self) => self.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href');
    if (href && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) {
      const [, p, hash = ''] = href.match(/^([^#]*)(#.*)?$/);
      if (/\.md$/i.test(p)) tokens[idx].attrSet('href', outPath(p) + hash);
    }
    if (href && /^https?:/i.test(href)) tokens[idx].attrSet('rel', 'noopener');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  // ```yaml blocks hold creature stat blocks ("Key: value" lines, optionally nested); show them as
  // a key/value list that reads like the surrounding prose. Anything else stays a code block.
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.info.trim().toLowerCase() === 'yaml') {
      const html = statBlockHtml(t.content);
      if (html) return html;
    }
    return defaultFence(tokens, idx, options, env, self);
  };
  // Wide tables scroll sideways inside a wrapper instead of being clipped.
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return { md, reset: () => slugger.reset() };
}

/**
 * Parses loose "Key: value" stat-block YAML (tabs or spaces after the colon, indentation for
 * nesting, unkeyed lines continuing the previous value) into table rows. Returns null if the
 * block doesn't look like that, so it can render as ordinary code instead.
 */
function statBlockHtml(content) {
  const rows = [];
  const indents = [];
  for (const raw of content.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const m = raw.match(/^\s*([^:\s(][^:]{0,40}?)\s*:(?:\s+(.*))?$/);
    if (m) {
      while (indents.length && indents.at(-1) > indent) indents.pop();
      if (!indents.length || indents.at(-1) < indent) indents.push(indent);
      rows.push({ depth: indents.length - 1, key: m[1].trim(), value: (m[2] ?? '').trim() });
    } else if (rows.length) {
      const last = rows.at(-1);
      last.value = `${last.value} ${raw.trim()}`.trim();
    } else {
      return null;
    }
  }
  if (!rows.length) return null;
  const body = rows
    .map((r, i) => {
      const cls = r.depth ? ` class="sb-depth-${Math.min(r.depth, 3)}"` : '';
      const isGroup = !r.value && rows[i + 1]?.depth > r.depth;
      return isGroup
        ? `<tr${cls}><th colspan="2" class="sb-group">${esc(r.key)}</th></tr>`
        : `<tr${cls}><th scope="row">${esc(r.key)}</th><td>${esc(r.value)}</td></tr>`;
    })
    .join('\n');
  return `<table class="statblock">\n${body}\n</table>\n`;
}

const renderer = makeRenderer();
const OUTLINE_LEVELS = [2, 3, 4];

/** Renders Markdown and collects the headings (with their anchor ids) for the page outline. */
function render(source) {
  renderer.reset();
  const env = {};
  const tokens = renderer.md.parse(source, env);
  const headings = [];
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open') return;
    const level = Number(t.tag.slice(1));
    const id = t.attrGet('id');
    if (!id || !OUTLINE_LEVELS.includes(level)) return;
    const text = (tokens[i + 1].children ?? [])
      .filter((c) => c.type === 'text' || c.type === 'code_inline')
      .map((c) => c.content)
      .join('')
      .trim();
    if (text) headings.push({ level, id, text });
  });
  return { html: renderer.md.renderer.render(tokens, renderer.md.options, env), headings };
}

function outlineHtml(headings) {
  // Nest each heading under the nearest earlier heading of a higher rank, so sections can fold.
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of headings) {
    while (stack.length > 1 && stack.at(-1).level >= h.level) stack.pop();
    const node = { ...h, children: [] };
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  let foldable = 0;
  const list = (nodes, depth, id) =>
    `<ol${id ? ` id="${id}"` : ''}>${nodes
      .map((n) => {
        const link = `<a href="#${encodeURIComponent(n.id)}">${esc(n.text)}</a>`;
        if (!n.children.length) return `<li class="lvl-${depth}"><div class="outline-row">${link}</div></li>`;
        const sub = `outline-sub-${++foldable}`;
        return `<li class="lvl-${depth} has-sub"><div class="outline-row"><button type="button" class="outline-fold" aria-expanded="true" aria-controls="${sub}" aria-label="Subsections of ${esc(n.text)}"><span aria-hidden="true">▸</span></button>${link}</div>${list(n.children, depth + 1, sub)}</li>`;
      })
      .join('')}</ol>`;
  const items = list(root.children, 0, 'outline-list');
  const tools = foldable
    ? `<div class="outline-tools"><button type="button" class="outline-fold-all" data-fold="all">Fold all</button><button type="button" class="outline-fold-all" data-fold="none">Unfold all</button></div>`
    : '';
  return `<nav id="outline" class="outline panel" aria-label="On this page" role="tabpanel">
    <div class="panel-head"><span class="panel-title">On this page</span><button type="button" class="panel-collapse" data-panel="outline" aria-controls="outline-list" aria-expanded="true" title="Hide the outline"><span aria-hidden="true">»</span></button></div>
    ${tools}
    ${items}
  </nav>`;
}

function titleOf(source, file) {
  const h1 = source.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (h1) return h1[1].replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return path.basename(file, '.md').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ----------------------------------------------------------------- templates

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const prettyDir = (d) =>
  config.directoryTitles[d] ??
  d.split('/').pop().replace(/^campaign-/, 'Campaign: ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Directory tree used for the sidebar and directory index pages. */
function buildTree(entries) {
  const root = { name: '', dirs: new Map(), pages: [] };
  for (const e of entries) {
    const parts = e.file.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), pages: [] });
      node = node.dirs.get(part);
    }
    node.pages.push(e);
  }
  return root;
}

function navHtml(node, rel, current, dirPath = '') {
  const pagesHtml = node.pages
    .filter((p) => !(dirPath === '' && p.out === 'index.html'))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(
      (p) =>
        `<li><a href="${rel}${esc(p.out)}" data-page="${esc(p.out)}"${p.out === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`,
    )
    .join('');
  const dirsHtml = [...node.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const dp = dirPath ? `${dirPath}/${d.name}` : d.name;
      const open = current.startsWith(dp + '/') ? ' open' : '';
      return `<li class="dir"><details${open}><summary>${esc(prettyDir(d.name))}</summary>${navHtml(d, rel, current, dp)}</details></li>`;
    })
    .join('');
  return `<ul>${pagesHtml}${dirsHtml}</ul>`;
}

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function layout({ title, body, rel, current, tree, pageMeta, breadcrumbs, headings = [] }) {
  const hasOutline = headings.length >= 2;
  const crumbs = breadcrumbs
    .map((c) => (c.href ? `<a href="${rel}${esc(c.href)}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`))
    .join('<span class="sep" aria-hidden="true">❧</span>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=IM+Fell+English+SC&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${rel}assets/style.css">
<link rel="icon" href="${rel}assets/favicon.svg" type="image/svg+xml">
<script>(function(){var d=document.documentElement,s={};try{s=JSON.parse(localStorage.getItem('dragonvale:panels'))||{}}catch(e){}if(s.sidebar===false)d.classList.add('sidebar-collapsed');if(s.outline===false||(s.outline==null&&innerWidth<1200))d.classList.add('outline-collapsed')})()</script>
</head>
<body data-root="${rel}"${pageMeta ? ` data-page="${esc(current)}"` : ''}${hasOutline ? '' : ' class="no-outline"'}>
<a class="skip" href="#content">Skip to content</a>
<header class="masthead">
  <button class="nav-toggle" aria-controls="drawer" aria-expanded="false" title="Contents">☰</button>
  <a class="brand" href="${rel}index.html"><span class="brand-mark" aria-hidden="true">⚜</span> ${esc(config.title)}</a>
  <a class="masthead-link" href="${rel}changes.html">Recent Changes</a>
</header>
<div class="frame">
  <div id="drawer" class="drawer"${hasOutline ? '' : ' data-tab="sidebar"'}>
    ${
      hasOutline
        ? `<div class="drawer-tabs" role="tablist" aria-label="Navigation">
      <button type="button" role="tab" data-tab="sidebar" aria-controls="sidebar" aria-selected="true">Pages</button>
      <button type="button" role="tab" data-tab="outline" aria-controls="outline" aria-selected="false">On this page</button>
    </div>`
        : ''
    }
    <nav id="sidebar" class="sidebar panel" aria-label="Contents" role="tabpanel">
      <div class="panel-head"><span class="panel-title">Pages</span><button type="button" class="panel-collapse" data-panel="sidebar" aria-controls="sidebar-body" aria-expanded="true" title="Hide the page list"><span aria-hidden="true">«</span></button></div>
      <div id="sidebar-body" class="panel-body">
        <input type="search" class="nav-filter" placeholder="Seek a page…" aria-label="Filter pages">
        ${navHtml(tree, rel, current)}
      </div>
    </nav>
    ${hasOutline ? outlineHtml(headings) : ''}
  </div>
  <main id="content">
    <nav class="breadcrumbs" aria-label="Breadcrumbs">${crumbs}</nav>
    ${pageMeta ? chronicleHtml(pageMeta) : ''}
    <article class="page">${body}</article>
    ${pageMeta ? `<footer class="page-foot">Last amended ${esc(fmtDate(pageMeta.versions[0].date))} · <a href="${esc(config.repoUrl)}/blob/main/${esc(pageMeta.file)}">source</a> · <a href="${esc(config.repoUrl)}/commits/main/${esc(pageMeta.file)}">full history</a></footer>` : ''}
  </main>
</div>
<script src="${rel}assets/diff.min.js" defer></script>
<script src="${rel}assets/chronicle.js" defer></script>
</body>
</html>
`;
}

function chronicleHtml(meta) {
  const older = meta.versions.slice(1);
  const data = { current: meta.versions[0].sha, page: meta.out, versions: meta.versions.map(({ sha, date, subject }) => ({ sha, date, subject })) };
  const options = older
    .map((v) => `<option value="${esc(v.sha)}">${esc(fmtDate(v.date))} — ${esc(v.subject)}</option>`)
    .join('');
  return `<aside class="chronicle" aria-label="Page history">
  <script type="application/json" id="page-versions">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  <div class="chronicle-notice" hidden></div>
  ${
    older.length
      ? `<div class="chronicle-controls">
    <label for="since-version">Show changes since</label>
    <select id="since-version"><option value="">— the current version only —</option>${options}</select>
    <span class="or">or</span>
    <label class="visually-hidden" for="since-date">since date</label>
    <input type="date" id="since-date" title="Show changes made after this date">
  </div>
  <div class="chronicle-status" hidden>
    <span class="chronicle-summary" role="status"></span>
    <span class="chronicle-buttons">
      <button type="button" data-act="prev" title="Previous change (p)">▲ Prev</button>
      <button type="button" data-act="next" title="Next change (n)">▼ Next</button>
      <label class="toggle"><input type="checkbox" id="show-removed"> Show removed text</label>
      <button type="button" data-act="clear">Clear</button>
    </span>
  </div>`
      : `<p class="chronicle-none">This page has not changed since it was first written on ${esc(fmtDate(meta.versions[0].date))}.</p>`
  }
</aside>`;
}

// --------------------------------------------------------------------- build

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const write = (rel, content) => {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
};

const entries = [];
for (const file of pages) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8');
  const versions = history(file);
  // Uncommitted edits (local builds) show up as a working-copy "version".
  if (!versions.length || versions[0].source !== source) {
    versions.unshift({ sha: 'working', date: new Date().toISOString(), subject: 'Uncommitted changes', path: file, source });
  }
  entries.push({ file, out: outPath(file), title: titleOf(source, file), source, versions });
}

const tree = buildTree(entries);
const relRoot = (out) => '../'.repeat(out.split('/').length - 1);

function crumbsFor(out, title) {
  const parts = out.split('/').slice(0, -1);
  const crumbs = [{ label: config.title, href: 'index.html' }];
  parts.forEach((part, i) => crumbs.push({ label: prettyDir(part), href: parts.slice(0, i + 1).join('/') + '/index.html' }));
  if (out !== 'index.html') crumbs.push({ label: title });
  return crumbs;
}

let versionCount = 0;
for (const e of entries) {
  const rel = relRoot(e.out);
  const meta = { file: e.file, out: e.out, versions: e.versions };
  let { html: body, headings } = render(e.source);
  if (e.out === 'index.html') body += homeExtras(rel);
  write(e.out, layout({ title: e.title, body, rel, current: e.out, tree, pageMeta: meta, breadcrumbs: crumbsFor(e.out, e.title), headings }));

  // Rendered snapshots of every earlier version, fetched by chronicle.js.
  for (const v of e.versions.slice(1)) {
    write(`versions/${e.out.replace(/\.html$/, '')}/${v.sha}.html`, render(v.source).html);
    versionCount++;
  }
}

function homeExtras(rel) {
  const recent = entries
    .filter((e) => e.out !== 'index.html')
    .sort((a, b) => b.versions[0].date.localeCompare(a.versions[0].date))
    .slice(0, 8)
    .map((e) => `<li><a href="${rel}${esc(e.out)}" data-page="${esc(e.out)}">${esc(e.title)}</a> <span class="when">${esc(fmtDate(e.versions[0].date))}</span></li>`)
    .join('');
  return `<section class="home-recent"><h2>Lately Amended</h2><ul class="recent-list">${recent}</ul><p><a href="${rel}changes.html">The full chronicle of changes →</a></p></section>`;
}

// Directory index pages (unless the directory has its own README).
(function dirIndexes(node, dirPath) {
  for (const [name, child] of node.dirs) {
    const dp = dirPath ? `${dirPath}/${name}` : name;
    const out = `${dp}/index.html`;
    if (!entries.some((e) => e.out === out)) {
      const rel = relRoot(out);
      const body = `<h1>${esc(prettyDir(name))}</h1>${navHtml(child, rel, out, dp)
        .replace('<ul>', '<ul class="dir-index">')}`;
      write(out, layout({ title: prettyDir(name), body, rel, current: out, tree, breadcrumbs: crumbsFor(out, prettyDir(name)).slice(0, -1) }));
    }
    dirIndexes(child, dp);
  }
})(tree, '');

// Recent changes: one entry per commit, listing the pages it touched.
{
  const byCommit = new Map();
  for (const e of entries) {
    e.versions.forEach((v, i) => {
      if (v.sha === 'working') return;
      if (!byCommit.has(v.sha)) byCommit.set(v.sha, { ...v, pages: [] });
      byCommit.get(v.sha).pages.push({ e, prev: e.versions[i + 1]?.sha ?? null });
    });
  }
  const commits = [...byCommit.values()].sort((a, b) => b.date.localeCompare(a.date));
  const rows = commits
    .map(
      (c) => `<li class="change" data-date="${esc(c.date)}">
  <div class="change-head"><span class="when">${esc(fmtDate(c.date))}</span> <span class="what">${esc(c.subject)}</span></div>
  <ul>${c.pages
    .sort((a, b) => a.e.title.localeCompare(b.e.title))
    .map(({ e, prev }) => `<li><a href="${esc(e.out)}${prev ? `?since=${prev}` : ''}" data-page="${esc(e.out)}">${esc(e.title)}</a>${prev ? '' : ' <span class="tag">new</span>'}</li>`)
    .join('')}</ul>
</li>`,
    )
    .join('\n');
  const body = `<h1>Recent Changes</h1>
<p class="lede">Every amendment to the chronicle, newest first. Following a link shows that page with the changes from that amendment highlighted.</p>
<div class="catchup">
  <label for="catchup-date">Catch up on everything changed since</label>
  <input type="date" id="catchup-date">
  <div id="catchup-results" role="status"></div>
</div>
<script type="application/json" id="all-pages">${JSON.stringify(
    entries.map((e) => ({ out: e.out, title: e.title, versions: e.versions.map(({ sha, date }) => ({ sha, date })) })),
  ).replace(/</g, '\\u003c')}</script>
<ol class="changes">${rows}</ol>`;
  write('changes.html', layout({ title: 'Recent Changes', body, rel: '', current: 'changes.html', tree, breadcrumbs: [{ label: config.title, href: 'index.html' }, { label: 'Recent Changes' }] }));
}

// Static assets and repository files (PDFs, images, character sheets).
for (const a of fs.readdirSync(path.join(SITE_DIR, 'assets'))) {
  fs.cpSync(path.join(SITE_DIR, 'assets', a), path.join(OUT, 'assets', a));
}
fs.cpSync(path.join(SITE_DIR, 'node_modules/diff/dist/diff.min.js'), path.join(OUT, 'assets/diff.min.js'));
for (const a of assets) {
  if (a.startsWith('site/') || a.startsWith('.github/') || a.startsWith('.devcontainer/')) continue;
  fs.mkdirSync(path.dirname(path.join(OUT, a)), { recursive: true });
  fs.copyFileSync(path.join(REPO, a), path.join(OUT, a));
}
write('.nojekyll', '');
write('manifest.json', JSON.stringify(Object.fromEntries(entries.map((e) => [e.out, { sha: e.versions[0].sha, date: e.versions[0].date }]))));

console.log(`Built ${entries.length} pages and ${versionCount} historical versions into ${path.relative(process.cwd(), OUT) || OUT}`);
