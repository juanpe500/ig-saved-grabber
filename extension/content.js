/* IG Saved Grabber — content script
 * Captures saved-post data (url, shortcode, thumbnail, description, is_reel)
 * as you scroll the Instagram saved page. Deduped in chrome.storage.local.
 */
(() => {
  "use strict";

  const STORE_KEY = "igsg_items"; // { [shortcode]: item }
  const DELETED_KEY = "igsg_deleted"; // shortcodes the user moved to the deleted list
  const PANEL_ID = "igsg-panel";

  // ---- storage helpers (chrome.storage.local, survives reloads) ----
  const store = {
    async all() {
      const r = await chrome.storage.local.get(STORE_KEY);
      return r[STORE_KEY] || {};
    },
    async save(map) {
      await chrome.storage.local.set({ [STORE_KEY]: map });
    },
    async clear() {
      await chrome.storage.local.remove(STORE_KEY);
    },
  };

  let items = {};        // in-memory mirror of the store
  let deletedSet = new Set(); // shortcodes already deleted — don't re-capture
  let deletedMap = {};   // shortcode -> deleted item (mirror of DELETED_KEY)
  let autoTimer = null;  // auto-scroll interval id
  let idleRounds = 0;    // consecutive scrolls with no height growth
  let lastHeight = 0;

  // ---- "clean deleted" automation state ----
  let cleanerActive = false;
  let cleanerStop = false;
  let cleanStats = { cleared: 0, failed: 0 };
  // Conservative pacing so Instagram doesn't rate-limit or misfire.
  const CLEAN_CFG = {
    openDelay: 850,     // after clicking a post, before looking for the modal
    modalTimeout: 6000, // how long to wait for the modal Remove button
    verifyTimeout: 3000,// how long to wait for the Save/Remove flip
    actionDelay: 650,   // after clicking Remove
    closeDelay: 650,    // after closing the modal
    betweenItems: 900,  // pause between posts
    scrollStep: 0.85,   // viewport fraction to scroll when seeking more
    scrollWait: 900,    // wait after a scroll for lazy content
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, step = 150) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await sleep(step);
    }
  }

  // ---- extraction ----
  // Match /p/<code>/, /reel/<code>/, /tv/<code>/
  const SHORTCODE_RE = /\/(p|reel|tv)\/([^/?#]+)/;

  function parseAnchor(a) {
    const href = a.getAttribute("href") || "";
    const m = href.match(SHORTCODE_RE);
    if (!m) return null;
    const kind = m[1];
    const shortcode = m[2];
    const img = a.querySelector("img");
    const isClip = !!a.querySelector('svg[aria-label="Clip"]');
    return {
      shortcode,
      url: "https://www.instagram.com/" + kind + "/" + shortcode + "/",
      type: kind, // p | reel | tv
      is_reel: kind === "reel" || isClip,
      image: img ? img.currentSrc || img.src || "" : "",
      alt: img && img.alt ? img.alt : "",
      captured_at: new Date().toISOString(),
    };
  }

  // Only capture inside the saved-posts grid to avoid grabbing suggested/nav
  // links. Falls back to whole document if the grid container isn't found.
  function scanRoots() {
    // The main content column of the saved page.
    const main = document.querySelector("main") || document.body;
    return main ? [main] : [document.body];
  }

  function capture() {
    let added = 0;
    let updated = 0;
    for (const root of scanRoots()) {
      const anchors = root.querySelectorAll(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
      );
      for (const a of anchors) {
        const item = parseAnchor(a);
        if (!item) continue;
        if (deletedSet.has(item.shortcode)) continue; // stays deleted
        const prev = items[item.shortcode];
        if (!prev) {
          items[item.shortcode] = item;
          added++;
        } else {
          // Backfill richer data if a later render exposed alt/image.
          let changed = false;
          if (!prev.alt && item.alt) { prev.alt = item.alt; changed = true; }
          if (!prev.image && item.image) { prev.image = item.image; changed = true; }
          if (!prev.is_reel && item.is_reel) { prev.is_reel = true; changed = true; }
          if (changed) updated++;
        }
      }
    }
    if (added || updated) {
      store.save(items);
      renderCount();
    }
    return added;
  }

  // ---- auto-scroll ----
  function startAuto() {
    if (autoTimer) return;
    idleRounds = 0;
    lastHeight = document.documentElement.scrollHeight;
    setBtnState(true);
    autoTimer = setInterval(() => {
      capture();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const h = document.documentElement.scrollHeight;
      if (h > lastHeight) {
        idleRounds = 0;
        lastHeight = h;
      } else {
        idleRounds++;
      }
      // 6 stable rounds (~7s) with no new content => assume bottom reached.
      if (idleRounds >= 6) {
        stopAuto();
        capture();
        setStatus("Reached the end — all loaded.");
      }
    }, 1200);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    setBtnState(false);
  }

  // ---- export ----
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
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes())
    );
  }

  function exportJSON() {
    const arr = Object.values(items);
    download(
      "ig_saved_" + stamp() + ".json",
      JSON.stringify(arr, null, 2),
      "application/json"
    );
  }

  function csvCell(v) {
    const s = (v == null ? "" : String(v)).replace(/"/g, '""');
    return '"' + s + '"';
  }

  function exportCSV() {
    const cols = ["shortcode", "url", "type", "is_reel", "alt", "image", "captured_at"];
    const lines = [cols.join(",")];
    for (const it of Object.values(items)) {
      lines.push(cols.map((c) => csvCell(it[c])).join(","));
    }
    // Prepend BOM so Excel reads UTF-8 (emojis in alt text) correctly.
    download("ig_saved_" + stamp() + ".csv", "﻿" + lines.join("\r\n"), "text/csv");
  }

  // ---- clean deleted from Instagram ----
  function codeFromHref(href) {
    const m = (href || "").match(SHORTCODE_RE);
    return m ? m[2] : null;
  }

  // First loaded grid anchor whose shortcode is still pending.
  function findPendingAnchor(pending) {
    const anchors = document.querySelectorAll(
      'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
    );
    for (const a of anchors) {
      const c = codeFromHref(a.getAttribute("href"));
      if (c && pending.has(c)) return { a, c };
    }
    return null;
  }

  function dialog() {
    return document.querySelector('div[role="dialog"]');
  }

  const onSavedGrid = () => /\/saved\//.test(location.pathname) && !dialog();

  async function closeModal() {
    for (let i = 0; i < 3; i++) {
      if (onSavedGrid()) return; // already back on the grid
      const closeSvg = document.querySelector('div[role="dialog"] svg[aria-label="Close"]');
      if (closeSvg) {
        const b = closeSvg.closest('[role="button"]') || closeSvg.parentElement;
        if (b) b.click();
      } else {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })
        );
      }
      await sleep(CLEAN_CFG.closeDelay);
    }
    // Last resort (e.g. a reel opened as its own full page): navigate back.
    if (!onSavedGrid()) {
      history.back();
      await waitFor(onSavedGrid, 3000);
    }
  }

  // Open one saved post, hit its Remove (un-save) control, verify, then close.
  // Returns true only when the bookmark visibly flipped to "Save".
  async function processItem(a, code) {
    setCleanStatus("Opening " + code + " …");
    a.scrollIntoView({ block: "center" });
    await sleep(250);
    a.click(); // Instagram routes to the post modal
    await sleep(CLEAN_CFG.openDelay);

    // The save/remove toggle: while saved, its icon is labelled "Remove".
    const removeSvg = await waitFor(
      () =>
        document.querySelector('div[role="dialog"] svg[aria-label="Remove"]') ||
        document.querySelector('svg[aria-label="Remove"]'),
      CLEAN_CFG.modalTimeout
    );
    if (!removeSvg) {
      setCleanStatus("No Remove button for " + code + " — skipped.");
      await closeModal();
      return false;
    }
    const scope = removeSvg.closest('div[role="dialog"]') || document;
    const btn = removeSvg.closest('[role="button"]');
    if (!btn) { await closeModal(); return false; }
    btn.click();

    // Confirm the un-save actually took: the icon flips to "Save".
    const ok = await waitFor(
      () => scope.querySelector('svg[aria-label="Save"]'),
      CLEAN_CFG.verifyTimeout
    );
    await sleep(CLEAN_CFG.actionDelay);
    await closeModal();
    return !!ok;
  }

  async function markCleared(code) {
    const r = await chrome.storage.local.get(DELETED_KEY);
    const dmap = r[DELETED_KEY] || {};
    if (dmap[code]) {
      dmap[code].cleared_on_ig = true;
      dmap[code].cleared_at = new Date().toISOString();
      await chrome.storage.local.set({ [DELETED_KEY]: dmap });
    }
    deletedMap = dmap;
  }

  async function runCleaner() {
    const r = await chrome.storage.local.get(DELETED_KEY);
    deletedMap = r[DELETED_KEY] || {};
    const pending = new Set(
      Object.values(deletedMap).filter((d) => !d.cleared_on_ig).map((d) => d.shortcode)
    );
    if (!pending.size) {
      setCleanStatus("Nothing pending to clean.");
      return;
    }
    if (
      !confirm(
        "Clean " + pending.size + " deleted post(s) from your Instagram saved?\n\n" +
        "This opens each one and un-saves it. Keep this tab focused and don't touch the page while it runs."
      )
    ) return;

    cleanerActive = true;
    cleanerStop = false;
    cleanStats = { cleared: 0, failed: 0 };
    setCleanBtn(true);
    const total = pending.size;
    let idle = 0;

    while (!cleanerStop && pending.size) {
      const hit = findPendingAnchor(pending);
      if (hit) {
        idle = 0;
        let ok = false;
        try { ok = await processItem(hit.a, hit.c); } catch (_) { ok = false; }
        if (ok) { await markCleared(hit.c); cleanStats.cleared++; }
        else cleanStats.failed++;
        pending.delete(hit.c);
        updateCleanCount();
        setCleanStatus(
          "Cleared " + cleanStats.cleared + "/" + total +
          (cleanStats.failed ? " · " + cleanStats.failed + " failed" : "") +
          " · " + pending.size + " left"
        );
        await sleep(CLEAN_CFG.betweenItems);
      } else {
        // None of the remaining pending posts are loaded — scroll for more.
        const before = document.documentElement.scrollHeight;
        window.scrollBy(0, Math.round(window.innerHeight * CLEAN_CFG.scrollStep));
        await sleep(CLEAN_CFG.scrollWait);
        const after = document.documentElement.scrollHeight;
        if (after <= before) { idle++; if (idle >= 5) break; } else idle = 0;
      }
    }

    cleanerActive = false;
    setCleanBtn(false);
    const leftover = pending.size;
    setCleanStatus(
      (cleanerStop ? "Stopped. " : "Done. ") +
      "Cleared " + cleanStats.cleared +
      (cleanStats.failed ? ", " + cleanStats.failed + " failed" : "") +
      (leftover ? ", " + leftover + " not found (still pending)." : ".")
    );
  }

  function stopCleaner() {
    cleanerStop = true;
    setCleanStatus("Stopping after current item…");
  }

  // ---- UI ----
  function setStatus(msg) {
    const el = document.getElementById("igsg-status");
    if (el) el.textContent = msg;
  }

  function renderCount() {
    const el = document.getElementById("igsg-count");
    if (el) el.textContent = String(Object.keys(items).length);
  }

  function setBtnState(running) {
    const b = document.getElementById("igsg-auto");
    if (!b) return;
    b.textContent = running ? "⏸ Stop auto-scroll" : "▶ Auto-scroll to bottom";
    b.classList.toggle("igsg-running", running);
  }

  function setCleanStatus(msg) {
    const el = document.getElementById("igsg-clean-status");
    if (el) el.textContent = msg;
  }

  function pendingCount() {
    return Object.values(deletedMap).filter((d) => !d.cleared_on_ig).length;
  }

  function updateCleanCount() {
    const el = document.getElementById("igsg-pending");
    if (el) el.textContent = String(pendingCount());
    const b = document.getElementById("igsg-clean");
    if (b && !cleanerActive) b.disabled = pendingCount() === 0;
  }

  function setCleanBtn(running) {
    const b = document.getElementById("igsg-clean");
    if (!b) return;
    b.classList.toggle("igsg-cleaning", running);
    b.disabled = false;
    b.textContent = running
      ? "⏹ Stop cleaning"
      : "🧹 Clean deleted (" + pendingCount() + ")";
    if (!running) updateCleanCount();
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID}{position:fixed;top:80px;right:16px;z-index:2147483647;
        width:230px;background:#1a1a1a;color:#fff;border:1px solid #333;
        border-radius:12px;padding:12px;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,.5);user-select:none}
      #${PANEL_ID} h4{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;
        justify-content:space-between;align-items:center}
      #${PANEL_ID} .igsg-badge{background:#0095f6;border-radius:10px;padding:1px 9px;
        font-size:12px;font-weight:700}
      #${PANEL_ID} button{width:100%;margin:4px 0;padding:8px;border:0;border-radius:8px;
        background:#2a2a2a;color:#fff;cursor:pointer;font-size:12px;font-weight:600}
      #${PANEL_ID} button:hover{background:#3a3a3a}
      #${PANEL_ID} #igsg-auto{background:#0095f6}
      #${PANEL_ID} #igsg-auto:hover{background:#1aa3ff}
      #${PANEL_ID} #igsg-auto.igsg-running{background:#e0245e}
      #${PANEL_ID} .igsg-row{display:flex;gap:4px}
      #${PANEL_ID} .igsg-row button{margin:4px 0}
      #${PANEL_ID} #igsg-status{margin-top:6px;font-size:11px;color:#aaa;min-height:14px}
      #${PANEL_ID} .igsg-clear{background:transparent;color:#e0245e;font-size:11px}
      #${PANEL_ID} .igsg-min{cursor:pointer;color:#aaa;background:none;width:auto;
        margin:0;padding:0 4px;font-size:16px;line-height:1}
      #${PANEL_ID} hr{border:0;border-top:1px solid #333;margin:9px 0 6px}
      #${PANEL_ID} .igsg-sec{font-size:10px;color:#888;letter-spacing:.03em;
        text-transform:uppercase;margin-bottom:2px}
      #${PANEL_ID} #igsg-clean{background:#2ea043}
      #${PANEL_ID} #igsg-clean:hover{background:#3fb950}
      #${PANEL_ID} #igsg-clean:disabled{background:#2a2a2a;color:#666;cursor:default}
      #${PANEL_ID} #igsg-clean.igsg-cleaning{background:#e0245e}
      #${PANEL_ID} #igsg-clean-status{margin-top:2px;font-size:11px;color:#aaa;min-height:14px}
    `;
    document.documentElement.appendChild(style);

    const p = document.createElement("div");
    p.id = PANEL_ID;
    p.innerHTML = `
      <h4>IG Saved Grabber
        <span><span class="igsg-badge" id="igsg-count">0</span>
        <button class="igsg-min" id="igsg-min" title="Hide">–</button></span>
      </h4>
      <div id="igsg-body">
        <button id="igsg-auto">▶ Auto-scroll to bottom</button>
        <button id="igsg-scan">↻ Capture visible now</button>
        <div class="igsg-row">
          <button id="igsg-json">Export JSON</button>
          <button id="igsg-csv">Export CSV</button>
        </div>
        <button id="igsg-manage">🗂 Open manager</button>
        <button class="igsg-clear" id="igsg-clear">Clear stored (✗)</button>
        <div id="igsg-status"></div>
        <hr>
        <div class="igsg-sec">🧹 Clean deleted from Instagram</div>
        <button id="igsg-clean" disabled>🧹 Clean deleted (0)</button>
        <div id="igsg-clean-status"></div>
      </div>
    `;
    document.documentElement.appendChild(p);

    p.querySelector("#igsg-auto").onclick = () =>
      autoTimer ? (stopAuto(), setStatus("Paused.")) : (setStatus("Scrolling & capturing…"), startAuto());
    p.querySelector("#igsg-scan").onclick = () => {
      const n = capture();
      setStatus(n ? "+" + n + " new captured." : "No new posts in view.");
    };
    p.querySelector("#igsg-json").onclick = () => {
      if (!Object.keys(items).length) return setStatus("Nothing to export yet.");
      exportJSON();
      setStatus("Exported JSON.");
    };
    p.querySelector("#igsg-csv").onclick = () => {
      if (!Object.keys(items).length) return setStatus("Nothing to export yet.");
      exportCSV();
      setStatus("Exported CSV.");
    };
    p.querySelector("#igsg-manage").onclick = () => {
      chrome.runtime.sendMessage({ type: "open_manager" });
    };
    p.querySelector("#igsg-clear").onclick = async () => {
      if (!confirm("Clear all stored saved-post data?")) return;
      items = {};
      await store.clear();
      renderCount();
      setStatus("Cleared.");
    };
    p.querySelector("#igsg-clean").onclick = () => {
      if (cleanerActive) stopCleaner();
      else runCleaner();
    };
    const body = p.querySelector("#igsg-body");
    p.querySelector("#igsg-min").onclick = () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      p.querySelector("#igsg-min").textContent = hidden ? "–" : "+";
    };

    renderCount();
    updateCleanCount();
  }

  function removePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    stopAuto();
  }

  // ---- SPA route handling: only show panel on /saved/ pages ----
  function isSavedPage() {
    return /\/saved\//.test(location.pathname) || /\/saved$/.test(location.pathname);
  }

  async function syncForRoute() {
    // While cleaning we deliberately navigate into /p/ post modals — keep the
    // panel alive and don't rebuild/teardown on those route changes.
    if (cleanerActive) return;
    if (isSavedPage()) {
      const r = await chrome.storage.local.get([STORE_KEY, DELETED_KEY]);
      items = r[STORE_KEY] || {};
      deletedMap = r[DELETED_KEY] || {};
      deletedSet = new Set(Object.keys(deletedMap));
      buildPanel();
      renderCount();
      updateCleanCount();
    } else {
      removePanel();
    }
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      syncForRoute();
    }
  }, 800);

  // Keep the deleted set/map fresh if the manager tab changes it while we're
  // on the saved page (don't clobber our own writes mid-clean).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DELETED_KEY]) {
      deletedMap = changes[DELETED_KEY].newValue || {};
      deletedSet = new Set(Object.keys(deletedMap));
      if (!cleanerActive) updateCleanCount();
    }
  });

  // init
  chrome.storage.local.get([STORE_KEY, DELETED_KEY]).then((r) => {
    items = r[STORE_KEY] || {};
    deletedMap = r[DELETED_KEY] || {};
    deletedSet = new Set(Object.keys(deletedMap));
    syncForRoute();
  });
})();
