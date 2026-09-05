<div align="center">

<img src="docs/icon.png" width="88" alt="IG Saved Grabber logo" />

# IG Saved Grabber

**Take your Instagram *Saved* collection off Instagram.**
Scroll once, capture every post, then search, tag-analyze and bulk-manage the whole thing — locally, in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-0095f6.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-e0245e)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS-f2f2f3)
![No dependencies](https://img.shields.io/badge/Dependencies-0-2ecc71)
![100% local](https://img.shields.io/badge/Data-100%25%20local-833ab4)

</div>

<div align="center">
  <img src="docs/gallery.png" width="880" alt="The manager: a searchable, paginated gallery of saved posts with a live tag map" />
</div>

---

Instagram lets you *save* thousands of posts and then gives you exactly **zero** tools to do anything with them — no search, no export, no bulk actions, no idea what's even in there. This extension fixes that.

It captures each saved post's **URL, thumbnail, description and type (reel/post)** as you scroll, stores everything **locally** (nothing ever leaves your machine), and opens a full-page **manager** where you can search, build a **tag map** of what you actually save, and queue posts for cleanup.

## ✨ Features

- **🖱️ One-scroll capture** — a floating panel on your saved page auto-scrolls to the bottom, grabbing every post. De-duplicated by shortcode, so re-runs never create copies.
- **🗂️ Full-tab manager** — a searchable, paginated gallery of everything you saved, with thumbnails, descriptions and links back to each post.
- **🔎 Instant search** — filter by description text with live highlighting; hover any card to read the full caption in a floating popover.
- **🏷️ Tag map** — scans every description, strips stop-words (English **and** Spanish), merges singular/plural (`app`/`apps`), and shows you a ranked map of the words you save most. Hashtags included.
- **🔵🔴 Advanced tag filters** — click a tag to **include** it (blue), click again to **exclude** it (red), click again to clear. Combine as many as you want for `A AND B AND NOT C` queries. Remaining tags **re-count live** against the current results and hide themselves when they hit zero.
- **🗑️ Deleted list & safe cleanup** — removing a post doesn't destroy it; it moves to an isolated list. The **🧹 Clean deleted** automation then opens each one on Instagram and un-saves it for you (with verification), marking it cleared. Restore or purge anytime.
- **📊 Likes, views & comments** — enrich a card with its engagement numbers, the **full** caption, post date and creator — pulled from Instagram's own media endpoint in a single request per post. Do one card, or batch the visible page (paced to stay under rate limits).
- **🖼️ Permanent thumbnails** — enriching a post also downloads its thumbnail **bytes** and caches them locally, so the *"image expired"* placeholders come back to life and never expire again.
- **↕️ Sort & filter by engagement** — order by most/fewest **views**, **likes** or **comments**, or newest/oldest **posted**; hide everything below a **minimum likes / views** threshold.
- **🎙️ Reel transcription** — transcribe a reel's audio with **Whisper via OpenRouter** (your own key). The transcript lands inline on the card with its language and cost; do one, or batch the whole page. It fetches only the lowest-res copy for the audio and discards the bytes — fractions of a cent per reel.
- **⬇️ Download the video** — save any reel's original MP4 (best quality) straight to disk.
- **📤 Export anything** — the gallery, a filtered subset, the tag map, or the deleted list — as **JSON** or **CSV** (Excel-safe UTF-8).
- **🔒 Local-first, opt-in network** — no account, no server. Everything lives in `chrome.storage.local`. The only outbound calls are ones **you** trigger: to Instagram's own API (with your session) for details, thumbnails and video, and — only if you transcribe — to OpenRouter with your own key.

## 📸 Screenshots

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/tag-filters.png" alt="Advanced multi-tag filtering with include/exclude states and live co-occurrence counts" />
<p align="center"><b>Advanced tag filtering</b><br/>Include (blue) + exclude (red) + copy-select (gold). Counts update to the filtered results.</p>
</td>
<td width="50%" valign="top">
<img src="docs/deleted.png" alt="The isolated deleted list with per-item clean status" />
<p align="center"><b>Deleted list</b><br/>Isolated from the gallery, each item tracked as pending or cleared on Instagram.</p>
</td>
</tr>
</table>

## 🚀 Install

This is an unpacked extension — no store needed.

1. **Download** this repo (green **Code → Download ZIP**, or `git clone`).
2. Open **`chrome://extensions`** in Chrome (or any Chromium browser: Edge, Brave, Arc…).
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`extension/`** folder.
5. Pin the 🔖 icon to your toolbar.

## 📖 Usage

### 1 · Capture your saved posts
Go to your saved page — `instagram.com/<you>/saved/all-posts/` — and a dark panel appears top-right.

- **▶ Auto-scroll to bottom** scrolls and captures until it reaches the end.
- The badge shows how many unique posts are stored; it survives reloads.
- **🗂 Open manager** jumps to the manager tab (also on the toolbar icon).

### 2 · Explore in the manager
Search descriptions, page through the grid, filter by reels/posts, and hover a card to read its full caption. **Sort** by newest/oldest saved, most/fewest views, likes or comments, or newest/oldest posted — and set a **min ❤ / min ▶** threshold to hide low-engagement posts. (Engagement sorts and filters apply to posts you've enriched in step 5; un-enriched posts sort to the bottom.)

### 3 · Build & filter with tags
Hit **🏷 Generate tags** to scan every description. Then:

| Action | Result |
| --- | --- |
| **Click** a tag | Include it — results must contain it (turns blue) |
| **Click** again | Exclude it — results must *not* contain it (turns red) |
| **Click** again | Off |
| **Ctrl/⌘ + click** | Select the tag to copy (gold ring) — great for curating your stop-word list |
| **×** on a tag | Ignore that word and re-scan |

Stack multiple include/exclude tags for precise, progressive filtering.

### 4 · Curate & clean up
Remove posts you're done with (**×** on a card) — they move to the **Deleted** list instead of vanishing. Then, on your Instagram saved page, hit **🧹 Clean deleted** in the grabber panel: it opens each queued post, un-saves it (verifying the bookmark actually flipped), closes the dialog, and marks it *cleared on Instagram* — all at a deliberately gentle pace. Back in the manager's **Deleted** view you can restore the un-cleared ones or purge the cleared ones for good.

> The cleaner only ever touches posts **you** put in the deleted list, verifies each removal, and can be stopped at any time. Keep the tab focused while it runs.

### 5 · Enrich with likes, views & fresh thumbnails
Click **📊 Likes / views** on a card (or **📊 Fetch details (page)** in the header for the whole page) to pull each post's **likes, views, comments, full caption, post date and creator** from Instagram's media endpoint — and to **cache its thumbnail locally** so it stops expiring. Batch fetching is paced to stay gentle on Instagram; the button shows live progress. Then use the header **sort** and **min ❤ / min ▶** filters to rank and trim by engagement.

> Likes show `—` when the creator has hidden them; views only appear on videos/reels. Numbers are the current values at fetch time, not historical. Enrich first, *then* apply a minimum-engagement filter (a minimum hides un-enriched posts, which you can't fetch while they're hidden).

### 6 · Transcribe reels
Open **🎙 Transcripts** in the header, paste your **[OpenRouter](https://openrouter.ai/) API key** (kept in this browser only) and pick a model — it defaults to `openai/whisper-large-v3-turbo`. Then hit **🎙 Transcribe** on any reel card, or **Transcribe visible reels** to batch the page. The transcript appears inline with its detected language and the exact cost (typically a fraction of a cent). Under the hood it resolves the reel, grabs only the lowest-resolution copy for its audio, and sends that to OpenRouter's Whisper endpoint.

### 7 · Download a reel's video
Click **⬇ Video** on any reel card to save its original MP4 (highest quality available) to your Downloads folder as `ig_reel_<shortcode>.mp4`. Same resolver as transcription — just the best rendition instead of the smallest, and no third-party service involved.

## 🧾 What gets captured

Each item is a small JSON record:

```json
{
  "shortcode": "DcUNlNvy6J9",
  "url": "https://www.instagram.com/reel/DcUNlNvy6J9/",
  "type": "reel",
  "is_reel": true,
  "image": "https://scontent.cdninstagram.com/…/cover.jpg",
  "alt": "ManyChat just made Open Reply completely FREE …",
  "captured_at": "2026-08-23T06:53:00.000Z"
}
```

**Enriching** a post (step 5) adds a details record alongside it, and caches the thumbnail as a local data URL so it renders straight from disk:

```json
{
  "likes": 48213,
  "views": 1200000,
  "comments": 512,
  "caption": "The full, untruncated caption text…",
  "takenAt": 1755930000,
  "username": "callumgray16_",
  "durationSec": 14.3
}
```

Transcripts (step 6) are stored the same way, keyed by shortcode: `{ text, language, cost, model, at }`.

> **Note on thumbnails:** Instagram's original image URLs are signed and expire after a while, so older un-enriched thumbnails may 404 and show an *"image expired — open post ↗"* placeholder (the link always still works). **Enriching** a post fixes this permanently — it downloads the image bytes and stores them locally, so they never expire again.

## 🔒 Privacy

Everything runs on your device — no backend, no analytics, no telemetry — and all your data lives in `chrome.storage.local`. Capture, search, tagging and cleanup make **no network requests at all**; they only read the DOM of your own saved page.

The newer features make outbound calls **only when you trigger them**, and it's worth being clear about where the bytes go:

- **Details, thumbnails & video download** call **Instagram's own API** (`instagram.com` / `*.cdninstagram.com`) using your existing session — the same data your browser already sees. Nothing goes to any third party.
- **Transcription** is the one exception: when *you* click transcribe, the reel's audio is sent to **[OpenRouter](https://openrouter.ai/)** using **your own API key**, and billed to your account. Nothing is transcribed unless you ask for it, and the key never leaves this browser.

Permissions: `storage`, `downloads`, `unlimitedStorage` (to cache thumbnails locally), and host access to `instagram.com`, `*.cdninstagram.com`, `*.fbcdn.net` and `openrouter.ai`.

## 🗺️ Roadmap

- [x] Scroll-capture with de-dup + export (JSON/CSV)
- [x] Full-tab manager with search & pagination
- [x] Tag map with stop-words, plural-merging & hashtags
- [x] Multi-tag include/exclude filtering with live counts
- [x] Isolated deleted list with clean-status tracking
- [x] **Clean deleted** — auto-remove queued posts from Instagram (auto-scroll → find → un-save → verify → mark cleared)
- [x] **Details enrichment** — likes, views, comments, full caption, date & creator per post
- [x] **Locally-cached thumbnails** that never expire
- [x] **Sort & filter by engagement** (views / likes / comments / posted date, min thresholds)
- [x] **Reel transcription** with Whisper via OpenRouter
- [x] **One-click video download** (original MP4)

## 🛠️ Tech

Plain **Manifest V3** + vanilla JavaScript. No build step, no framework, no dependencies.

```
extension/
├── manifest.json     # MV3 manifest (storage, downloads, IG + OpenRouter hosts)
├── content.js        # the on-page capture panel + Clean-deleted automation
├── background.js     # opens the manager; resolves media, transcribes, downloads
├── manager.html      # manager + tag map + deleted + transcripts views
├── manager.js        # all manager logic (gallery, tags, stats, sort/filter)
└── icons/            # generated app icons
```

Transcription, engagement stats, thumbnail caching and video download all run through the background service worker: it decodes the shortcode to a media id, calls Instagram's `media/{id}/info/` with your session, and reuses that one response for every feature (smallest rendition for audio → OpenRouter Whisper, largest for download, `image_versions2` for the cached thumbnail).

## 🤝 Contributing

Issues and PRs welcome. It's a single small extension — clone it, load unpacked, hack away.

## 📄 License

[MIT](LICENSE) — do whatever you want.

---

<div align="center">
<sub>Not affiliated with, endorsed by, or connected to Instagram or Meta. For personal use with your own account.</sub>
</div>
