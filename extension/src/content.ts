import { readMetadata, videoIdFromUrl } from './content-core';
import { markedRanges, skipTarget, type MarkedRange } from './policy';
import { getStored } from './storage';
import { normalizeSettings, SETTINGS_KEY, videoKey, type Analysis } from './types';

const ROOT_ID = 'jev-highlight-markers';
const STYLE_ID = 'jev-highlight-marker-style';
let generation = 0;
let lastVideoId: string | null = null;
let refreshQueued = false;
let disposed = false;
let navigating = false;
let playback: { videoId: string; ranges: MarkedRange[]; protectedRanges: { start: number; end: number }[] } | null = null;

function autoSkip(event?: Event) {
  if (!playback || disposed || navigating || !chrome.runtime.id
    || playback.videoId !== videoIdFromUrl(location.href)) return;
  const renderedVideoId = document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  if (renderedVideoId && renderedVideoId !== playback.videoId) return;
  const player = document.querySelector('#movie_player');
  const video = player?.querySelector('video');
  if (!video || (event && event.target !== video) || video.paused || video.seeking || video.ended
    || video.readyState < 2 || player?.classList.contains('ad-showing')
    || player?.classList.contains('ad-interrupting')) return;
  const target = skipTarget(playback.ranges, video.currentTime, video.duration, playback.protectedRanges);
  if (target !== null) video.currentTime = target;
}

function removeMarkers() { document.getElementById(ROOT_ID)?.remove(); }

async function refresh() {
  const current = ++generation;
  const videoId = videoIdFromUrl(location.href);
  if (lastVideoId !== videoId) { playback = null; removeMarkers(); lastVideoId = videoId; }
  if (!videoId || disposed || navigating) { playback = null; removeMarkers(); return; }
  const [analysis, storedSettings, kept] = await Promise.all([
    getStored<Analysis | null>(videoKey(videoId, 'analysis'), null),
    getStored<unknown>(SETTINGS_KEY, null),
    getStored<string[]>(videoKey(videoId, 'kept'), []),
  ]);
  const settings = normalizeSettings(storedSettings);
  if (current !== generation || disposed || navigating || videoId !== videoIdFromUrl(location.href)) return;
  const renderedVideoId = document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  if (renderedVideoId && renderedVideoId !== videoId) { playback = null; removeMarkers(); return; }
  const player = document.querySelector('#movie_player');
  const video = player?.querySelector('video');
  const progress = player?.querySelector('.ytp-progress-bar-container');
  if (!analysis || analysis.video_id !== videoId) { playback = null; removeMarkers(); return; }
  const ranges = markedRanges(analysis.segments, settings, kept);
  playback = settings.autoSkip ? {
    videoId, ranges, protectedRanges: analysis.segments.filter(segment => kept.includes(segment.id)),
  } : null;
  autoSkip();
  if (!video || !progress || !Number.isFinite(video.duration) || video.duration <= 0
    || player?.classList.contains('ad-showing')) { removeMarkers(); return; }
  const signature = `${videoId}:${video.duration}:${JSON.stringify(ranges)}`;
  const existing = document.getElementById(ROOT_ID);
  if (existing?.dataset.signature === signature && existing.parentElement === progress) return;
  removeMarkers();
  if (!ranges.length) return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `#${ROOT_ID}{position:absolute;left:0;right:0;top:0;height:5px;pointer-events:none!important;z-index:39}#${ROOT_ID} span{position:absolute;height:100%;min-width:1px;pointer-events:none!important;border-radius:1px;opacity:.92}#${ROOT_ID} .promotion{background:#edba78}#${ROOT_ID} .tangent{background:#b7c5ff}`;
    document.head.append(style);
  }
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.signature = signature;
  root.setAttribute('aria-hidden', 'true');
  for (const range of ranges) {
    const start = Math.min(100, range.start / video.duration * 100);
    const end = Math.min(100, range.end / video.duration * 100);
    if (end <= start) continue;
    const marker = document.createElement('span');
    marker.className = range.category;
    marker.style.left = `${start}%`;
    marker.style.width = `${end - start}%`;
    root.append(marker);
  }
  progress.append(root);
}

function queueRefresh() {
  if (refreshQueued || disposed) return;
  refreshQueued = true;
  window.setTimeout(() => {
    refreshQueued = false;
    void refresh().catch(() => { /* Extension reload invalidates existing content scripts. */ });
  }, 180);
}

const observer = new MutationObserver(records => {
  // Ignore our own changes, including the removal of a stale marker layer.
  if (records.every(record => (record.target as Element).closest?.(`#${ROOT_ID}`)
    || [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && [ROOT_ID, STYLE_ID].includes(node.id)))) return;
  queueRefresh();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
function navigationStart() { navigating = true; generation++; playback = null; removeMarkers(); }
function navigationFinish() { navigating = false; queueRefresh(); }
function storageChanged() {
  // Stop using old settings/Keep choices before the debounced storage read.
  playback = null;
  generation++;
  queueRefresh();
}
document.addEventListener('yt-navigate-start', navigationStart);
document.addEventListener('yt-navigate-finish', navigationFinish);
document.addEventListener('fullscreenchange', queueRefresh);
document.addEventListener('loadedmetadata', queueRefresh, true);
let interval = window.setInterval(queueRefresh, 2000);
chrome.storage.onChanged.addListener(storageChanged);
document.addEventListener('timeupdate', autoSkip, true);
document.addEventListener('playing', autoSkip, true);

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'JEV_GET_VIDEO') { respond(navigating ? null : readMetadata()); return; }
  if (message?.type === 'JEV_SEEK' && message.video_id === videoIdFromUrl(location.href)) {
    const video = document.querySelector('video');
    if (video && !document.querySelector('#movie_player')?.classList.contains('ad-showing')
      && typeof message.time === 'number' && Number.isFinite(message.time) && message.time >= 0) {
      // Explicit timestamp navigation also works while auto skip is disabled.
      video.currentTime = Math.min(message.time, Number.isFinite(video.duration) ? video.duration : message.time);
      respond({ ok: true });
    } else respond({ ok: false });
  }
});

window.addEventListener('pagehide', () => {
  disposed = true;
  playback = null;
  generation++;
  observer.disconnect();
  window.clearInterval(interval);
  chrome.storage.onChanged.removeListener(storageChanged);
  document.removeEventListener('timeupdate', autoSkip, true);
  document.removeEventListener('playing', autoSkip, true);
  document.removeEventListener('yt-navigate-start', navigationStart);
  document.removeEventListener('yt-navigate-finish', navigationFinish);
  document.removeEventListener('fullscreenchange', queueRefresh);
  document.removeEventListener('loadedmetadata', queueRefresh, true);
  removeMarkers();
  document.getElementById(STYLE_ID)?.remove();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || !disposed) return;
  disposed = false;
  navigating = false;
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener(storageChanged);
  document.addEventListener('timeupdate', autoSkip, true);
  document.addEventListener('playing', autoSkip, true);
  document.addEventListener('yt-navigate-start', navigationStart);
  document.addEventListener('yt-navigate-finish', navigationFinish);
  document.addEventListener('fullscreenchange', queueRefresh);
  document.addEventListener('loadedmetadata', queueRefresh, true);
  interval = window.setInterval(queueRefresh, 2000);
  queueRefresh();
});
queueRefresh();
