// Dragonvale chronicle: navigation niceties plus "show me what changed".
//
// Each page embeds its version list (#page-versions). Picking an earlier version
// fetches that version's rendered HTML from versions/<page>/<sha>.html, splits
// both old and current pages into blocks (paragraphs, list items, table rows,
// headings...), lines the blocks up with an LCS diff, and then word-diffs the
// blocks that were amended. The current page stays fully readable; new words are
// highlighted in place and changed blocks get a mark in the margin.
//
// Every reader's browser also remembers which version of each page it last saw,
// so returning readers are offered the changes since their last visit.
(() => {
  'use strict';
  const root = document.body.dataset.root || '';
  const STORE_KEY = 'dragonvale:lastRead';
  const fmtDate = (iso) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function saveStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode etc. */ }
  }

  // ------------------------------------------------------------- navigation

  const sidebar = document.getElementById('sidebar');
  const outline = document.getElementById('outline');
  const drawer = document.getElementById('drawer');
  const toggle = document.querySelector('.nav-toggle');
  const narrow = window.matchMedia('(max-width: 820px)');
  const PANELS_KEY = 'dragonvale:panels';
  const TAB_KEY = 'dragonvale:drawerTab';

  // Small screens: one slide-out drawer holding both navigations behind tabs.
  const masthead = document.querySelector('.masthead');
  function setDrawer(open) {
    if (open) document.documentElement.style.setProperty('--masthead-h', `${masthead.getBoundingClientRect().bottom}px`);
    drawer.classList.toggle('open', open);
    toggle?.setAttribute('aria-expanded', String(open));
  }
  toggle?.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) { setDrawer(false); toggle?.focus(); }
  });

  const tabs = [...drawer.querySelectorAll('[role="tab"]')];
  function selectTab(name) {
    drawer.dataset.tab = name;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    try { sessionStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
  }
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  if (outline) {
    let saved = null;
    try { saved = sessionStorage.getItem(TAB_KEY); } catch { /* ignore */ }
    selectTab(saved === 'outline' ? 'outline' : 'sidebar');
  }

  // Wide screens: each side panel can be folded down to a slim rail.
  const html = document.documentElement;
  function syncPanel(btn) {
    const name = btn.dataset.panel;
    const collapsed = html.classList.contains(`${name}-collapsed`);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = `${collapsed ? 'Show' : 'Hide'} the ${name === 'sidebar' ? 'page list' : 'outline'}`;
  }
  document.querySelectorAll('.panel-collapse').forEach((btn) => {
    syncPanel(btn);
    // A folded panel's whole rail is a target for unfolding it.
    btn.closest('.panel').addEventListener('click', (e) => {
      if (e.target.closest('.panel-collapse') || narrow.matches) return;
      if (html.classList.contains(`${btn.dataset.panel}-collapsed`)) btn.click();
    });
    btn.addEventListener('click', () => {
      const name = btn.dataset.panel;
      const collapsed = html.classList.toggle(`${name}-collapsed`);
      syncPanel(btn);
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(PANELS_KEY)) || {}; } catch { /* ignore */ }
      prefs[name] = !collapsed;
      try { localStorage.setItem(PANELS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
    });
  });

  // The outline: fold long sections, close the drawer after a jump, and mark the section being read.
  if (outline) {
    const links = [...outline.querySelectorAll('a[href^="#"]')];
    const ids = links.map((a) => decodeURIComponent(a.hash.slice(1)));
    const FOLDS_KEY = `dragonvale:folds:${location.pathname}`;
    const folds = [...outline.querySelectorAll('.outline-fold')];
    const sectionId = (btn) => decodeURIComponent(btn.nextElementSibling.hash.slice(1));
    function setFold(btn, folded) {
      btn.closest('li').classList.toggle('folded', folded);
      btn.setAttribute('aria-expanded', String(!folded));
    }
    function saveFolds() {
      const folded = folds.filter((b) => b.getAttribute('aria-expanded') === 'false').map(sectionId);
      try { sessionStorage.setItem(FOLDS_KEY, JSON.stringify(folded)); } catch { /* ignore */ }
    }
    try {
      const saved = new Set(JSON.parse(sessionStorage.getItem(FOLDS_KEY)) || []);
      folds.forEach((b) => { if (saved.has(sectionId(b))) setFold(b, true); });
    } catch { /* ignore */ }
    outline.addEventListener('click', (e) => {
      const fold = e.target.closest('.outline-fold');
      const all = e.target.closest('.outline-fold-all');
      if (fold) setFold(fold, fold.getAttribute('aria-expanded') === 'true');
      else if (all) folds.forEach((b) => setFold(b, all.dataset.fold === 'all'));
      else if (e.target.closest('a') && narrow.matches) setDrawer(false);
      if (fold || all) { saveFolds(); refold = true; queue(); }
    });
    let current = -1;
    let queued = false;
    let refold = false; // folding moves where the marker shows, even with no scroll
    const spy = () => {
      queued = false;
      // Headings are looked up afresh each time: the change highlighter rebuilds the article.
      const line = parseFloat(getComputedStyle(html).scrollPaddingTop) + 24 || 96;
      let active = -1;
      for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (!el || el.offsetParent === null) continue;
        if (el.getBoundingClientRect().top <= line) active = i;
        else break;
      }
      if (active === current && !refold) return;
      refold = false;
      links[current]?.removeAttribute('aria-current');
      outline.querySelector('.holds-current')?.classList.remove('holds-current');
      current = active;
      const link = links[current];
      if (!link) return;
      link.setAttribute('aria-current', 'location');
      // Inside a folded section, the outermost fold stands in for the hidden entry.
      const folded = [...outline.querySelectorAll('li.folded')].find((li) => li.contains(link) && li.querySelector('a') !== link);
      folded?.classList.add('holds-current');
      const shown = folded ? folded.querySelector('a') : link;
      // Keep the marked entry visible inside a long outline without moving the page.
      const top = shown.getBoundingClientRect().top - outline.getBoundingClientRect().top + outline.scrollTop;
      if (top < outline.scrollTop + 40 || top > outline.scrollTop + outline.clientHeight - 40) {
        outline.scrollTop = top - outline.clientHeight / 3;
      }
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    spy();
  }

  const filter = document.querySelector('.nav-filter');
  filter?.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    sidebar.querySelectorAll('li').forEach((li) => {
      if (li.classList.contains('dir')) return;
      li.hidden = q && !li.textContent.toLowerCase().includes(q);
    });
    sidebar.querySelectorAll('li.dir').forEach((li) => {
      const any = [...li.querySelectorAll('li:not(.dir)')].some((x) => !x.hidden);
      li.hidden = q && !any;
      if (q && any) li.querySelector('details').open = true;
    });
  });

  // Mark pages that changed since this reader last read them.
  fetch(root + 'manifest.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((manifest) => {
      const store = loadStore();
      document.querySelectorAll('.sidebar a[data-page], .recent-list a[data-page]').forEach((a) => {
        const seen = store[a.dataset.page];
        const now = manifest[a.dataset.page];
        if (seen && now && seen.sha !== now.sha) {
          a.classList.add('unread');
          a.title = `Amended since you last read it (${fmtDate(seen.at)})`;
          if (!a.search) a.search = `?since=${encodeURIComponent(seen.sha)}`;
        }
      });
    })
    .catch(() => {});

  // ------------------------------------------------- the catch-up date carries across pages

  const params = new URLSearchParams(location.search);
  const sinceParam = params.get('since');
  if (isDate(sinceParam)) {
    // Carry a date-based catch-up along as the reader moves between pages.
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.origin === location.origin && /\.html$/.test(a.pathname) && !a.search && !a.closest('.page-foot')) {
        a.search = `?since=${sinceParam}`;
      }
    });
  }

  // --------------------------------------------------------- recent changes

  const catchupDate = document.getElementById('catchup-date');
  if (catchupDate) {
    const all = JSON.parse(document.getElementById('all-pages').textContent);
    const out = document.getElementById('catchup-results');
    const update = () => {
      const d = catchupDate.value;
      document.querySelectorAll('li.change').forEach((li) => {
        li.classList.toggle('dim', isDate(d) && li.dataset.date.slice(0, 10) <= d);
      });
      if (!isDate(d)) { out.innerHTML = ''; return; }
      const changed = all
        .filter((p) => p.versions[0].date.slice(0, 10) > d)
        .sort((a, b) => a.title.localeCompare(b.title));
      out.innerHTML = changed.length
        ? `<p>${changed.length} page${changed.length === 1 ? '' : 's'} amended after ${fmtDate(d)}. Each opens with the changes highlighted, and the date follows you from page to page.</p><ul class="catchup-list">${changed
            .map((p) => {
              const isNew = p.versions[p.versions.length - 1].date.slice(0, 10) > d;
              return `<li><a href="${p.out}?since=${d}">${escapeHtml(p.title)}</a>${isNew ? ' <span class="tag">new</span>' : ''}</li>`;
            })
            .join('')}</ul>`
        : `<p>Nothing has been amended after ${fmtDate(d)}.</p>`;
    };
    catchupDate.addEventListener('input', update);
    if (isDate(sinceParam)) { catchupDate.value = sinceParam; }
    update();
  }

  // ---------------------------------------------------------- page compare

  const dataEl = document.getElementById('page-versions');
  if (!dataEl) return;
  const meta = JSON.parse(dataEl.textContent);
  const article = document.querySelector('article.page');
  const pristine = article.innerHTML;
  const select = document.getElementById('since-version');
  const dateInput = document.getElementById('since-date');
  const status = document.querySelector('.chronicle-status');
  const summary = document.querySelector('.chronicle-summary');
  const notice = document.querySelector('.chronicle-notice');
  const showRemoved = document.getElementById('show-removed');
  const byShaIndex = new Map(meta.versions.map((v, i) => [v.sha, i]));

  /** The newest version that existed at the end of the given day (null if the page is newer). */
  function versionAsOf(day) {
    return meta.versions.find((v) => v.date.slice(0, 10) <= day) || null;
  }

  // Remember this visit, but keep the previous record for this page view.
  const store = loadStore();
  const lastRead = store[meta.page];
  store[meta.page] = { sha: meta.current, at: new Date().toISOString() };
  saveStore(store);

  let changeEls = [];
  let cursor = -1;

  async function compare(spec) {
    article.innerHTML = pristine;
    article.classList.remove('comparing', 'show-removed');
    changeEls = [];
    cursor = -1;
    if (!spec) { status.hidden = true; return; }

    let base; // version object or null (page did not exist yet)
    let label;
    if (isDate(spec.date)) {
      base = versionAsOf(spec.date);
      label = `since ${fmtDate(spec.date)}`;
    } else {
      base = meta.versions[byShaIndex.get(spec.sha)];
      label = `since the version of ${fmtDate(base.date)} (“${base.subject}”)`;
    }
    status.hidden = false;
    if (base && base.sha === meta.current) {
      summary.textContent = `Nothing on this page has changed ${label}.`;
      return;
    }
    summary.textContent = 'Consulting the archives…';
    let oldBody;
    if (base) {
      const url = `${root}versions/${meta.page.replace(/\.html$/, '')}/${base.sha}.html`;
      const res = await fetch(url);
      if (!res.ok) { summary.textContent = `Could not load the earlier version (${res.status}).`; return; }
      oldBody = new DOMParser().parseFromString(await res.text(), 'text/html').body;
    } else {
      oldBody = document.createElement('div');
    }
    const counts = highlight(oldBody, article);
    article.classList.add('comparing');
    article.classList.toggle('show-removed', showRemoved.checked);
    changeEls = [...article.querySelectorAll('.chg-block, .chg-removed-block')];

    const bits = [];
    if (counts.added) bits.push(`${counts.added} new passage${counts.added === 1 ? '' : 's'}`);
    if (counts.modified) bits.push(`${counts.modified} amended`);
    if (counts.removed) bits.push(`${counts.removed} struck out`);
    summary.textContent = !base
      ? `This whole page was written ${label}.`
      : bits.length
        ? `Changes ${label}: ${bits.join(', ')}.`
        : `Only formatting has changed ${label}.`;
    updateNavButtons();
  }

  function updateNavButtons() {
    const visible = visibleChanges();
    status.querySelectorAll('[data-act=prev],[data-act=next]').forEach((b) => (b.disabled = visible.length === 0));
  }
  const visibleChanges = () => changeEls.filter((el) => el.offsetParent !== null);

  function go(delta) {
    const visible = visibleChanges();
    if (!visible.length) return;
    // Start from whatever is on screen, so "next" means next below the fold.
    const top = 120;
    if (cursor < 0 || !visible.includes(changeEls[cursor])) {
      const idx = visible.findIndex((el) => el.getBoundingClientRect().top > top + 1);
      cursor = changeEls.indexOf(visible[delta > 0 ? (idx < 0 ? visible.length - 1 : idx) : Math.max(0, (idx < 0 ? visible.length : idx) - 1)]);
    } else {
      const vi = visible.indexOf(changeEls[cursor]);
      cursor = changeEls.indexOf(visible[(vi + delta + visible.length) % visible.length]);
    }
    const el = changeEls[cursor];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('chg-flash');
    void el.offsetWidth;
    el.classList.add('chg-flash');
  }

  function setUrl(spec) {
    const p = new URLSearchParams(location.search);
    if (spec) p.set('since', spec.date || spec.sha); else p.delete('since');
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  }

  function apply(spec) {
    if (select) select.value = spec?.sha || '';
    if (dateInput) dateInput.value = spec?.date || '';
    setUrl(spec);
    compare(spec).catch((err) => { summary.textContent = `Something went awry: ${err.message}`; });
  }

  select?.addEventListener('change', () => apply(select.value ? { sha: select.value } : null));
  dateInput?.addEventListener('change', () => apply(isDate(dateInput.value) ? { date: dateInput.value } : null));
  showRemoved?.addEventListener('change', () => {
    article.classList.toggle('show-removed', showRemoved.checked);
    updateNavButtons();
  });
  status?.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'next') go(1);
    if (act === 'prev') go(-1);
    if (act === 'clear') apply(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'j') go(1);
    if (e.key === 'p' || e.key === 'k') go(-1);
  });

  // What to show on arrival.
  if (sinceParam && (isDate(sinceParam) || byShaIndex.has(sinceParam)) && meta.versions.length > 1) {
    apply(isDate(sinceParam) ? { date: sinceParam } : { sha: sinceParam });
    if (isDate(sinceParam)) {
      showNotice(`<span>Catching up on everything amended since <strong>${fmtDate(sinceParam)}</strong>; links to other pages keep the same date.</span> <button type="button" data-stop>Stop catching up</button>`);
      notice.querySelector('[data-stop]').addEventListener('click', () => {
        notice.hidden = true;
        document.querySelectorAll('a[href*="since="]').forEach((a) => {
          if (a.origin === location.origin && !a.closest('.changes')) a.search = '';
        });
        apply(null);
      });
    }
  } else if (lastRead && lastRead.sha !== meta.current && meta.versions.length > 1) {
    const spec = byShaIndex.has(lastRead.sha) ? { sha: lastRead.sha } : { date: lastRead.at.slice(0, 10) };
    showNotice(`<span>This page has been amended since you last read it on <strong>${fmtDate(lastRead.at)}</strong>.</span> <button type="button" data-show>Show me what changed</button>`);
    notice.querySelector('[data-show]').addEventListener('click', () => {
      notice.hidden = true;
      apply(spec);
      setTimeout(() => go(1), 50);
    });
  }

  function showNotice(html) {
    notice.innerHTML = html;
    notice.hidden = false;
  }

  // ------------------------------------------------------------ the differ

  const UNIT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TR', 'PRE', 'DT', 'DD', 'BLOCKQUOTE', 'HR', 'FIGCAPTION', 'CAPTION']);
  const SKIP = '.heading-anchor, .footnote-backref, .chg-removed-block';

  /**
   * Splits a rendered page into its smallest blocks. Each unit lists its own text
   * (excluding nested blocks) as segments; segments with node === null are
   * separators (line breaks, table cell borders) that exist only for diffing.
   */
  function units(container) {
    const list = [];
    container.querySelectorAll([...UNIT_TAGS].join(',')).forEach((el) => {
      if (el.closest(SKIP)) return;
      const segs = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) segs.push({ node: child, text: child.nodeValue });
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (UNIT_TAGS.has(child.tagName) || child.matches(SKIP)) continue;
            if (child.tagName === 'BR') segs.push({ node: null, text: '\n' });
            else if (child.tagName === 'IMG') segs.push({ node: null, text: ` [image ${child.getAttribute('src')}] ` });
            else if (child.tagName === 'UL' || child.tagName === 'OL' || child.tagName === 'TABLE') continue;
            else {
              if ((child.tagName === 'TD' || child.tagName === 'TH') && segs.some((x) => x.text.trim())) segs.push({ node: null, text: ' │ ' });
              walk(child);
            }
          }
        }
      };
      walk(el);
      const text = segs.map((s) => s.text).join('');
      const norm = text.replace(/\s+/g, ' ').trim();
      if (!norm && el.tagName !== 'HR') return;
      list.push({ el, segs, text, key: `${el.tagName}:${norm}` });
    });
    return list;
  }

  const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  function similarity(a, b) {
    const wa = words(a.text), wb = words(b.text);
    if (!wa.length && !wb.length) return a.el.tagName === b.el.tagName ? 1 : 0;
    const counts = new Map();
    wa.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
    let common = 0;
    wb.forEach((w) => { const c = counts.get(w); if (c) { common++; counts.set(w, c - 1); } });
    // Blend overlap with containment, so a short row that later had text added
    // (a table row filled in, a sentence appended) still counts as the same block.
    const dice = (2 * common) / (wa.length + wb.length);
    const containment = common / Math.max(1, Math.min(wa.length, wb.length));
    return (dice + containment) / 2;
  }

  function highlight(oldRoot, newRoot) {
    const oldU = units(oldRoot);
    const newU = units(newRoot);
    const parts = Diff.diffArrays(oldU.map((u) => u.key), newU.map((u) => u.key));
    const counts = { added: 0, modified: 0, removed: 0 };
    let oi = 0, ni = 0;
    let pendingOld = [], pendingNew = [];

    const flush = () => {
      // Pair each new block with the most similar removed block (keeping order).
      let floor = 0;
      const removedAnchors = new Map(); // old index -> new index to insert before
      const matched = new Set();
      for (const n of pendingNew) {
        let best = -1, bestScore = 0.4;
        for (let k = floor; k < pendingOld.length; k++) {
          const s = similarity(oldU[pendingOld[k]], newU[n]);
          if (s > bestScore) { best = k; bestScore = s; }
        }
        if (best >= 0) {
          for (let k = floor; k < best; k++) removedAnchors.set(pendingOld[k], n);
          matched.add(pendingOld[best]);
          markModified(oldU[pendingOld[best]], newU[n]);
          counts.modified++;
          floor = best + 1;
        } else {
          markNew(newU[n]);
          counts.added++;
        }
      }
      for (let k = floor; k < pendingOld.length; k++) removedAnchors.set(pendingOld[k], ni);
      for (const [o, anchorIdx] of removedAnchors) {
        if (matched.has(o)) continue;
        insertRemoved(oldU[o], newU[anchorIdx], newRoot);
        counts.removed++;
      }
      pendingOld = [];
      pendingNew = [];
    };

    for (const part of parts) {
      if (part.removed) { for (let k = 0; k < part.count; k++) pendingOld.push(oi++); }
      else if (part.added) { for (let k = 0; k < part.count; k++) pendingNew.push(ni++); }
      else { flush(); oi += part.count; ni += part.count; }
    }
    flush();
    return counts;
  }

  function markNew(u) {
    u.el.classList.add('chg-block', 'chg-new');
    for (const s of u.segs) {
      if (s.node && s.node.nodeValue.trim()) wrap(s.node, 'ins');
    }
  }

  function wrap(textNode, tag) {
    const w = document.createElement(tag);
    w.className = tag === 'ins' ? 'chg-ins' : 'chg-del';
    textNode.parentNode.insertBefore(w, textNode);
    w.appendChild(textNode);
    return w;
  }

  function markModified(oldUnit, newUnit) {
    newUnit.el.classList.add('chg-block', 'chg-mod');
    const parts = Diff.diffWordsWithSpace(oldUnit.text, newUnit.text);
    const insRanges = [];
    const dels = [];
    let pos = 0;
    for (const p of parts) {
      if (p.added) {
        if (p.value.trim()) insRanges.push([pos, pos + p.value.length]);
        pos += p.value.length;
      } else if (p.removed) {
        if (p.value.trim()) dels.push({ at: pos, text: p.value });
      } else pos += p.value.length;
    }
    if (!insRanges.length && !dels.length) {
      newUnit.el.classList.remove('chg-block', 'chg-mod'); // formatting-only change
      return;
    }

    // Character offsets of each segment within the unit's text.
    let off = 0;
    const segs = newUnit.segs.map((s) => { const r = { ...s, start: off, end: off + s.text.length }; off = r.end; return r; });

    // Insertions: wrap the covered part of each text node (work backwards so offsets stay valid).
    const pieces = [];
    for (const [a, b] of insRanges) {
      for (const s of segs) {
        if (!s.node || s.end <= a || s.start >= b) continue;
        pieces.push({ s, from: Math.max(a, s.start) - s.start, to: Math.min(b, s.end) - s.start });
      }
    }
    // Deletions: an inline <del> placed at the matching point of the new text.
    const delPoints = [];
    for (const d of dels) {
      const s = segs.find((x) => x.node && d.at >= x.start && d.at <= x.end) || segs.find((x) => x.node && x.start >= d.at);
      if (s) delPoints.push({ s, at: Math.max(0, Math.min(d.at - s.start, s.text.length)), text: d.text });
      else newUnit.el.append(delEl(d.text));
    }
    const ops = [
      ...pieces.map((p) => ({ s: p.s, at: p.from, kind: 'ins', p })),
      ...delPoints.map((d) => ({ s: d.s, at: d.at, kind: 'del', d })),
    ];
    // Group by node, then apply from the end of each node backwards.
    const byNode = new Map();
    ops.forEach((op) => { if (!byNode.has(op.s.node)) byNode.set(op.s.node, []); byNode.get(op.s.node).push(op); });
    for (const [node, list] of byNode) {
      // On ties, wrap the insertion first so a deletion lands just before it.
      list.sort((x, y) => y.at - x.at || (x.kind === 'ins' ? -1 : 1));
      for (const op of list) {
        if (op.kind === 'ins') {
          const { from, to } = op.p;
          node.splitText(to);
          wrap(node.splitText(from), 'ins');
        } else {
          const rest = node.splitText(op.at);
          rest.parentNode.insertBefore(delEl(op.d.text), rest);
        }
      }
    }
  }

  function delEl(text) {
    const d = document.createElement('del');
    d.className = 'chg-del';
    d.textContent = text;
    return d;
  }

  function insertRemoved(oldUnit, anchorUnit, container) {
    const text = oldUnit.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const anchor = anchorUnit?.el;
    let el;
    if (anchor?.tagName === 'LI') el = document.createElement('li');
    else if (anchor?.tagName === 'TR') {
      el = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = anchor.children.length || 1;
      el.appendChild(td);
    } else el = document.createElement('div');
    el.className = 'chg-removed-block';
    (el.firstChild || el).appendChild(delEl(text));
    if (anchor) anchor.parentNode.insertBefore(el, anchor);
    else container.appendChild(el);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
