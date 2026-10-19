import type { TranscriptCue, VideoMetadata } from './types';
import { readDescription } from './description';

export function videoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['www.youtube.com', 'm.youtube.com'].includes(parsed.hostname) || parsed.pathname !== '/watch') return null;
    const id = parsed.searchParams.get('v');
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function parseTimestamp(value: string): number | null {
  const text = value.trim();
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function readMetadata(doc: Document = document, url: string = location.href): VideoMetadata | null {
  const videoId = videoIdFromUrl(url);
  if (!videoId) return null;
  const renderedVideoId = doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  if (renderedVideoId && renderedVideoId !== videoId) return null;
  const text = (selector: string) => doc.querySelector(selector)?.textContent?.trim() ?? '';
  const title = text('ytd-watch-metadata h1 yt-formatted-string') || text('h1.title')
    || doc.title.replace(/\s*-\s*YouTube$/, '').trim();
  const video = doc.querySelector('video');
  const duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const raw: { start: number; text: string }[] = [];
  for (const row of doc.querySelectorAll('ytd-transcript-segment-renderer')) {
    const start = parseTimestamp(row.querySelector('.segment-timestamp')?.textContent ?? '');
    const cueText = row.querySelector('.segment-text')?.textContent?.trim();
    if (start !== null && cueText && (duration === null || start < duration)
      && !raw.some(cue => cue.start === start)) raw.push({ start, text: cueText });
  }
  const transcript: TranscriptCue[] = raw.sort((a, b) => a.start - b.start).map((cue, index) => ({
    ...cue,
    duration: Math.max(0.1, Math.min(5, (raw[index + 1]?.start ?? Math.min(cue.start + 5, duration ?? Infinity)) - cue.start)),
  }));
  return {
    video_id: videoId,
    title,
    description: readDescription(doc, videoId),
    duration,
    ...(transcript.length ? { transcript } : {}),
  };
}
