// Real Chromium integration with synthetic data only. No YouTube/Jev network requests.
// Run after building the extension: node scripts/browser-smoke.mjs
// PLAYWRIGHT_MODULE can point to an already-installed playwright package.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadExtension } from './reload-extension.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'extension/package.json'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extensionPath = path.join(root, 'extension/dist');
const profile = await mkdtemp(path.join(tmpdir(), 'jev-browser-smoke-'));
const videoId = 'MgvwZaDPCs4';
const secondVideoId = 'AbCdEfGhI12';
const fixtureDescription = `Full creator description.\n\n${'Useful tutorial details. '.repeat(80)}\nhttps://example.com/original-link`;
// Tiny seekable H.264 fixture: black 16x16 frames with a real duration of 551s.
// Native media properties are shared with Chrome's isolated content-script world;
// overriding video.duration in the page world would not exercise the extension.
const media = await readFile(path.join(root, 'scripts/fixtures/native-video.mp4'));
const analysis = {
  id: 'offline-fixture-analysis', video_id: videoId,
  title: '[OFFLINE FIXTURE] Synthetic tutorial', subject: 'Synthetic tutorial',
  model: 'offline-test-fixture', prompt_version: 'offline-fixture',
  created_at: '2026-01-01T00:00:00Z', transcript_source: 'browser-transcript',
  visual_analysis: false,
  usage: { input_tokens: 100, output_tokens: 10, estimated_cost_usd: 0.0000042, requests: 4 },
  segments: [
    { id: 's0000', start: 0, end: 20, text: 'Useful tutorial introduction.', relevance: 0.96, promotion: 0.01, tangent: 0.01, context_needed: 0.8 },
    { id: 's0001', start: 248, end: 274, text: 'Synthetic promotion with no useful information.', relevance: 0.54, promotion: 0.96, tangent: 0.2, context_needed: 0.04 },
    { id: 's0002', start: 274, end: 290, text: 'Useful explanation inside a synthetic promotion.', relevance: 0.93, promotion: 0.97, tangent: 0.01, context_needed: 0.8 },
    { id: 's0003', start: 350, end: 365, text: 'Unrelated synthetic tangent.', relevance: 0.02, promotion: 0.01, tangent: 0.84, context_needed: 0.04 },
  ],
};
const html = `<!doctype html><html><head><title>[OFFLINE FIXTURE] Synthetic tutorial - YouTube</title>
<style>body{font-family:system-ui;background:#121212;color:#eee;margin:40px}#movie_player{position:relative;width:900px;height:420px;background:#242424}.ytp-progress-bar-container{position:absolute;bottom:0;width:100%;height:6px;background:#666}video{width:100%;height:100%}</style>
</head><body><h2>Offline browser integration fixture — no real video or Jev requests</h2>
<ytd-watch-metadata><h1><yt-formatted-string>[OFFLINE FIXTURE] Synthetic tutorial</yt-formatted-string></h1></ytd-watch-metadata>
<div id="description-inline-expander"><div id="expanded"><yt-attributed-string></yt-attributed-string></div><div id="snippet"><yt-attributed-string id="attributed-snippet-text">Full creator description...</yt-attributed-string><button>...more</button></div><button id="expand">...more</button><section hidden>Subtitles and auto-dubbing<br>Show transcript<br>Channel name<br>Video details</section><button hidden>Show less</button></div>
<div id="movie_player"><video src="/__fixture.mp4" preload="auto"></video><div class="ytp-progress-bar-container"></div></div>
<ytd-transcript-segment-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">Useful tutorial introduction.</span></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer><span class="segment-timestamp">4:08</span><span class="segment-text">Synthetic promotion with no useful information.</span></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer><span class="segment-timestamp">4:34</span><span class="segment-text">Useful explanation inside a synthetic promotion.</span></ytd-transcript-segment-renderer>
<script>window.ytInitialPlayerResponse=${JSON.stringify({ videoDetails: { videoId, shortDescription: fixtureDescription } })};document.querySelector('#movie_player').getPlayerResponse=()=>window.ytInitialPlayerResponse;window.fixtureSeeks=[];document.querySelector('video').addEventListener('seeking',()=>window.fixtureSeeks.push(document.querySelector('video').currentTime));</script>
</body></html>`;

let context;
try {
  // Reloading an unpacked extension requires Developer mode, even when the
  // initial load was permitted through Chromium's command-line flags.
  await mkdir(path.join(profile, 'Default'));
  await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1200, height: 800 },
  });
  context.setDefaultTimeout(10000);
  const failures = [];
  const requests = [];
  let releaseJob = false;
  let jobPolls = 0;
  const job = () => ({
    id: 'offline-fixture-job', video_id: videoId,
    status: releaseJob ? 'complete' : 'analyzing',
    progress: { completed: releaseJob ? 4 : 1, total: 4 },
    ...(releaseJob ? { analysis } : {}),
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'www.youtube.com') {
      if (url.pathname === '/__fixture.mp4') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4',
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) },
          body: media.subarray(start, end + 1) });
      } else await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    } else if (url.hostname === '127.0.0.1' && url.port === '8765') {
      let status = 200;
      let payload;
      if (url.pathname === '/health') {
        payload = { status: 'ok', api_key_configured: true, model: 'offline-test-fixture', version: 'test' };
      } else if (url.pathname === '/api/analyses' && request.method() === 'POST') {
        requests.push(request.postDataJSON());
        status = 202;
        payload = job();
      } else if (url.pathname === '/api/analyses/offline-fixture-job') {
        jobPolls++;
        payload = job();
      } else if (url.pathname === `/api/videos/${videoId}/analysis` && releaseJob) {
        payload = analysis;
      } else {
        status = 404;
        payload = { detail: 'No cached fixture.' };
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    } else if (url.protocol === 'chrome-extension:') {
      await route.continue();
    } else {
      failures.push(`Unexpected external request: ${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
    }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  // Upgrade an existing installation's original settings shape; none of the new
  // preservation thresholds existed when these settings were saved.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'jev:settings': { threshold: 0.9, promotions: true, tangents: true } });
  });
  await worker.evaluate(async ({ id, title }) => {
    await chrome.storage.local.set({ [`jev:${id}:subject`]: title });
  }, { id: videoId, title: analysis.title });
  const youtube = await context.newPage();
  await youtube.goto(`https://www.youtube.com/watch?v=${videoId}`);
  await youtube.waitForFunction(() => document.querySelector('video').duration === 551
    && document.querySelector('video').readyState >= 2);
  const initialTime = await youtube.evaluate(() => document.querySelector('video').currentTime);
  const youtubeTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  // Playwright exposes the panel document as a normal tab, whose clicks change
  // Chrome's active tab. Pin that one browser query to the genuine YouTube tab;
  // content messaging, local storage, API calls, and marker injection stay real.
  // This exercises a panel-document surrogate, not Chrome's native panel shell.
  await panel.addInitScript(id => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async options => options.active && options.currentWindow
      ? (await query({})).filter(tab => tab.id === id) : query(options);
  }, youtubeTabId);
  panel.on('pageerror', error => failures.push(error.message));
  youtube.on('pageerror', error => failures.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await youtube.bringToFront();

  // Panel interaction selectors below intentionally use the visible accessible UI.
  await panel.getByRole('button', { name: /^Analyze/ }).waitFor({ state: 'visible' });
  const autoSkip = panel.getByRole('switch', { name: 'Auto skip flagged sections', exact: true });
  assert.equal(await autoSkip.isChecked(), false, 'old installs default to mark only');
  const subject = panel.getByRole('textbox', { name: 'Video subject', exact: true });
  const description = fixtureDescription;
  const defaultSubject = `${analysis.title}\n\n${description}`;
  await panel.waitForFunction(expected => document.querySelector('#subject')?.value === expected, defaultSubject);
  await youtube.evaluate(() => { window.ytInitialPlayerResponse.videoDetails.shortDescription = 'Updated description.'; });
  await panel.waitForFunction(expected => document.querySelector('#subject')?.value === expected,
    `${analysis.title}\n\nUpdated description.`);
  await youtube.evaluate(() => { window.ytInitialPlayerResponse.videoDetails.shortDescription = 'x'.repeat(2000); });
  await panel.waitForFunction(expected => document.querySelector('#subject')?.value === expected,
    `${analysis.title}\n\n${'x'.repeat(2000)}`);
  await youtube.evaluate(text => { window.ytInitialPlayerResponse.videoDetails.shortDescription = text; }, description);
  await panel.waitForFunction(expected => document.querySelector('#subject')?.value === expected, defaultSubject);
  await subject.fill('Custom tutorial focus');
  const freshDescription = `Description after editing.\n\n${'Full text. '.repeat(150)}\nhttps://example.com/end`;
  await youtube.evaluate(text => { window.ytInitialPlayerResponse.videoDetails.shortDescription = text; }, freshDescription);
  // Wait for metadata polling to observe the new description before checking the edit.
  await panel.waitForTimeout(2200);
  assert.equal(await subject.inputValue(), 'Custom tutorial focus', 'metadata updates preserve manual subject edits');
  await panel.getByRole('button', { name: /^Analyze/ }).click();
  await panel.waitForFunction(() => document.body.textContent.includes('Analyzing'), null, { timeout: 5000 }).catch(async error => {
    console.error('Analysis start debug:', JSON.stringify(requests), await panel.locator('body').innerText());
    throw error;
  });
  assert.equal(requests.length, 1, 'one explicit analysis request');
  assert.equal(requests[0].video_id, videoId);
  assert.equal(requests[0].subject, 'Custom tutorial focus', 'edited subject reaches the helper');
  assert.equal(requests[0].description, freshDescription, 'full fresh description reaches the helper');
  assert.ok(requests[0].transcript?.length, 'visible YouTube transcript reaches helper');
  assert.ok(requests[0].transcript.every(cue => cue.duration > 0 && cue.duration <= 120), 'DOM cue timestamps satisfy helper contract');
  await panel.getByRole('status').getByText(/1 \/ 4 passages/).waitFor();
  const savedJob = await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], `jev:${videoId}:job`);
  assert.equal(savedJob?.id, 'offline-fixture-job', 'in-progress job is saved before reopening');

  // Reloading a panel must resume the saved job rather than issue another paid analysis.
  await panel.reload();
  await youtube.bringToFront();
  const previousPolls = jobPolls;
  await panel.waitForFunction(() => document.body.textContent.includes('Analyzing'), null, { polling: 100 });
  assert.equal(await subject.inputValue(), 'Custom tutorial focus', 'custom subject survives reopening the panel');
  releaseJob = true;
  await panel.getByText('Synthetic promotion with no useful information.', { exact: true }).waitFor();
  assert.ok(jobPolls > previousPolls, 'reopened panel polls persisted job');
  assert.equal(requests.length, 1, 'panel reopen does not submit another analysis');
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 1);
  assert.equal(await youtube.evaluate(() => document.querySelector('video').currentTime), initialTime, 'analysis never seeks automatically');
  assert.deepEqual(await youtube.evaluate(() => window.fixtureSeeks), [], 'mark-only mode makes zero playback mutations');

  const advanced = panel.getByRole('button', { name: 'Advanced', exact: true });
  const promotionUsefulness = panel.getByRole('slider', { name: 'Keep promotions if useful', exact: true });
  const otherUsefulness = panel.getByRole('slider', { name: 'Keep other passages if useful', exact: true });
  const necessaryContext = panel.getByRole('slider', { name: 'Keep necessary context', exact: true });
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false', 'advanced controls start collapsed');
  assert.equal(await panel.getByRole('slider').count(), 1, 'only main confidence is exposed initially');
  assert.equal(await panel.locator('#advanced-settings').isVisible(), false);
  for (const text of ['Keep the good parts.', 'LESS NOISE. SAME VIDEO.', '01 / CONFIGURE', '02 / REVIEW', 'ON YOUR SCREEN']) {
    assert.equal(await panel.getByText(text, { exact: true }).count(), 0, `decorative copy removed: ${text}`);
  }
  await advanced.click();
  assert.equal(await advanced.getAttribute('aria-expanded'), 'true');
  assert.equal(await promotionUsefulness.inputValue(), '80', 'old saved settings migrate to the new 80% promotion default');
  assert.equal(await otherUsefulness.inputValue(), '50');
  assert.equal(await necessaryContext.inputValue(), '50');

  await promotionUsefulness.fill('50');
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 0);
  await promotionUsefulness.fill('80');
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 1);
  await otherUsefulness.fill('60');
  await necessaryContext.fill('65');
  await panel.waitForFunction(async () => {
    const value = (await chrome.storage.local.get('jev:settings'))['jev:settings'];
    return value.promotionUsefulnessThreshold === 0.8 && value.usefulnessThreshold === 0.6 && value.contextThreshold === 0.65;
  });
  assert.equal(requests.length, 1, 'advanced adjustments reuse cached scores');
  assert.deepEqual(await youtube.evaluate(() => window.fixtureSeeks), [], 'advanced adjustments never seek');

  await panel.reload();
  await youtube.bringToFront();
  await panel.getByText('Synthetic promotion with no useful information.', { exact: true }).waitFor();
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false', 'advanced visibility resets when the panel reopens');
  await advanced.click();
  assert.equal(await promotionUsefulness.inputValue(), '80');
  assert.equal(await otherUsefulness.inputValue(), '60', 'other usefulness setting survives reload');
  assert.equal(await necessaryContext.inputValue(), '65', 'context setting survives reload');
  await otherUsefulness.fill('50');
  await necessaryContext.fill('50');
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'advanced controls fit a 400px panel');
  await panel.screenshot({ path: path.join(tmpdir(), 'jev-sidepanel-advanced-offline-smoke.png'), fullPage: true });
  await advanced.click();
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'compact panel fits a 400px panel');

  const slider = panel.getByRole('slider', { name: 'Confidence to mark', exact: true });
  await slider.fill('80');
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 2);
  assert.equal(requests.length, 1, 'threshold reuses cached scores');

  const promotion = panel.locator('article').filter({ hasText: 'Synthetic promotion with no useful information.' });
  await promotion.getByRole('button', { name: /Keep/ }).click();
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 1);
  assert.deepEqual(await youtube.evaluate(() => window.fixtureSeeks), [], 'keep override never seeks');

  await panel.screenshot({ path: path.join(tmpdir(), 'jev-sidepanel-offline-smoke.png'), fullPage: true });
  await youtube.screenshot({ path: path.join(tmpdir(), 'jev-timeline-offline-smoke.png'), fullPage: true });

  // Prove the event recorder also observes explicit seeks from the content script.
  await promotion.getByRole('button', { name: /4:08/ }).click();
  await youtube.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 248) < 0.1
    && window.fixtureSeeks.some(time => Math.abs(time - 248) < 0.1), null, { polling: 100, timeout: 5000 }).catch(async error => {
      console.error('Explicit seek debug:', await youtube.evaluate(() => {
        const video = document.querySelector('video');
        return { currentTime: video.currentTime, duration: video.duration, readyState: video.readyState,
          paused: video.paused, error: video.error?.message, events: window.fixtureSeeks,
          seekable: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]) };
      }), await panel.getByRole('alert').allTextContents());
      throw error;
    });
  async function position(time) {
    await youtube.evaluate(async time => {
      const video = document.querySelector('video');
      video.pause();
      video.muted = true;
      if (video.currentTime === time && !video.seeking) return;
      const settled = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = time;
      await settled;
    }, time);
  }
  async function play() { await youtube.evaluate(() => document.querySelector('video').play()); }
  async function assertStaysIn(start, end, message) {
    const before = await youtube.evaluate(() => window.fixtureSeeks.length);
    await play();
    // Observe real playback across multiple native timeupdate events.
    await youtube.waitForFunction(start => document.querySelector('video').currentTime > start + 0.7, start);
    assert.ok(await youtube.evaluate(end => document.querySelector('video').currentTime < end, end), message);
    assert.equal(await youtube.evaluate(() => window.fixtureSeeks.length), before, message);
    await youtube.evaluate(() => document.querySelector('video').pause());
  }

  await autoSkip.check();
  await panel.waitForFunction(async () => (await chrome.storage.local.get('jev:settings'))['jev:settings'].autoSkip === true);
  await panel.reload();
  await promotion.getByRole('button', { name: 'Undo keep', exact: true }).waitFor();
  assert.equal(await autoSkip.isChecked(), true, 'auto skip persists across panel reloads');
  await position(248);
  await assertStaysIn(248, 274, 'Keep prevents skipping with auto skip enabled after reload');

  // Undo Keep makes the same cached passage eligible again, including mid-playback.
  await play();
  await promotion.getByRole('button', { name: 'Undo keep', exact: true }).click();
  await youtube.waitForFunction(() => document.querySelector('video').currentTime >= 274);
  assert.ok(await youtube.evaluate(() => document.querySelector('video').currentTime < 290), 'lands in useful content');

  await position(247.8);
  await play();
  await youtube.waitForFunction(() => document.querySelector('video').currentTime >= 274);
  await position(350);
  await play();
  await youtube.waitForFunction(() => document.querySelector('video').currentTime >= 365);

  await position(250);
  const pausedSeeks = await youtube.evaluate(() => window.fixtureSeeks.length);
  await youtube.evaluate(() => document.querySelector('video').dispatchEvent(new Event('timeupdate')));
  assert.equal(await youtube.evaluate(() => document.querySelector('video').currentTime), 250, 'paused review does not auto skip');
  assert.equal(await youtube.evaluate(() => window.fixtureSeeks.length), pausedSeeks);

  await youtube.evaluate(() => document.querySelector('#movie_player').classList.add('ad-showing'));
  await assertStaysIn(250, 274, 'ads are never automatically skipped');
  await youtube.evaluate(() => document.querySelector('#movie_player').classList.remove('ad-showing'));

  await slider.fill('99');
  await youtube.waitForFunction(() => !document.querySelector('#jev-highlight-markers'));
  await position(350);
  await assertStaysIn(350, 365, 'threshold changes immediately update skip eligibility');
  await slider.fill('80');
  await youtube.waitForFunction(() => document.querySelectorAll('#jev-highlight-markers span').length === 2);

  await autoSkip.uncheck();
  await panel.waitForFunction(async () => (await chrome.storage.local.get('jev:settings'))['jev:settings'].autoSkip === false);
  await position(250);
  await assertStaysIn(250, 274, 'turning auto skip off restores uninterrupted playback');

  // Leave skipping enabled to verify stale marks cannot affect the next video.
  await autoSkip.check();
  await youtube.evaluate(() => document.dispatchEvent(new Event('yt-navigate-start')));
  await position(250);
  await assertStaysIn(250, 274, 'navigation start stops skipping immediately');
  const explicitSeeks = await youtube.evaluate(() => [...window.fixtureSeeks]);

  await youtube.evaluate(id => {
    history.pushState({}, '', `/watch?v=${id}`);
    document.dispatchEvent(new Event('yt-navigate-finish'));
  }, secondVideoId);
  await youtube.waitForFunction(() => !document.querySelector('#jev-highlight-markers'));
  assert.deepEqual(await youtube.evaluate(() => window.fixtureSeeks), explicitSeeks, 'SPA navigation never seeks');
  assert.deepEqual(failures, [], 'no page errors or external requests');
  await position(250);
  await assertStaysIn(250, 274, 'previous video marks never skip a new video');
  assert.equal(requests.length, 1, 'auto skip and Keep reuse cached analysis');
  const savedSettings = await panel.evaluate(async () => (await chrome.storage.local.get('jev:settings'))['jev:settings']);
  await reloadExtension(context, extensionPath, { refreshTabs: false });
  // Chromium closes extension documents during reload; open a fresh panel tab.
  const reloadedPanel = await context.newPage();
  await reloadedPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  assert.deepEqual(await reloadedPanel.evaluate(async () => (await chrome.storage.local.get('jev:settings'))['jev:settings']), savedSettings,
    'automated extension reload preserves settings');
  await youtube.goto(`https://www.youtube.com/watch?v=${videoId}`);
  await youtube.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await position(250);
  await play();
  await youtube.waitForFunction(() => document.querySelector('video').currentTime >= 274);
  assert.deepEqual(failures, [], 'automated reload reconnects content scripts without page errors');
  console.log('PASS: unpacked Chromium extension, subject metadata, captions, job resume, settings migration, advanced sliders, persistence, compact UI, auto skip of promotions and tangents, Keep/Undo keep, paused review, ads, toggle off, thresholds, and SPA cleanup (offline fixtures; panel-document surrogate).');
  console.log('Screenshots: /tmp/jev-sidepanel-advanced-offline-smoke.png, /tmp/jev-sidepanel-offline-smoke.png, and /tmp/jev-timeline-offline-smoke.png');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
