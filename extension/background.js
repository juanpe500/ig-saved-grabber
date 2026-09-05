/* IG Saved Grabber — service worker.
 * Opens the manager page when the toolbar icon is clicked, or when the
 * content-script panel asks for it. Focuses an existing manager tab instead
 * of piling up duplicates.
 */
const MANAGER_URL = chrome.runtime.getURL("manager.html");

async function openManager() {
  const tabs = await chrome.tabs.query({ url: MANAGER_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
}

chrome.action.onClicked.addListener(openManager);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open_manager") openManager();
});

// ─────────────────────────────────────────────────────────────────────────
// Reel transcription pipeline
// shortcode → media id → IG media-info (signed CDN mp4) → OpenRouter Whisper
// All network runs here in the service worker: it sends first-party IG cookies
// and (for hosts in host_permissions) bypasses CORS, which a content script
// cannot. Errors are tagged by stage so the UI can show where it broke.
// ─────────────────────────────────────────────────────────────────────────
const IG_APP_ID = "936619743392459";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // OpenRouter caps at 25MB

// Instagram shortcodes are a base64 (URL-safe) encoding of the numeric media pk.
const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function shortcodeToMediaId(shortcode) {
  let n = 0n;
  for (const ch of String(shortcode)) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

function stageErr(stage, message) {
  const e = new Error(message);
  e.stage = stage;
  return e;
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Shared: fetch the full media object for a shortcode. Sends first-party IG
// cookies; the returned item carries video/image renditions AND engagement
// counts, caption, timestamp and owner — every feature reads from this one call.
async function fetchMediaItem(shortcode) {
  const id = shortcodeToMediaId(shortcode);
  if (!id) throw stageErr("resolve", "Unrecognized shortcode.");
  let res;
  try {
    res = await fetch(
      "https://www.instagram.com/api/v1/media/" + id + "/info/",
      { headers: { "X-IG-App-ID": IG_APP_ID }, credentials: "include" }
    );
  } catch (e) {
    throw stageErr("resolve", "Network error reaching Instagram: " + e.message);
  }
  if (res.status === 401 || res.status === 403) {
    throw stageErr("resolve", "Instagram rejected the request (" + res.status +
      ") — are you logged in to instagram.com in this browser?");
  }
  if (!res.ok) throw stageErr("resolve", "Instagram media-info HTTP " + res.status);
  let data;
  try { data = await res.json(); } catch { throw stageErr("resolve", "Instagram returned non-JSON (blocked?)."); }
  const item = data && data.items && data.items[0];
  if (!item) throw stageErr("resolve", "No media found (private, deleted, or not yours).");
  return item;
}

// Resolve a shortcode to a video rendition's signed CDN URL.
// Default picks the smallest (for transcription: smallest download, identical
// audio); { largest: true } picks the best quality (for downloading the video).
async function resolveVideoUrl(shortcode, opts) {
  const largest = !!(opts && opts.largest);
  const item = (opts && opts.item) || await fetchMediaItem(shortcode);
  const vv = item.video_versions;
  if (!vv || !vv.length) throw stageErr("resolve", "This post has no video (photo/carousel?).");
  const sorted = vv.slice().sort(
    (a, b) => (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0)
  );
  const pick = largest ? sorted[sorted.length - 1] : sorted[0];
  return {
    url: pick.url, durationSec: item.video_duration || null,
    width: pick.width || null, height: pick.height || null,
  };
}

// Best available thumbnail URL from the media item.
function pickThumbUrl(item) {
  const c = item.image_versions2 && item.image_versions2.candidates;
  if (!c || !c.length) return null;
  return c.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}
function firstNonNegative(...vals) {
  for (const v of vals) if (typeof v === "number" && v >= 0) return v;
  return null;
}

// Full enrich: engagement counts + caption/date/owner, plus the thumbnail
// downloaded as a data URL so it's stored locally and never expires.
async function fetchDetails({ shortcode, thumb }) {
  const item = await fetchMediaItem(shortcode);
  const stats = {
    likes: typeof item.like_count === "number" ? item.like_count : null,
    views: firstNonNegative(item.play_count, item.view_count, item.ig_play_count, item.fb_play_count),
    comments: typeof item.comment_count === "number" ? item.comment_count : null,
    caption: item.caption && item.caption.text ? item.caption.text : null,
    takenAt: item.taken_at || null,
    username: item.user && item.user.username ? item.user.username : null,
    durationSec: item.video_duration || null,
  };
  let thumbDataUrl = null;
  if (thumb !== false) {
    const turl = pickThumbUrl(item);
    if (turl) {
      try {
        const r = await fetch(turl);
        if (r.ok) {
          const buf = await r.arrayBuffer();
          const ct = r.headers.get("content-type") || "image/jpeg";
          thumbDataUrl = "data:" + ct + ";base64," + bufToBase64(buf);
        }
      } catch { /* leave thumb null; stats still returned */ }
    }
  }
  return { ok: true, stats, thumbDataUrl };
}

async function fetchAudioBase64(url) {
  let res;
  try { res = await fetch(url); }
  catch (e) { throw stageErr("fetch", "Could not download media: " + e.message); }
  if (!res.ok) throw stageErr("fetch", "Media download HTTP " + res.status);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_AUDIO_BYTES) {
    throw stageErr("fetch", "Clip too large (" +
      Math.round(buf.byteLength / 1e6) + "MB) — needs audio extraction/chunking.");
  }
  return { base64: bufToBase64(buf), bytes: buf.byteLength };
}

async function callTranscribe(base64, format, model, key) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input_audio: { data: base64, format },
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    }),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const msg =
      (json && json.error && (json.error.message || json.error)) ||
      raw.slice(0, 300) || ("HTTP " + res.status);
    return { ok: false, status: res.status, msg: String(msg) };
  }
  return { ok: true, json };
}

async function transcribeShortcode({ shortcode, model, key }) {
  if (!key) throw stageErr("config", "No OpenRouter API key set.");
  const { url, durationSec } = await resolveVideoUrl(shortcode);
  const { base64, bytes } = await fetchAudioBase64(url);
  // IG serves mp4 (video container, AAC audio). Try the honest label first;
  // fall back to m4a if a provider validates the format list strictly.
  let r = await callTranscribe(base64, "mp4", model, key);
  if (!r.ok && /format|unsupported|invalid.*audio/i.test(r.msg)) {
    r = await callTranscribe(base64, "m4a", model, key);
  }
  if (!r.ok) throw stageErr("transcribe", "OpenRouter " + r.status + ": " + r.msg);
  const j = r.json || {};
  return {
    ok: true,
    text: j.text || "",
    segments: Array.isArray(j.segments) ? j.segments : [],
    language: j.language || null,
    durationSec: (j.duration != null ? j.duration : durationSec),
    cost: j.usage && j.usage.cost != null ? j.usage.cost : null,
    bytes,
    model,
  };
}

// Download the best-quality video for a shortcode. Same resolver, largest
// rendition; the signed CDN URL is self-authenticating so chrome.downloads
// can pull it straight to disk with a sensible filename.
async function downloadShortcode({ shortcode }) {
  const { url } = await resolveVideoUrl(shortcode, { largest: true });
  const downloadId = await chrome.downloads.download({
    url, filename: "ig_reel_" + shortcode + ".mp4", saveAs: false,
  });
  return { ok: true, downloadId };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  let job = null;
  if (msg.type === "igsg_transcribe") job = transcribeShortcode(msg);
  else if (msg.type === "igsg_download") job = downloadShortcode(msg);
  else if (msg.type === "igsg_fetchInfo") job = fetchDetails(msg);
  else return;
  job
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, stage: e.stage || "unknown", error: e.message }));
  return true; // keep the message channel open for the async response
});
