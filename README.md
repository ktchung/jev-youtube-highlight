# YouTube Highlights with Jev

A local companion for watching YouTube tutorials, product reviews, and tech or AI news with fewer interruptions. Jev evaluates timestamped passages so an extension can identify self-promotion, sponsorships, and unrelated tangents while preserving useful explanations.

The first prototype is **mark-only**: it highlights proposed removals on YouTube's existing timeline and lets you inspect them in a side panel. It does not automatically skip, trim, export, or re-encode the video.

> Status: the first implementation is a transcript-based, mark-only prototype. Visual analysis and automatic skipping are future work.

## Goal

Keep useful content in its original order. A shorter video is an outcome of removing interruptions, rather than a requirement to meet a target duration.

- Evaluate relevance against the video's overall subject, initially using its title, description, and transcript.
- Preserve relevant jokes, examples, demonstrations, and repeated explanations.
- Preserve useful information even when it appears inside a promotional passage.
- Retain uncertain passages and the context needed to understand nearby explanations.
- Support English videos, typically 15–30 minutes long, with creator-provided or auto-generated captions.

## First prototype

1. Open a YouTube watch page and the extension's side panel.
2. Check or edit the subject, prefilled with the video title and full creator-written description, then start an analysis.
3. The local helper retrieves a timestamped transcript and asks Jev focused questions about each passage, with neighboring context.
4. Inspect proposed removal markers, transcript excerpts, and separate relevance and promotion scores.
5. Adjust the marking threshold without repeating the Jev calls, or explicitly keep individual passages.

Playback remains under your control. Clicking a passage may seek to it, but the extension will not seek automatically.

The panel should distinguish live Jev results from any explicitly labeled demonstration data, show analysis progress, and report actual token usage with an estimated API cost.

## Architecture

```text
Chrome extension                  Local Python helper              TypeSafe AI
────────────────                  ───────────────────              ───────────
YouTube timeline markers    ↔     Caption retrieval          ↔      Jev decisions
React side panel                  Context-aware segmentation
Thresholds and overrides          SQLite cache and usage
                                  Local .env configuration
```

| Component | Stack | Responsibility |
| --- | --- | --- |
| Browser extension | Chrome Manifest V3, TypeScript, React, Vite | Side panel, settings, passage inspection, and timeline markers |
| Local helper | Python, FastAPI, HTTPX | Caption retrieval, bounded concurrent Jev requests, and job progress |
| Caption retrieval | youtube-transcript-api; yt-dlp where needed | Timestamped English captions and metadata |
| Persistence | SQLite and Chrome local storage | Cached analyses, usage, and local viewing preferences |
| Future visual analysis | FFmpeg and Jev image questions | Sampled frames and supporting visual evidence |

The helper will listen on `127.0.0.1:8765`. The first version uses local HTTP; native messaging can be considered when packaging the helper for installation.

Local refers to the interface, helper, and cache. Jev inference uses TypeSafe's hosted API, which receives the selected transcript passages and, if visual analysis is added, selected images.

## Configuration

The Jev key belongs in a root `.env` file read by the helper. It must never be bundled into the extension or committed to Git. The implementation will include a matching `.env.example`.

```dotenv
JEV_API_KEY=
JEV_MODEL=jev-1.14.0
HELPER_PORT=8765
JEV_MAX_CONCURRENCY=4
```

Concurrency is a starting setting to tune against the account's API limits. The helper should still start without a key so installation and connectivity can be checked; requesting a live analysis should explain that a key is required.

## Run locally

Requirements: Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), Node.js 22.12 or newer with npm, and Chrome or Chromium 116 or newer. A browser extension with a side panel is required; the prototype is not a standalone desktop app.

Install dependencies and build the extension:

```sh
make setup
make extension
```

Create a root `.env` from `.env.example` if one does not already exist, then set `JEV_API_KEY`. Start the helper in a terminal:

```sh
make helper
```

The helper binds only to `127.0.0.1`. Keep `HELPER_PORT=8765` for this prototype: the extension currently connects to that port. Restart the helper after editing `.env`.

1. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select this project's `extension/dist` directory.
3. Open a YouTube watch page. Refresh the page if it was open before the extension was loaded.
4. Open **Jev · YouTube Highlights** from Chrome's extension toolbar to show the side panel.
5. Check the detected subject and start an analysis. Markers and passage inspection do not require exporting a video.

Threshold changes apply directly to saved scores. **Analyze again** reruns Jev scoring using the saved transcript; it does not require downloading captions again. Captions already visible in YouTube can replace the saved transcript when supplied by the extension.

If YouTube blocks caption extraction, open its **Show transcript** panel and retry the analysis so the extension can supply the captions already present in the page. Creator-provided and auto-generated English captions are supported. Missing or blocked captions produce an error; there is no automatic substitution of demonstration scores for a failed live analysis.

The helper stores its SQLite cache in `data/cache.sqlite3` by default. The cache contains transcript passages and analysis results, and is ignored by Git. The extension stores settings, keep overrides, and results in local Chrome storage.

To enable the optional yt-dlp retrieval fallback:

```sh
uv sync --project helper --extra dev --extra fallback
```

Then set `HELPER_ENABLE_YTDLP_FALLBACK=true` in `.env` and restart the helper. This fallback can also be blocked by YouTube; it does not guarantee access to captions.

## Development and checks

```sh
make check
make browser-check
```

`make check` runs helper tests, extension tests, TypeScript checks, and the extension production build. `make browser-check` exercises the built extension in an isolated Chromium profile with synthetic YouTube and helper responses. The side-panel document is exercised as a browser tab with its active-video lookup pinned to the fixture; this check does not drive Chrome's native side-panel window. Those fixtures test browser integration and playback behavior; they do not measure Jev's editing accuracy. The browser check defaults to `/usr/bin/chromium`; set `CHROMIUM_PATH` to use another installed Chromium executable.

The optional visual preview is available through `npm --prefix extension run dev`, then `/sidepanel.html?preview=1` on the printed server address (normally `http://127.0.0.1:5173/sidepanel.html?preview=1`). It is explicitly labeled demonstration data and does not call Jev. Real extension usage defaults to the live helper.

No Docker, database server, video download, or FFmpeg installation is required for the initial transcript-only path.

Analysis cost describes the successful requests that produced the displayed scores, including prior requests reused from cache. It is not a new charge whenever the panel opens. Failed-request charges, if any, are not measurable from successful-response token usage; check the provider's billing for the final amount.

## Decision policy

Use separate Jev judgments for:

- Whether a passage supplies useful information about the subject.
- Whether it promotes a sponsor, product, service, channel, or the creator's own offering.
- Whether it is an unrelated tangent.
- Whether it provides necessary context for adjacent content.

Promotion and relevance can both be true. A promotion label alone must not cause useful information to be marked for removal.

The default marking threshold is 90%. A passage with an enabled promotion score at or above that threshold is preserved as useful only when its usefulness score reaches **80%**. Other passages use a **50%** usefulness cutoff. A context score of **50%** or higher also preserves a passage, and explicit keep choices always take priority.

The **Advanced** button exposes the promotional-usefulness, general-usefulness, and necessary-context preservation cutoffs as sliders. They are saved locally and apply immediately to cached scores without another Jev call. Existing saved settings automatically receive the new 80% promotional-usefulness default.

Raising the main marking threshold marks fewer passages. Raising a preservation cutoff requires stronger evidence to keep a passage and can mark more. These scores require evaluation on representative videos; a displayed threshold is not a measured guarantee of editing accuracy.

Caption timing should define candidate boundaries, with complete thoughts and surrounding context used to avoid fragmented edits. Chapters may provide navigation context, but must not be treated as ground-truth promotion labels.

## First evaluation video

[Grok Bot Just Got 2 Massive Upgrades. Do These Things Now.](https://www.youtube.com/watch?v=MgvwZaDPCs4)

- Duration: 9:11.
- Viewer-identified self-promotion: **4:08–4:34**. The viewer has listened to the later part and confirmed that it describes the promoted system rather than the Grok Bot content promised by the title.
- The video's chapter metadata labels 4:08–4:35 as **Free AI OS Kit**.

Keep this suspected interval outside the classifier input. It is a reference for inspecting the first result, not a hardcoded marker or a label for the model to reproduce. Evaluate surrounding sections too, including useful content that happens to mention the creator's tools.

## Later stages

- Automatically skip approved intervals during playback, with replay and keep controls.
- Check visual relevance independently of speech so silent demonstrations survive.
- Sample scene changes and periodic frames, increasing density around uncertain passages.
- Use Jev `noul` questions for visual presence and relevance, and optional `box` questions to locate supporting evidence.

A confident bounding box establishes a location, not usefulness. A useful spoken explanation may have no visible subject, and a promotional passage may keep displaying the reviewed product. Jev's image and Box features are experimental; Box also returns coordinates for absent targets, so it must be accompanied by a presence check.

Export is optional future work. Playback-based skipping can provide the intended viewing experience without generating another video file.

## References

- [TypeSafe API](https://docs.typesafe.ai/api)
- [Jev Noul questions](https://docs.typesafe.ai/primitives/noul)
- [Jev images](https://docs.typesafe.ai/images) and [Box questions](https://docs.typesafe.ai/primitives/box)
- [Jev model versions and pricing](https://docs.typesafe.ai/models)
- [Chrome side panels](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)

This project is independent of YouTube and TypeSafe AI.
