import { describe, expect, it } from 'vitest';
import { markedRanges, shouldMark, skipTarget, timestamp, totalDuration } from './policy';
import { DEFAULT_SETTINGS, normalizeSettings, type Segment } from './types';

const promotion: Segment = { id: 'a', start: 248, end: 274, text: 'promotion', relevance: 0.1, promotion: 0.98, context_needed: 0.1, tangent: 0.05 };

describe('conservative mark policy', () => {
  it('marks a confident irrelevant promotion but preserves useful material inside it', () => {
    expect(shouldMark(promotion, DEFAULT_SETTINGS)).toBe(true);
    expect(shouldMark({ ...promotion, relevance: 0.79 }, DEFAULT_SETTINGS)).toBe(true);
    expect(shouldMark({ ...promotion, relevance: 0.8 }, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldMark({ ...promotion, relevance: 0.99 }, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldMark({ ...promotion, context_needed: 0.5 }, DEFAULT_SETTINGS)).toBe(false);
  });

  it('uses only enabled categories and keeps uncertainty', () => {
    expect(shouldMark(promotion, { ...DEFAULT_SETTINGS, promotions: false })).toBe(false);
    expect(shouldMark({ ...promotion, tangent: 0.95 }, { ...DEFAULT_SETTINGS, promotions: false })).toBe(true);
    expect(shouldMark(promotion, { ...DEFAULT_SETTINGS, threshold: 0.99 })).toBe(false);
    expect(shouldMark(promotion, { ...DEFAULT_SETTINGS, threshold: 0, promotions: false, tangents: false })).toBe(false);
  });

  it('marks the cached borderline promotional passage at 80%, with adjustable preservation', () => {
    const borderline = { ...promotion, start: 258.799, end: 277.28, relevance: 0.54, context_needed: 0.43 };
    expect(shouldMark(borderline, DEFAULT_SETTINGS)).toBe(true);
    expect(shouldMark(borderline, { ...DEFAULT_SETTINGS, promotionUsefulnessThreshold: 0.5 })).toBe(false);
    expect(shouldMark(borderline, { ...DEFAULT_SETTINGS, contextThreshold: 0.4 })).toBe(false);
    expect(shouldMark(borderline, DEFAULT_SETTINGS, [borderline.id])).toBe(false);
  });

  it('uses the general usefulness threshold for tangents and disabled promotion marking', () => {
    const tangent = { ...promotion, relevance: 0.54, promotion: 0.1, tangent: 0.98 };
    expect(shouldMark(tangent, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldMark(tangent, { ...DEFAULT_SETTINGS, usefulnessThreshold: 0.6 })).toBe(true);
    expect(shouldMark({ ...tangent, promotion: 0.98 }, { ...DEFAULT_SETTINGS, promotions: false })).toBe(false);
    expect(shouldMark({ ...tangent, promotion: 0.89 }, DEFAULT_SETTINGS)).toBe(false);
  });

  it('respects manual keep and rejects unusable intervals', () => {
    expect(shouldMark(promotion, DEFAULT_SETTINGS, ['a'])).toBe(false);
    expect(shouldMark({ ...promotion, end: 248 }, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldMark({ ...promotion, start: Number.NaN }, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldMark({ ...promotion, start: -1 }, DEFAULT_SETTINGS)).toBe(false);
  });

  it('colors according to the enabled strongest removal evidence', () => {
    expect(markedRanges([{ ...promotion, tangent: 0.99 }], DEFAULT_SETTINGS)[0].category).toBe('tangent');
    expect(markedRanges([{ ...promotion, tangent: 0.99 }], { ...DEFAULT_SETTINGS, tangents: false })[0].category).toBe('promotion');
  });

  it('counts overlapping ranges once and formats hours', () => {
    expect(totalDuration([{ start: 10, end: 30 }, { start: 20, end: 40 }, { start: 45, end: 50 }])).toBe(35);
    expect(timestamp(3661.8)).toBe('1:01:01');
    expect(timestamp(248)).toBe('4:08');
  });
});

describe('saved settings migration', () => {
  it('defaults auto skip off and only accepts a saved boolean', () => {
    expect(normalizeSettings({ autoSkip: true }).autoSkip).toBe(true);
    expect(normalizeSettings({ autoSkip: 'true' }).autoSkip).toBe(false);
    expect(normalizeSettings({ threshold: 0.95 }).autoSkip).toBe(false);
  });
  it('adds preservation defaults while keeping existing marking preferences', () => {
    expect(normalizeSettings({ threshold: 0.95, promotions: false, tangents: true })).toEqual({
      ...DEFAULT_SETTINGS, threshold: 0.95, promotions: false,
    });
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('invalid')).toEqual(DEFAULT_SETTINGS);
  });

  it('retains configured slider values and normalizes invalid values', () => {
    expect(normalizeSettings({
      threshold: 2, promotionUsefulnessThreshold: 0.65, usefulnessThreshold: -1,
      contextThreshold: Number.NaN, promotions: 'false', tangents: false,
    })).toEqual({
      ...DEFAULT_SETTINGS, threshold: 1, promotionUsefulnessThreshold: 0.65,
      usefulnessThreshold: 0, tangents: false,
    });
  });
});

describe('automatic skip destination', () => {
  const ranges = [{ start: 10, end: 20 }, { start: 20, end: 30 }, { start: 25, end: 35 }, { start: 40, end: 50 }];

  it('skips connected marked intervals without jumping over useful gaps', () => {
    expect(skipTarget([...ranges].reverse(), 10, 100)).toBe(35);
    expect(skipTarget(ranges, 29, 100)).toBe(35);
    expect(skipTarget(ranges, 35, 100)).toBeNull();
    expect(skipTarget(ranges, 39.99, 100)).toBeNull();
    expect(skipTarget(ranges, 40, 100)).toBe(50);
  });

  it('respects duration and rejects unavailable media timing', () => {
    expect(skipTarget(ranges, 10, 15)).toBe(15);
    for (const duration of [0, 10, NaN, Infinity]) expect(skipTarget(ranges, 10, duration)).toBeNull();
    for (const time of [-1, NaN, Infinity]) expect(skipTarget(ranges, time, 100)).toBeNull();
  });

  it('never skips into or across a manually kept interval', () => {
    const kept = [{ start: 15, end: 25 }];
    expect(skipTarget(ranges, 10, 100, kept)).toBe(15);
    expect(skipTarget(ranges, 15, 100, kept)).toBeNull();
    expect(skipTarget(ranges, 24.99, 100, kept)).toBeNull();
    expect(skipTarget(ranges, 25, 100, kept)).toBe(35);
    expect(skipTarget(markedRanges([promotion], DEFAULT_SETTINGS, [promotion.id]), 250, 551)).toBeNull();
  });
});
