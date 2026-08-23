/* IG Saved Grabber — manager page.
 * Reads captured items from chrome.storage.local and renders a searchable,
 * paginated gallery. Search filters by the collected descriptions (alt text).
 */
(() => {
  "use strict";

  const STORE_KEY = "igsg_items";
  const IGNORE_KEY = "igsg_ignore"; // user-added words to exclude from tags
  const DELETED_KEY = "igsg_deleted"; // isolated list of removed items

  // Common English + Spanish function words we never want as tags.
  const STOPWORDS = new Set((`
    a an the this that these those there here it its it's is are was were be been being
    am do does did done doing have has had having will would shall should can could may
    might must of to in on at for with from by as into onto off out up down over under
    and or but nor so yet if then else than because while when where who whom whose which
    what why how all any both each few more most other some such no not only own same too
    very just about above after again against below between during before through until
    you your yours yourself i me my mine we our ours us he him his she her hers they them
    their theirs one ones get got getting make makes made made way ways thing things
    like likes new now new use uses using used dont don't im i'm ive i've youre you're
    theyre they're were we're lets let's cant can't wont won't isnt isn't arent aren't
    also want wants need needs know knows go goes going come comes came see sees saw
    el la los las un una unos unas lo al del y o u ni pero sino porque como cuando donde
    que qué cual cuál quien quién cuyo para por con sin sobre entre desde hasta hacia
    segun según de a en es son era eran ser estar esta este esto estos estas ese esa eso
    esos esas aquel aquella su sus tu tus mi mis me te se nos os les le lo yo tu el ella
    ello nosotros vosotros ellos ellas usted ustedes muy mas más menos ya no si sí ver
    hacer hace hizo tener tiene puede pueden todo toda todos todas algo alguna algunas
    algun algún cada otro otra otros otras mismo misma tan tanto solo sólo tambien también
    tu te lo la le uno dos aqui aquí alli allí ahi ahí asi así entonces pues bien
    video follow comment link it's full real bio love send i'll reels time content
    every first best puedes you're cómo comenta even open think find fyp life start
    people right actually humor comedy
  `).trim().split(/\s+/));

  let ignore = new Set(); // persisted user ignore words

  const el = {
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    pager: document.getElementById("pager"),
    count: document.getElementById("count"),
    search: document.getElementById("search"),
    filter: document.getElementById("filter"),
    perpage: document.getElementById("perpage"),
    json: document.getElementById("json"),
    csv: document.getElementById("csv"),
    gentags: document.getElementById("gentags"),
    tagsPanel: document.getElementById("tagsPanel"),
    tagcloud: document.getElementById("tagcloud"),
    tagStat: document.getElementById("tagStat"),
    tagSearch: document.getElementById("tagSearch"),
    tagSortMode: document.getElementById("tagSortMode"),
    tagClear: document.getElementById("tagClear"),
    tagExport: document.getElementById("tagExport"),
    tagCopy: document.getElementById("tagCopy"),
    ignoreInfo: document.getElementById("ignoreInfo"),
    viewToggle: document.getElementById("viewToggle"),
    deletedBar: document.getElementById("deletedBar"),
    deletedStat: document.getElementById("deletedStat"),
    deletedStatus: document.getElementById("deletedStatus"),
    restorePending: document.getElementById("restorePending"),
    removeCleared: document.getElementById("removeCleared"),
    exportDeleted: document.getElementById("exportDeleted"),
  };

  let deletedAll = [];        // isolated deleted items (newest first)
  let view = "gallery";       // "gallery" | "deleted"
  let deletedStatus = "all";  // all | pending | cleared

  let tagCounts = [];         // master list: [ { word, count, stem }, ... ]
  let tagQuery = "";          // tag searchbar filter
  let tagSortMode = "count-desc"; // count-desc | count-asc | az | za
  let selected = new Set();   // Ctrl/⌘+clicked tags queued for copy
  let keptStems = new Set();  // stems that made it into the tag map (count ≥ 2)
  let tagFilters = new Map(); // stem -> 1 (include / blue) | -1 (exclude / red)
  const UNKNOWN_Q = "__untagged__"; // synthetic stem for the "unknown" tag

  let all = [];       // full list, newest first
  let filtered = [];  // after search + type filter
  let page = 1;
  let perPage = 24;
  let query = "";
  let typeFilter = "all";

  // ---- load ----
  async function load() {
    const r = await chrome.storage.local.get([STORE_KEY, DELETED_KEY]);
    const map = r[STORE_KEY] || {};
    all = Object.values(map).sort((a, b) =>
      (b.captured_at || "").localeCompare(a.captured_at || "")
    );
    const dmap = r[DELETED_KEY] || {};
    deletedAll = Object.values(dmap).sort((a, b) =>
      (b.deleted_at || "").localeCompare(a.deleted_at || "")
    );
    updateDeletedUI();
    applyFilters(true);
  }

  // ---- filtering ----
  function applyFilters(resetPage) {
    const q = query.trim().toLowerCase();
    const deletedView = view === "deleted";
    const source = deletedView ? deletedAll : all;
    const includes = [];
    const excludes = [];
    if (!deletedView) {
      for (const [stem, state] of tagFilters) {
        (state === 1 ? includes : excludes).push(stem);
      }
    }
    filtered = source.filter((it) => {
      if (typeFilter === "reel" && !it.is_reel) return false;
      if (typeFilter === "post" && it.is_reel) return false;
      if (typeFilter === "desc" && !(it.alt && it.alt.trim())) return false;
      if (deletedView) {
        if (deletedStatus === "cleared" && !it.cleared_on_ig) return false;
        if (deletedStatus === "pending" && it.cleared_on_ig) return false;
      } else {
        // Advanced tag filter: AND of all includes, none of the excludes.
        for (const s of includes) if (!postMatchesTag(it, s)) return false;
        for (const s of excludes) if (postMatchesTag(it, s)) return false;
      }
      if (q) {
        const hay = ((it.alt || "") + " " + (it.shortcode || "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (resetPage) page = 1;
    const maxPage = Math.max(1, Math.ceil(filtered.length / perPage));
    if (page > maxPage) page = maxPage;
    render();
  }

  // ---- rendering ----
  // Terms currently worth highlighting: the active "include" tag stems plus
  // whatever is typed in the gallery search box.
  function activeTerms() {
    const terms = [];
    for (const [stem, state] of tagFilters) {
      if (state === 1 && stem !== UNKNOWN_Q) terms.push(stem);
    }
    const q = query.trim();
    if (q) terms.push(q);
    return terms;
  }

  function highlight(text, terms) {
    if (typeof terms === "string") terms = terms ? [terms] : [];
    const frag = document.createDocumentFragment();
    if (!terms || !terms.length) { frag.append(text); return frag; }
    const lower = text.toLowerCase();
    const lowTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);
    let i = 0;
    while (i < text.length) {
      // Find the earliest match of any term starting at or after i.
      let best = -1, bestLen = 0;
      for (const t of lowTerms) {
        const idx = lower.indexOf(t, i);
        if (idx !== -1 && (best === -1 || idx < best)) { best = idx; bestLen = t.length; }
      }
      if (best === -1) { frag.append(text.slice(i)); break; }
      if (best > i) frag.append(text.slice(i, best));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(best, best + bestLen);
      frag.append(mark);
      i = best + bestLen;
    }
    return frag;
  }

  // Floating full-description popover (never reflows the grid).
  let descPop = null;
  function showDescPop(anchor, text) {
    if (!descPop) {
      descPop = document.createElement("div");
      descPop.className = "desc-pop";
      document.body.appendChild(descPop);
    }
    descPop.replaceChildren(highlight(text, activeTerms()));
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(r.width, 260);
    descPop.style.display = "block";
    descPop.style.width = width + "px";
    // Keep it on-screen horizontally.
    let left = r.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    if (left < margin) left = margin;
    descPop.style.left = left + "px";
    // Measure, then place aligned to the description; flip up if it overflows.
    descPop.style.top = "0px";
    const h = descPop.offsetHeight;
    let top = r.top - 6;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    if (top < margin) top = margin;
    descPop.style.top = top + "px";
  }
  function hideDescPop() {
    if (descPop) descPop.style.display = "none";
  }

  function card(it) {
    const c = document.createElement("div");
    c.className = "card";

    const thumb = document.createElement("a");
    thumb.className = "thumb";
    thumb.href = it.url;
    thumb.target = "_blank";
    thumb.rel = "noopener";

    if (it.image) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = it.image;
      img.alt = it.alt || "";
      img.onerror = () => {
        img.remove();
        const ph = document.createElement("div");
        ph.className = "ph";
        ph.textContent = "image expired — open post ↗";
        thumb.appendChild(ph);
      };
      thumb.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "ph";
      ph.textContent = "no thumbnail";
      thumb.appendChild(ph);
    }

    if (it.is_reel) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "▶ Reel";
      thumb.appendChild(b);
    }

    const del = document.createElement("button");
    if (view === "deleted") {
      del.className = "del restore";
      del.title = "Restore to collection";
      del.textContent = "↩";
      del.onclick = (e) => { e.preventDefault(); restoreDeleted(it.shortcode); };
    } else {
      del.className = "del";
      del.title = "Move to deleted list";
      del.textContent = "×";
      del.onclick = (e) => { e.preventDefault(); moveToDeleted(it.shortcode); };
    }
    thumb.appendChild(del);

    const body = document.createElement("div");
    body.className = "body";

    const desc = document.createElement("p");
    const hasAlt = !!(it.alt && it.alt.trim());
    desc.className = "desc" + (hasAlt ? "" : " empty");
    if (hasAlt) {
      desc.appendChild(highlight(it.alt, activeTerms()));
      desc.addEventListener("mouseenter", () => showDescPop(desc, it.alt));
      desc.addEventListener("mouseleave", hideDescPop);
    } else {
      desc.textContent = "No description";
    }

    const foot = document.createElement("div");
    foot.className = "foot";
    const open = document.createElement("a");
    open.className = "open";
    open.href = it.url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open ↗";
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = it.shortcode || "";
    foot.append(open, code);

    if (view === "deleted") {
      const st = document.createElement("div");
      st.className = "stat-line " + (it.cleared_on_ig ? "cleared" : "pending");
      st.textContent = it.cleared_on_ig ? "✓ cleared on Instagram" : "● pending on Instagram";
      body.append(desc, st, foot);
    } else {
      body.append(desc, foot);
    }
    c.append(thumb, body);
    return c;
  }

  function render() {
    el.count.textContent = String(all.length);
    const deletedView = view === "deleted";
    const sourceLen = deletedView ? deletedAll.length : all.length;

    if (!sourceLen) {
      el.grid.innerHTML = "";
      el.pager.innerHTML = "";
      el.empty.style.display = "";
      el.empty.querySelector("h2").textContent = deletedView
        ? "No deleted items"
        : "Nothing here yet";
      el.empty.querySelector("p").textContent = deletedView
        ? "Items you remove from the gallery land here."
        : "Open your Instagram saved page, run the grabber's auto-scroll, then come back.";
      return;
    }
    if (!filtered.length) {
      el.grid.innerHTML = "";
      el.pager.innerHTML = "";
      el.empty.style.display = "";
      el.empty.querySelector("h2").textContent = "No matches";
      el.empty.querySelector("p").textContent =
        "Nothing matches your search or filter.";
      return;
    }
    el.empty.style.display = "none";

    hideDescPop();
    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage);
    const frag = document.createDocumentFragment();
    slice.forEach((it) => frag.appendChild(card(it)));
    el.grid.replaceChildren(frag);

    renderPager();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderPager() {
    const maxPage = Math.ceil(filtered.length / perPage);
    el.pager.innerHTML = "";
    if (maxPage <= 1) {
      const info = document.createElement("span");
      info.className = "pageinfo";
      info.textContent = filtered.length + " item" + (filtered.length === 1 ? "" : "s");
      el.pager.appendChild(info);
      return;
    }
    const mk = (label, targetPage, disabled) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = label;
      if (disabled) b.disabled = true;
      else b.onclick = () => { page = targetPage; render(); };
      return b;
    };
    el.pager.appendChild(mk("« First", 1, page === 1));
    el.pager.appendChild(mk("‹ Prev", page - 1, page === 1));
    const info = document.createElement("span");
    info.className = "pageinfo";
    const from = (page - 1) * perPage + 1;
    const to = Math.min(page * perPage, filtered.length);
    info.textContent = `${from}–${to} of ${filtered.length}  ·  page ${page}/${maxPage}`;
    el.pager.appendChild(info);
    el.pager.appendChild(mk("Next ›", page + 1, page === maxPage));
    el.pager.appendChild(mk("Last »", maxPage, page === maxPage));
  }

  // ---- mutations ----
  // Move an item out of the active collection into the isolated deleted list.
  async function moveToDeleted(shortcode) {
    const r = await chrome.storage.local.get([STORE_KEY, DELETED_KEY]);
    const map = r[STORE_KEY] || {};
    const dmap = r[DELETED_KEY] || {};
    const it = map[shortcode];
    if (!it) return;
    delete map[shortcode];
    dmap[shortcode] = {
      ...it,
      deleted_at: new Date().toISOString(),
      cleared_on_ig: false,
      cleared_at: null,
    };
    await chrome.storage.local.set({ [STORE_KEY]: map, [DELETED_KEY]: dmap });
    // storage.onChanged handler refreshes the view.
  }

  // Move a deleted item back into the active collection.
  async function restoreDeleted(shortcode) {
    const r = await chrome.storage.local.get([STORE_KEY, DELETED_KEY]);
    const map = r[STORE_KEY] || {};
    const dmap = r[DELETED_KEY] || {};
    const it = dmap[shortcode];
    if (!it) return;
    delete dmap[shortcode];
    const { deleted_at, cleared_on_ig, cleared_at, ...clean } = it;
    map[shortcode] = clean;
    await chrome.storage.local.set({ [STORE_KEY]: map, [DELETED_KEY]: dmap });
  }

  // Restore every item not yet cleared on Instagram back to the collection.
  async function restorePending() {
    const pending = deletedAll.filter((d) => !d.cleared_on_ig);
    if (!pending.length) return;
    if (!confirm("Restore " + pending.length + " un-cleared item(s) to the collection?")) return;
    const r = await chrome.storage.local.get([STORE_KEY, DELETED_KEY]);
    const map = r[STORE_KEY] || {};
    const dmap = r[DELETED_KEY] || {};
    for (const d of pending) {
      delete dmap[d.shortcode];
      const { deleted_at, cleared_on_ig, cleared_at, ...clean } = d;
      map[clean.shortcode] = clean;
    }
    await chrome.storage.local.set({ [STORE_KEY]: map, [DELETED_KEY]: dmap });
  }

  // Permanently drop items already cleared on Instagram from the deleted list.
  async function removeCleared() {
    const cleared = deletedAll.filter((d) => d.cleared_on_ig);
    if (!cleared.length) return;
    if (!confirm("Permanently remove " + cleared.length + " item(s) already cleared on Instagram? This cannot be undone.")) return;
    const r = await chrome.storage.local.get(DELETED_KEY);
    const dmap = r[DELETED_KEY] || {};
    for (const d of cleared) delete dmap[d.shortcode];
    await chrome.storage.local.set({ [DELETED_KEY]: dmap });
  }

  function exportDeleted() {
    if (!deletedAll.length) return;
    download("ig_deleted_" + stamp() + ".json", JSON.stringify(deletedAll, null, 2), "application/json");
  }

  // ---- deleted view UI ----
  function updateDeletedUI() {
    const total = deletedAll.length;
    const cleared = deletedAll.filter((d) => d.cleared_on_ig).length;
    const pending = total - cleared;
    el.viewToggle.textContent =
      view === "deleted" ? "🖼 Gallery" : "🗑 Deleted (" + total + ")";
    el.restorePending.textContent = "Restore pending (" + pending + ")";
    el.restorePending.disabled = pending === 0;
    el.removeCleared.textContent = "Remove cleared (" + cleared + ")";
    el.removeCleared.disabled = cleared === 0;
    el.exportDeleted.disabled = total === 0;
    el.deletedStat.textContent =
      total + " deleted · " + cleared + " cleared on IG · " + pending + " pending";
  }

  function setView(v) {
    view = v;
    const deletedView = v === "deleted";
    el.deletedBar.style.display = deletedView ? "" : "none";
    el.gentags.style.display = deletedView ? "none" : "";
    if (deletedView) el.tagsPanel.style.display = "none";
    updateDeletedUI();
    applyFilters(true);
  }

  // ---- export (mirrors content.js) ----
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function csvCell(v) {
    return '"' + (v == null ? "" : String(v)).replace(/"/g, '""') + '"';
  }
  // Export respects the current search/filter selection.
  function exportJSON() {
    if (!filtered.length) return;
    download("ig_saved_" + stamp() + ".json", JSON.stringify(filtered, null, 2), "application/json");
  }
  function exportCSV() {
    if (!filtered.length) return;
    const cols = ["shortcode", "url", "type", "is_reel", "alt", "image", "captured_at"];
    const lines = [cols.join(",")];
    filtered.forEach((it) => lines.push(cols.map((c) => csvCell(it[c])).join(",")));
    download("ig_saved_" + stamp() + ".csv", "﻿" + lines.join("\r\n"), "text/csv");
  }

  // ---- tag map ----
  // Split a description into candidate word tokens (unicode-aware).
  function tokenize(text) {
    if (!text) return [];
    const raw = text
      .toLowerCase()
      .replace(/[’]/g, "'") // normalize curly apostrophes
      .replace(/https?:\/\/\S+/g, " ") // drop URLs
      .match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [];
    return raw
      .map((w) => w.replace(/^[_'-]+|[_'-]+$/g, "")) // trim edge punctuation
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  }

  // Reduce an English plural to a singular-ish root so "apps"→"app",
  // "websites"→"website", "companies"→"company". Conservative: leaves words
  // ending in ss/us/is alone and never produces roots shorter than 3 chars.
  function singularize(w) {
    if (w.length <= 3) return w;
    if (/(ss|us|is)$/.test(w)) return w; // business, status, analysis
    // Note: we deliberately do NOT map -ies → -y. That rule breaks the many
    // words whose singular already ends in -ie (zombie/zombies, movie/movies,
    // cookie/cookies), turning "zombies" into "zomby". Dropping just the
    // trailing "s" below handles those correctly; the cost is that a few
    // true y→ies plurals (company/companies) don't merge — a missed merge,
    // never a wrong one or hidden content.
    if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2); // boxes→box, watches→watch
    if (/s$/.test(w)) return w.slice(0, -1); // apps→app, prompts→prompt, zombies→zombie
    return w;
  }

  const blocked = (tok, stem) =>
    STOPWORDS.has(tok) || STOPWORDS.has(stem) || ignore.has(tok) || ignore.has(stem);

  function generateTags() {
    // Group tokens under their singular stem. Count each word at most once per
    // post (document frequency) so a word repeated inside one description does
    // not inflate its tally. Surface forms are tallied the same way so we can
    // label the group with the spelling used in the most posts.
    const groups = new Map(); // stem -> { total, forms: Map(surface -> postCount) }
    for (const it of all) {
      const stems = new Set();          // distinct stems in this post
      const surfaces = new Set();       // distinct "stem\0surface" in this post
      for (const w of tokenize(it.alt)) {
        const stem = singularize(w);
        if (blocked(w, stem)) continue;
        stems.add(stem);
        surfaces.add(stem + " " + w); // space is a safe separator (tokens have none)
      }
      for (const stem of stems) {
        let g = groups.get(stem);
        if (!g) { g = { total: 0, forms: new Map() }; groups.set(stem, g); }
        g.total++;
      }
      for (const key of surfaces) {
        const sep = key.indexOf(" ");
        const stem = key.slice(0, sep);
        const w = key.slice(sep + 1);
        const g = groups.get(stem);
        g.forms.set(w, (g.forms.get(w) || 0) + 1);
      }
    }
    tagCounts = [...groups.entries()]
      .map(([stem, g]) => {
        const disp = [...g.forms.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0])
        )[0][0];
        return { word: disp, count: g.total, stem };
      })
      .filter((t) => t.count > 1); // skip words seen only once

    // "unknown": posts that contributed to no kept tag (empty description,
    // only stopwords, or only singleton words).
    keptStems = new Set(tagCounts.map((t) => t.stem));
    let unknown = 0;
    for (const it of all) if (isUntagged(it)) unknown++;
    if (unknown > 0) {
      tagCounts.push({ word: "unknown", count: unknown, stem: UNKNOWN_Q, unknown: true });
    }

    el.tagsPanel.style.display = "";
    if (tagFilters.size) applyFilters(false); // keep `filtered` current for live counts
    renderTags();
  }

  // A post is "untagged" if none of its non-stopword stems reached the map.
  function isUntagged(it) {
    for (const w of tokenize(it.alt)) {
      const stem = singularize(w);
      if (blocked(w, stem)) continue;
      if (keptStems.has(stem)) return false;
    }
    return true;
  }

  // Whole-word membership: does this post contain the given stem as a real
  // token? Mirrors how tags are counted, so gallery results match the count.
  function postHasStem(it, stem) {
    for (const w of tokenize(it.alt)) {
      if (singularize(w) === stem) return true;
    }
    return false;
  }

  // Membership for any filter chip, including the synthetic "unknown" tag.
  function postMatchesTag(it, stem) {
    return stem === UNKNOWN_Q ? isUntagged(it) : postHasStem(it, stem);
  }

  // Co-occurrence counts over a subset of posts: for each kept stem, how many
  // of these posts contain it (document frequency). Used so chip counts reflect
  // the current filter selection. Also returns how many are untagged.
  function computeLive(posts) {
    const m = new Map();
    let unknown = 0;
    for (const it of posts) {
      const stems = new Set();
      for (const w of tokenize(it.alt)) {
        const s = singularize(w);
        if (blocked(w, s)) continue;
        stems.add(s);
      }
      let matched = false;
      for (const s of stems) {
        if (keptStems.has(s)) { m.set(s, (m.get(s) || 0) + 1); matched = true; }
      }
      if (!matched) unknown++;
    }
    return { m, unknown };
  }

  // Build the chip rows for the current state: tag-search text filter, the
  // chosen sort, and — when tag filters are active — live co-occurrence counts
  // over the filtered gallery, hiding tags no longer available (count 0).
  function tagView() {
    const q = tagQuery.trim().toLowerCase();
    const filtering = tagFilters.size > 0;
    let live = null, liveUnknown = 0;
    if (filtering) { const r = computeLive(filtered); live = r.m; liveUnknown = r.unknown; }

    const rows = [];
    for (const t of tagCounts) {
      const active = tagFilters.has(t.stem);
      let count = t.count;
      if (filtering) {
        count = t.unknown ? liveUnknown : (live.get(t.stem) || 0);
        if (count === 0 && !active) continue; // hide unavailable tags
      }
      if (q && !(t.word.includes(q) || t.stem.includes(q))) continue;
      rows.push({ word: t.word, stem: t.stem, unknown: t.unknown, count });
    }
    const cmp = {
      "count-desc": (a, b) => b.count - a.count || a.word.localeCompare(b.word),
      "count-asc": (a, b) => a.count - b.count || a.word.localeCompare(b.word),
      "az": (a, b) => a.word.localeCompare(b.word),
      "za": (a, b) => b.word.localeCompare(a.word),
    }[tagSortMode];
    return rows.sort(cmp);
  }

  function renderTags() {
    const view = tagView();
    el.tagStat.replaceChildren();
    el.tagStat.append(
      tagFilters.size
        ? view.length + " tags available · counts within the " + filtered.length + " results"
        : tagQuery.trim()
        ? view.length + " of " + tagCounts.length + " tags · count = posts containing it"
        : tagCounts.length + " tags (seen in ≥2 posts) · count = posts containing it"
    );
    if (tagFilters.size) {
      const inc = [...tagFilters.values()].filter((v) => v === 1).length;
      const exc = tagFilters.size - inc;
      el.tagStat.append(" · ");
      const clr = document.createElement("a");
      clr.href = "#";
      clr.style.color = "var(--accent)";
      clr.textContent = "clear filters (" + inc + "▲ / " + exc + "▼)";
      clr.onclick = (e) => {
        e.preventDefault();
        tagFilters.clear();
        applyFilters(true);
        renderTags();
      };
      el.tagStat.append(clr);
    }
    el.ignoreInfo.replaceChildren();
    if (ignore.size) {
      el.ignoreInfo.append(ignore.size + " word(s) ignored. ");
      const reset = document.createElement("a");
      reset.href = "#";
      reset.textContent = "reset ignored";
      reset.style.color = "var(--accent)";
      reset.onclick = async (e) => {
        e.preventDefault();
        ignore = new Set();
        await chrome.storage.local.remove(IGNORE_KEY);
        generateTags();
      };
      el.ignoreInfo.append(reset);
    }
    const max = view.length ? Math.max(...view.map((t) => t.count)) : 0;
    const frag = document.createDocumentFragment();
    for (const t of view) {
      const word = t.word;
      const state = tagFilters.get(t.stem) || 0; // 0 off · 1 include · -1 exclude
      const tag = document.createElement("span");
      let cls = "tag";
      if (tagSortMode === "count-desc" && t.count === max && max > 1) cls += " hot";
      if (state === 1) cls += " inc";
      else if (state === -1) cls += " exc";
      if (selected.has(word)) cls += " pick";
      if (t.unknown) cls += " unknown";
      tag.className = cls;

      const w = document.createElement("span");
      w.className = "word";
      w.textContent = t.unknown ? "⌀ " + word : word;
      w.title = t.unknown
        ? "Click to cycle: must be untagged → must NOT be → off"
        : "Click to cycle: include (blue) → exclude (red) → off · Ctrl/⌘+click: select for copy";
      w.onclick = (e) => {
        // Ctrl/⌘+click = select-for-copy (independent of filtering).
        if (!t.unknown && (e.ctrlKey || e.metaKey)) {
          if (selected.has(word)) selected.delete(word);
          else selected.add(word);
          tag.classList.toggle("pick", selected.has(word));
          updateCopyBtn();
          return;
        }
        // Plain click = tri-state filter cycle: off → include → exclude → off.
        const cur = tagFilters.get(t.stem) || 0;
        const next = cur === 0 ? 1 : cur === 1 ? -1 : 0;
        if (next === 0) tagFilters.delete(t.stem);
        else tagFilters.set(t.stem, next);
        applyFilters(true);
        renderTags();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };

      const c = document.createElement("span");
      c.className = "n";
      c.textContent = t.count;

      tag.append(w, c);
      // The synthetic "unknown" tag can't be ignored.
      if (!t.unknown) {
        const x = document.createElement("button");
        x.className = "x";
        x.title = "Ignore “" + word + "” and re-scan";
        x.textContent = "×";
        x.onclick = () => ignoreWord(t);
        tag.append(x);
      }
      frag.appendChild(tag);
    }
    el.tagcloud.replaceChildren(frag);
    updateCopyBtn();
  }

  function updateCopyBtn() {
    const n = selected.size;
    el.tagCopy.textContent = "Copy selected (" + n + ")";
    el.tagCopy.disabled = n === 0;
  }

  async function copySelected() {
    if (!selected.size) return;
    // Preserve current tag order (by count/alpha), not click order.
    const order = tagCounts.map((t) => t.word).filter((w) => selected.has(w));
    const text = order.join(" ");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const prev = el.tagCopy.textContent;
    el.tagCopy.textContent = "Copied " + selected.size + " ✓";
    setTimeout(() => updateCopyBtn(), 1200);
  }

  async function ignoreWord(t) {
    // Ignore by stem so every plural/singular variant disappears together.
    ignore.add(t.stem);
    ignore.add(t.word);
    selected.delete(t.word);
    tagFilters.delete(t.stem);
    await chrome.storage.local.set({ [IGNORE_KEY]: [...ignore] });
    generateTags(); // re-scan without it
  }

  function clearTags() {
    tagCounts = [];
    selected.clear();
    tagFilters.clear();
    updateCopyBtn();
    el.tagcloud.replaceChildren();
    el.tagsPanel.style.display = "none";
    applyFilters(true); // drop any tag-based gallery filtering
  }

  function exportTagsCSV() {
    if (!tagCounts.length) return;
    const lines = ["tag,count"];
    for (const t of tagCounts) lines.push(csvCell(t.word) + "," + t.count);
    download("ig_tags_" + stamp() + ".csv", "﻿" + lines.join("\r\n"), "text/csv");
  }

  // ---- events ----
  let searchTimer = null;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = el.search.value;
      applyFilters(true); // re-renders cards with updated highlight terms
    }, 180);
  });
  el.filter.addEventListener("change", () => {
    typeFilter = el.filter.value;
    applyFilters(true);
  });
  el.perpage.addEventListener("change", () => {
    perPage = parseInt(el.perpage.value, 10) || 24;
    applyFilters(true);
  });
  window.addEventListener("scroll", hideDescPop, true);
  el.json.addEventListener("click", exportJSON);
  el.csv.addEventListener("click", exportCSV);
  el.gentags.addEventListener("click", generateTags);
  el.tagClear.addEventListener("click", clearTags);
  el.tagExport.addEventListener("click", exportTagsCSV);
  el.tagCopy.addEventListener("click", copySelected);
  let tagSearchTimer = null;
  el.tagSearch.addEventListener("input", () => {
    clearTimeout(tagSearchTimer);
    tagSearchTimer = setTimeout(() => {
      tagQuery = el.tagSearch.value;
      renderTags();
    }, 150);
  });
  el.tagSortMode.addEventListener("change", () => {
    tagSortMode = el.tagSortMode.value;
    renderTags();
  });
  el.viewToggle.addEventListener("click", () => setView(view === "deleted" ? "gallery" : "deleted"));
  el.deletedStatus.addEventListener("change", () => {
    deletedStatus = el.deletedStatus.value;
    applyFilters(true);
  });
  el.restorePending.addEventListener("click", restorePending);
  el.removeCleared.addEventListener("click", removeCleared);
  el.exportDeleted.addEventListener("click", exportDeleted);

  // Live-refresh if the grabber captures more, or the deleted list changes,
  // while this tab is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORE_KEY] || changes[DELETED_KEY]) {
      load().then(() => {
        if (view === "gallery" && el.tagsPanel.style.display !== "none" && tagCounts.length) {
          generateTags();
        }
      });
    }
  });

  // Load persisted ignore list, then the collection.
  chrome.storage.local.get(IGNORE_KEY).then((r) => {
    ignore = new Set(r[IGNORE_KEY] || []);
    load();
  });
})();
