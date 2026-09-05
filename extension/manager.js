/* IG Saved Grabber — manager page.
 * Reads captured items from chrome.storage.local and renders a searchable,
 * paginated gallery. Search filters by the collected descriptions (alt text).
 */
(() => {
  "use strict";

  const STORE_KEY = "igsg_items";
  const IGNORE_KEY = "igsg_ignore"; // user-added words to exclude from tags
  const DELETED_KEY = "igsg_deleted"; // isolated list of removed items
  const SETTINGS_KEY = "igsg_settings"; // { key, model } for transcription
  const TRANSCRIPTS_KEY = "igsg_transcripts"; // { [shortcode]: {text|error, ...} }
  const DETAILS_KEY = "igsg_details"; // { [shortcode]: {likes, views, ...} | {error} }
  const THUMBS_KEY = "igsg_thumbs"; // { [shortcode]: dataUrl } locally-cached thumbnails
  const DEFAULT_MODEL = "openai/whisper-large-v3-turbo";

  let settings = { key: "", model: DEFAULT_MODEL };
  let transcripts = {};        // shortcode -> { text, error, stage, language, cost, at }
  let details = {};            // shortcode -> { likes, views, comments, caption, ... } | { error }
  let thumbs = {};             // shortcode -> data URL (locally cached, never expires)
  let batchRunning = false;
  let batchStop = false;

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
    sort: document.getElementById("sort"),
    minLikes: document.getElementById("minLikes"),
    minViews: document.getElementById("minViews"),
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
    modalBack: document.getElementById("modalBack"),
    modal: document.getElementById("modal"),
    modalFrame: document.getElementById("modalFrame"),
    modalClose: document.getElementById("modalClose"),
    modalOpen: document.getElementById("modalOpen"),
    modalGrip: document.getElementById("modalGrip"),
    mvTopbar: document.getElementById("mvTopbar"),
    mvDesc: document.getElementById("mvDesc"),
    mvPrev: document.getElementById("mvPrev"),
    mvNext: document.getElementById("mvNext"),
    mvDel: document.getElementById("mvDel"),
    trToggle: document.getElementById("trToggle"),
    trPanel: document.getElementById("trPanel"),
    trKey: document.getElementById("trKey"),
    trModel: document.getElementById("trModel"),
    trSave: document.getElementById("trSave"),
    trBatch: document.getElementById("trBatch"),
    trStop: document.getElementById("trStop"),
    trStat: document.getElementById("trStat"),
    trBatchStat: document.getElementById("trBatchStat"),
    detailsBatch: document.getElementById("detailsBatch"),
  };

  // ── 9:16 iframe preview modal ─────────────────────────────────────────
  const MODAL_SIZE_KEY = "ig_modal_size";
  let modalIndex = -1;      // index into `filtered` of the item on screen
  let wheelLock = false;    // one reel per wheel gesture

  function embedUrl(url) {
    // https://www.instagram.com/p/CODE/  ->  .../p/CODE/embed/
    const base = String(url || "").split("?")[0].replace(/\/+$/, "");
    return base + "/embed/";
  }

  // Vertical space left for the modal below the (in-flow) description bar.
  function availStageH() {
    const tb = el.mvTopbar.offsetHeight || 0;
    return Math.max(300, window.innerHeight - tb - 24);
  }
  function defaultModalSize() {
    const h = Math.min(availStageH(), 900);
    return { w: Math.round((h * 9) / 16), h: Math.round(h) };
  }
  function applyModalSize(s) {
    const maxW = window.innerWidth - 24, maxH = availStageH();
    const w = Math.max(220, Math.min(s.w, maxW));
    const h = Math.max(300, Math.min(s.h, maxH));
    el.modal.style.width = w + "px";
    el.modal.style.height = h + "px";
  }
  function loadModalSize() {
    try {
      const raw = localStorage.getItem(MODAL_SIZE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.w && s.h) return s;
      }
    } catch {}
    return defaultModalSize();
  }
  function saveModalSize() {
    const s = { w: el.modal.offsetWidth, h: el.modal.offsetHeight };
    try { localStorage.setItem(MODAL_SIZE_KEY, JSON.stringify(s)); } catch {}
  }

  // Build the description bar: plain text, but hashtags and words that are
  // recognized tags (stem in keptStems) render as chips/badges.
  function chip(label) {
    const s = document.createElement("span");
    s.className = "mv-chip";
    s.textContent = label;
    return s;
  }
  function renderDesc(alt) {
    const box = el.mvDesc;
    box.innerHTML = "";
    const text = (alt || "").trim();
    if (!text) {
      const em = document.createElement("span");
      em.className = "mv-empty";
      em.textContent = "No description";
      box.appendChild(em);
      return;
    }
    const re = /(#[\p{L}\p{N}_]+)|([\p{L}\p{N}][\p{L}\p{N}'_-]*)/gu;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) {
        box.appendChild(chip(m[1])); // hashtag → always a chip
      } else {
        const word = m[2];
        const stem = singularize(word.toLowerCase());
        if (keptStems.has(stem)) box.appendChild(chip(word));
        else box.appendChild(document.createTextNode(word));
      }
      last = re.lastIndex;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
  }
  function updateNav() {
    const inList = modalIndex >= 0;
    el.mvPrev.disabled = !inList || modalIndex <= 0;
    el.mvNext.disabled = !inList || modalIndex >= filtered.length - 1;
    // delete only makes sense from the gallery (soft-move to deleted list)
    el.mvDel.style.display = view === "deleted" ? "none" : "";
  }
  function renderModalMeta(it) {
    renderDesc(it && it.alt);
    updateNav();
  }
  function showAtIndex(i) {
    if (i < 0 || i >= filtered.length) return;
    modalIndex = i;
    const it = filtered[i];
    el.modalFrame.src = embedUrl(it.url);
    el.modalOpen.href = it.url;
    renderModalMeta(it);
    // Re-fit under the (now-rendered) description bar unless the user is
    // mid-drag resizing; keeps the frame from ever slipping behind the bar.
    if (!el.modal.classList.contains("resizing")) applyModalSize(loadModalSize());
  }
  function openModal(it) {
    if (!it || !it.url) return;
    // reset to flex-centered layout (a prior drag may have pinned it absolute)
    el.modal.style.position = "";
    el.modal.style.left = "";
    el.modal.style.top = "";
    el.modalBack.classList.add("show"); // show first so topbar height is measurable
    const idx = filtered.indexOf(it);
    modalIndex = idx;
    if (idx >= 0) {
      showAtIndex(idx);
    } else { // item not in current list — still show it standalone
      el.modalFrame.src = embedUrl(it.url);
      el.modalOpen.href = it.url;
      renderModalMeta(it);
      applyModalSize(loadModalSize());
    }
  }
  function closeModal() {
    el.modalBack.classList.remove("show");
    el.modalFrame.src = "about:blank";
    modalIndex = -1;
  }
  function stepModal(dir) {
    if (modalIndex < 0) return;
    const next = modalIndex + dir;
    if (next < 0 || next >= filtered.length) return;
    showAtIndex(next);
  }

  el.modalClose.addEventListener("click", closeModal);
  el.modalBack.addEventListener("click", (e) => {
    if (e.target === el.modalBack) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (!el.modalBack.classList.contains("show")) return;
    if (e.key === "Escape") closeModal();
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); stepModal(1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); stepModal(-1); }
  });
  // Wheel down → next reel, wheel up → previous. One step per gesture.
  el.modalBack.addEventListener("wheel", (e) => {
    // Let the description bar scroll natively instead of navigating.
    if (e.target.closest("#mvTopbar")) return;
    e.preventDefault();
    if (wheelLock) return;
    if (Math.abs(e.deltaY) < 8) return;
    wheelLock = true;
    stepModal(e.deltaY > 0 ? 1 : -1);
    setTimeout(() => { wheelLock = false; }, 260);
  }, { passive: false });

  // Drag-to-resize via corner grip; size persists in localStorage.
  el.modalGrip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = el.modal.offsetWidth, startH = el.modal.offsetHeight;
    // Pin the modal's current top-left so it grows toward the cursor, not from center.
    const rect = el.modal.getBoundingClientRect();
    el.modal.style.position = "absolute";
    el.modal.style.left = rect.left + "px";
    el.modal.style.top = rect.top + "px";
    el.modal.classList.add("resizing");
    const onMove = (ev) => {
      applyModalSize({ w: startW + (ev.clientX - startX), h: startH + (ev.clientY - startY) });
    };
    const onUp = () => {
      el.modal.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveModalSize();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Floating side navigation.
  el.mvPrev.addEventListener("click", () => stepModal(-1));
  el.mvNext.addEventListener("click", () => stepModal(1));

  // Soft-delete the current item from within the modal: moves it to the
  // deleted list (un-saved on IG only when you later run "Clean deleted").
  async function deleteCurrentModal() {
    if (view === "deleted" || modalIndex < 0) return;
    const cur = filtered[modalIndex];
    if (!cur) return;
    const sc = cur.shortcode;
    const idx = modalIndex;
    await moveToDeleted(sc);
    // Reconcile with the (possibly already reloaded) list, then advance.
    const i = filtered.findIndex((x) => x.shortcode === sc);
    if (i >= 0) filtered.splice(i, 1);
    if (!filtered.length) { closeModal(); return; }
    showAtIndex(Math.min(idx, filtered.length - 1));
  }
  el.mvDel.addEventListener("click", deleteCurrentModal);

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
  let sortMode = "saved-desc"; // saved|views|likes|comments|posted + -asc|-desc
  let minLikes = 0;
  let minViews = 0;

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

  // ---- stat accessors (from fetched details) ----
  function statNum(it, key) {
    const d = details[it.shortcode];
    if (!d || d.error) return null;
    const v = d[key];
    return typeof v === "number" && v >= 0 ? v : null;
  }
  const getLikes = (it) => statNum(it, "likes");
  const getViews = (it) => statNum(it, "views");
  const getComments = (it) => statNum(it, "comments");
  function getPosted(it) {
    const d = details[it.shortcode];
    return d && !d.error && d.takenAt ? d.takenAt : null;
  }

  // Sort `filtered` in place per sortMode. Items missing the stat always sink
  // to the bottom, regardless of direction, so un-fetched posts don't pollute
  // the top of a "most views" view.
  function sortFiltered() {
    const dash = sortMode.lastIndexOf("-");
    const field = sortMode.slice(0, dash);
    const dir = sortMode.slice(dash + 1);
    const mul = dir === "asc" ? 1 : -1;
    if (field === "saved") {
      filtered.sort((a, b) => mul * (a.captured_at || "").localeCompare(b.captured_at || ""));
      return;
    }
    const get = field === "views" ? getViews : field === "likes" ? getLikes
      : field === "comments" ? getComments : field === "posted" ? getPosted : null;
    if (!get) return;
    filtered.sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;   // nulls last
      if (vb == null) return -1;
      return mul * (va - vb);
    });
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
        // Minimum engagement thresholds (require fetched details).
        if (minLikes > 0) { const l = getLikes(it); if (l == null || l < minLikes) return false; }
        if (minViews > 0) { const v = getViews(it); if (v == null || v < minViews) return false; }
      }
      if (q) {
        const hay = ((it.alt || "") + " " + (it.shortcode || "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (!deletedView) sortFiltered();
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
    thumb.dataset.sc = it.shortcode;
    thumb.href = it.url;
    thumb.target = "_blank";
    thumb.rel = "noopener";
    thumb.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return; // let delete/restore button work
      e.preventDefault();
      openModal(it);
    });

    const thumbSrc = thumbs[it.shortcode] || it.image;
    if (thumbSrc) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = thumbSrc;
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
    open.addEventListener("click", (e) => { e.preventDefault(); openModal(it); });
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = it.shortcode || "";
    if (view !== "deleted" && canTranscribe(it)) {
      const dl = document.createElement("button");
      dl.className = "tr-copy";
      dl.textContent = "⬇ Video";
      dl.title = "Download the video (best quality)";
      dl.onclick = (e) => { e.preventDefault(); downloadReel(it, dl); };
      foot.append(open, dl, code);
    } else {
      foot.append(open, code);
    }

    if (view === "deleted") {
      const st = document.createElement("div");
      st.className = "stat-line " + (it.cleared_on_ig ? "cleared" : "pending");
      st.textContent = it.cleared_on_ig ? "✓ cleared on Instagram" : "● pending on Instagram";
      body.append(desc, st, foot);
    } else {
      const statsBox = document.createElement("div");
      statsBox.className = "stats-area";
      statsBox.dataset.sc = it.shortcode;
      renderStatsArea(statsBox, it);
      const kids = [desc, statsBox];
      if (canTranscribe(it)) {
        const trBox = document.createElement("div");
        trBox.className = "tr-area";
        trBox.dataset.sc = it.shortcode;
        renderTrArea(trBox, it);
        kids.push(trBox);
      }
      kids.push(foot);
      body.append(...kids);
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

  // ---- transcription ----
  async function loadSettings() {
    const r = await chrome.storage.local.get([SETTINGS_KEY, TRANSCRIPTS_KEY, DETAILS_KEY, THUMBS_KEY]);
    settings = { key: "", model: DEFAULT_MODEL, ...(r[SETTINGS_KEY] || {}) };
    if (!settings.model) settings.model = DEFAULT_MODEL;
    transcripts = r[TRANSCRIPTS_KEY] || {};
    details = r[DETAILS_KEY] || {};
    thumbs = r[THUMBS_KEY] || {};
    el.trKey.value = settings.key || "";
    el.trModel.value = settings.model;
    updateTrStat();
  }

  function persistDetails() { return chrome.storage.local.set({ [DETAILS_KEY]: details }); }
  function persistThumbs() { return chrome.storage.local.set({ [THUMBS_KEY]: thumbs }); }

  function fmtNum(n) {
    if (n == null || n < 0) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(n);
  }
  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function escSel(sc) { return window.CSS && CSS.escape ? CSS.escape(sc) : sc; }

  function statChip(icon, val) {
    const s = document.createElement("span");
    s.className = "stat";
    const i = document.createElement("span");
    i.className = "ic";
    i.textContent = icon;
    const v = document.createElement("span");
    v.textContent = val;
    s.append(i, v);
    return s;
  }

  // Render engagement stats (or the fetch button / error) into a card box.
  function renderStatsArea(box, it) {
    const d = details[it.shortcode];
    box.replaceChildren();
    if (d && d.error) {
      const p = document.createElement("p");
      p.className = "tr-text err";
      p.textContent = "[" + (d.stage || "error") + "] " + d.error;
      const re = document.createElement("button");
      re.className = "tr-copy";
      re.textContent = "Retry";
      re.onclick = () => fetchDetailsFor(it, box);
      box.append(p, re);
    } else if (d) {
      const line = document.createElement("div");
      line.className = "stats-line";
      line.append(statChip("❤", fmtNum(d.likes)));
      if (d.views != null && d.views >= 0) line.append(statChip("▶", fmtNum(d.views)));
      line.append(statChip("💬", fmtNum(d.comments)));
      const bottom = document.createElement("div");
      bottom.className = "stats-bottom";
      const meta = document.createElement("span");
      meta.className = "stats-meta";
      const bits = [];
      if (d.username) bits.push("@" + d.username);
      const dt = fmtDate(d.takenAt);
      if (dt) bits.push(dt);
      meta.textContent = bits.join(" · ");
      const re = document.createElement("button");
      re.className = "tr-copy";
      re.textContent = "↻";
      re.title = "Refresh details";
      re.onclick = () => fetchDetailsFor(it, box);
      bottom.append(meta, re);
      box.append(line, bottom);
    } else {
      const b = document.createElement("button");
      b.className = "tr-btn";
      b.textContent = "📊 Likes / views";
      b.onclick = () => fetchDetailsFor(it, box);
      box.append(b);
    }
  }

  // Swap a card's (possibly expired) thumbnail for the freshly cached one.
  function refreshCardThumb(sc, dataUrl) {
    const t = document.querySelector('.thumb[data-sc="' + escSel(sc) + '"]');
    if (!t) return;
    const ph = t.querySelector(".ph");
    if (ph) ph.remove();
    let img = t.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      t.insertBefore(img, t.firstChild);
    }
    img.src = dataUrl;
  }

  // Fetch stats + a locally-cached thumbnail for one item.
  async function fetchDetailsFor(it, box) {
    const sc = it.shortcode;
    if (box) {
      box.replaceChildren();
      const busy = document.createElement("button");
      busy.className = "tr-btn busy";
      busy.textContent = "⏳ Fetching…";
      busy.disabled = true;
      box.append(busy);
    }
    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "igsg_fetchInfo", shortcode: sc, thumb: true }); }
    catch (e) { resp = { ok: false, error: String((e && e.message) || e) }; }
    if (resp && resp.ok) {
      details[sc] = { ...resp.stats, at: new Date().toISOString() };
      await persistDetails();
      if (resp.thumbDataUrl) {
        thumbs[sc] = resp.thumbDataUrl;
        await persistThumbs();
        refreshCardThumb(sc, resp.thumbDataUrl);
      }
    } else {
      details[sc] = {
        error: (resp && resp.error) || "Unknown error",
        stage: (resp && resp.stage) || "unknown", at: new Date().toISOString(),
      };
    }
    if (box) renderStatsArea(box, it);
    return resp || { ok: false };
  }

  // Batch: fetch details for every item on the current page missing them.
  async function runDetailsBatch() {
    if (batchRunning) return;
    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage).filter(
      (it) => !(details[it.shortcode] && !details[it.shortcode].error)
    );
    if (!slice.length) { flashDetailsBtn("Page already fetched"); return; }
    batchRunning = true; batchStop = false;
    const label = el.detailsBatch.textContent;
    let done = 0, failed = 0;
    for (const it of slice) {
      if (batchStop) break;
      const box = document.querySelector('.stats-area[data-sc="' + escSel(it.shortcode) + '"]');
      const resp = await fetchDetailsFor(it, box);
      if (resp && resp.ok) done++; else failed++;
      el.detailsBatch.textContent = "📊 " + done + "/" + slice.length + (failed ? " (" + failed + "✗)" : "");
      await new Promise((r) => setTimeout(r, 450)); // pace to stay under IG rate limits
    }
    batchRunning = false;
    el.detailsBatch.textContent = label;
    flashDetailsBtn((batchStop ? "Stopped" : "Done") + " — " + done + " fetched" + (failed ? ", " + failed + "✗" : ""));
    // Re-sort / re-filter now that new numbers exist, if the view depends on them.
    const statSort = /^(views|likes|comments|posted)-/.test(sortMode);
    if (statSort || minLikes > 0 || minViews > 0) applyFilters(false);
  }

  let detailsFlashTimer = null;
  function flashDetailsBtn(msg) {
    const label = "📊 Fetch details (page)";
    el.detailsBatch.textContent = msg;
    clearTimeout(detailsFlashTimer);
    detailsFlashTimer = setTimeout(() => { el.detailsBatch.textContent = label; }, 2200);
  }

  async function saveSettings() {
    settings.key = el.trKey.value.trim();
    settings.model = el.trModel.value.trim() || DEFAULT_MODEL;
    el.trModel.value = settings.model;
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    pulseStat(settings.key ? "Saved ✓" : "Saved — no key set yet.");
  }

  function persistTranscripts() {
    return chrome.storage.local.set({ [TRANSCRIPTS_KEY]: transcripts });
  }

  function updateTrStat() {
    const n = Object.values(transcripts).filter((t) => t && t.text).length;
    el.trStat.textContent = n ? n + " transcribed" : "";
  }

  let statTimer = null;
  function pulseStat(msg) {
    el.trStat.textContent = msg;
    clearTimeout(statTimer);
    statTimer = setTimeout(updateTrStat, 2200);
  }
  function setBatchStat(msg) { el.trBatchStat.textContent = msg; }

  function openTr(show) {
    const vis = show != null ? show : el.trPanel.style.display === "none";
    el.trPanel.style.display = vis ? "" : "none";
  }

  const canTranscribe = (it) => !!(it.is_reel || it.type === "tv");
  function trBoxFor(sc) {
    return document.querySelector('.tr-area[data-sc="' + (window.CSS && CSS.escape ? CSS.escape(sc) : sc) + '"]');
  }

  // Render the transcript control/result for one item into its card box.
  function renderTrArea(box, it) {
    const sc = it.shortcode;
    const rec = transcripts[sc];
    box.replaceChildren();
    if (rec && rec.text) {
      const p = document.createElement("p");
      p.className = "tr-text";
      p.textContent = rec.text;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:center;margin-top:4px;flex-wrap:wrap";
      const copy = document.createElement("button");
      copy.className = "tr-copy";
      copy.textContent = "Copy";
      copy.onclick = () => copyText(rec.text, copy);
      const re = document.createElement("button");
      re.className = "tr-copy";
      re.textContent = "Re-run";
      re.onclick = () => runTr(it, box);
      const meta = document.createElement("span");
      meta.className = "code";
      const bits = [];
      if (rec.language) bits.push(rec.language);
      if (rec.cost != null) bits.push("$" + Number(rec.cost).toFixed(4));
      meta.textContent = bits.join(" · ");
      row.append(copy, re, meta);
      box.append(p, row);
    } else if (rec && rec.error) {
      const p = document.createElement("p");
      p.className = "tr-text err";
      p.textContent = "[" + (rec.stage || "error") + "] " + rec.error;
      const re = document.createElement("button");
      re.className = "tr-copy";
      re.textContent = "Retry";
      re.onclick = () => runTr(it, box);
      box.append(p, re);
    } else {
      const b = document.createElement("button");
      b.className = "tr-btn";
      b.textContent = "🎙 Transcribe";
      b.onclick = () => runTr(it, box);
      box.append(b);
    }
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { return; }
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }

  // Download the reel's video (best quality) via the background service worker.
  async function downloadReel(it, btn) {
    const prev = btn.textContent;
    btn.textContent = "…"; btn.disabled = true; btn.title = "";
    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "igsg_download", shortcode: it.shortcode }); }
    catch (e) { resp = { ok: false, error: String((e && e.message) || e) }; }
    if (resp && resp.ok) {
      btn.textContent = "⬇ Saved";
    } else {
      btn.textContent = "⬇ failed";
      btn.title = (resp && resp.stage ? "[" + resp.stage + "] " : "") + (resp && resp.error || "");
    }
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; btn.title = ""; }, 1800);
  }

  // Transcribe one item; updates its card box in place and persists the result.
  async function runTr(it, box) {
    const sc = it.shortcode;
    if (!settings.key) {
      openTr(true);
      pulseStat("Set your OpenRouter API key, then Save — before transcribing.");
      el.trKey.focus();
      return { ok: false };
    }
    if (box) {
      box.replaceChildren();
      const busy = document.createElement("button");
      busy.className = "tr-btn busy";
      busy.textContent = "⏳ Transcribing…";
      busy.disabled = true;
      box.append(busy);
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "igsg_transcribe", shortcode: sc, model: settings.model, key: settings.key,
      });
    } catch (e) {
      resp = { ok: false, stage: "message", error: String((e && e.message) || e) };
    }
    if (resp && resp.ok) {
      transcripts[sc] = {
        text: resp.text || "", language: resp.language || null,
        cost: resp.cost, durationSec: resp.durationSec || null,
        model: resp.model || settings.model, at: new Date().toISOString(),
      };
    } else {
      transcripts[sc] = {
        error: (resp && resp.error) || "Unknown error",
        stage: (resp && resp.stage) || "unknown", at: new Date().toISOString(),
      };
    }
    await persistTranscripts();
    if (box) renderTrArea(box, it);
    updateTrStat();
    return resp || { ok: false };
  }

  // Batch over the reels on the current page that aren't transcribed yet.
  async function runBatch() {
    if (batchRunning) return;
    if (!settings.key) {
      openTr(true);
      pulseStat("Set your OpenRouter API key, then Save — before transcribing.");
      el.trKey.focus();
      return;
    }
    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage).filter(
      (it) => canTranscribe(it) && !(transcripts[it.shortcode] && transcripts[it.shortcode].text)
    );
    if (!slice.length) { setBatchStat("No un-transcribed reels on this page."); return; }
    batchRunning = true; batchStop = false;
    el.trStop.style.display = "";
    el.trBatch.disabled = true;
    let done = 0, failed = 0;
    for (const it of slice) {
      if (batchStop) break;
      const resp = await runTr(it, trBoxFor(it.shortcode));
      if (resp && resp.ok) done++; else failed++;
      setBatchStat("Transcribed " + done + "/" + slice.length +
        (failed ? " · " + failed + " failed" : ""));
    }
    batchRunning = false;
    el.trStop.style.display = "none";
    el.trBatch.disabled = false;
    setBatchStat((batchStop ? "Stopped — " : "Done — ") + done + " transcribed" +
      (failed ? ", " + failed + " failed" : "") + ".");
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
  el.sort.addEventListener("change", () => {
    sortMode = el.sort.value;
    applyFilters(true);
  });
  let minTimer = null;
  const onMinChange = () => {
    clearTimeout(minTimer);
    minTimer = setTimeout(() => {
      minLikes = Math.max(0, parseInt(el.minLikes.value, 10) || 0);
      minViews = Math.max(0, parseInt(el.minViews.value, 10) || 0);
      applyFilters(true);
    }, 200);
  };
  el.minLikes.addEventListener("input", onMinChange);
  el.minViews.addEventListener("input", onMinChange);
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
  el.trToggle.addEventListener("click", () => openTr());
  el.trSave.addEventListener("click", saveSettings);
  el.trModel.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });
  el.trKey.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });
  el.trBatch.addEventListener("click", runBatch);
  el.trStop.addEventListener("click", () => { batchStop = true; setBatchStat("Stopping after current…"); });
  el.detailsBatch.addEventListener("click", runDetailsBatch);

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

  // Load persisted ignore list + transcription state, then the collection.
  chrome.storage.local.get(IGNORE_KEY).then(async (r) => {
    ignore = new Set(r[IGNORE_KEY] || []);
    await loadSettings();
    load();
  });
})();
