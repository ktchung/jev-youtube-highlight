import type { Segment, Settings } from './types';

export type MarkedRange = { start: number; end: number; category: 'promotion' | 'tangent' };

export function removalScore(segment: Segment, settings: Settings): number {
  return Math.max(settings.promotions ? segment.promotion : 0, settings.tangents ? segment.tangent : 0);
}

export function markCategory(segment: Segment, settings: Settings): 'promotion' | 'tangent' {
  return settings.promotions && segment.promotion >= (settings.tangents ? segment.tangent : 0) ? 'promotion' : 'tangent';
}

export function usefulnessThresholdFor(segment: Segment, settings: Settings): number {
  return settings.promotions && segment.promotion >= settings.threshold
    ? settings.promotionUsefulnessThreshold : settings.usefulnessThreshold;
}

export function shouldMark(segment: Segment, settings: Settings, kept: readonly string[] = []): boolean {
  if (!settings.promotions && !settings.tangents) return false;
  return !kept.includes(segment.id)
    && removalScore(segment, settings) >= settings.threshold
    && segment.relevance < usefulnessThresholdFor(segment, settings)
    && segment.context_needed < settings.contextThreshold
    && Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end > segment.start;
}

export function markedRanges(segments: Segment[], settings: Settings, kept: readonly string[] = []): MarkedRange[] {
  return segments.filter(segment => shouldMark(segment, settings, kept)).map(segment => ({
    start: segment.start,
    end: segment.end,
    category: markCategory(segment, settings),
  }));
}

export function totalDuration(ranges: Pick<MarkedRange, 'start' | 'end'>[]): number {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let duration = 0;
  let end = 0;
  for (const range of sorted) {
    duration += Math.max(0, range.end - Math.max(range.start, end));
    end = Math.max(end, range.end);
  }
  return duration;
}

export function timestamp(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const sec = value % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(sec).padStart(2, '0')}`;
}
