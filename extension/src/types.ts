export interface TranscriptCue {
  start: number;
  duration: number;
  text: string;
}

export interface VideoMetadata {
  video_id: string;
  title: string;
  description: string;
  duration: number | null;
  transcript?: TranscriptCue[];
}

// The helper accepts a 1,000-character title and a 12,000-character description.
export const SUBJECT_MAX_LENGTH = 13_002;

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  relevance: number;
  promotion: number;
  context_needed: number;
  tangent: number;
}

export interface Analysis {
  id: string;
  video_id: string;
  title: string;
  subject: string;
  model: string;
  prompt_version: string;
  created_at: string;
  segments: Segment[];
  usage: { input_tokens: number; output_tokens: number; estimated_cost_usd: number; requests: number };
  transcript_source: string;
  visual_analysis: false;
}

export interface Job {
  id: string;
  status: 'queued' | 'fetching' | 'analyzing' | 'complete' | 'failed';
  video_id: string;
  progress: { completed: number; total: number };
  analysis?: Analysis;
  error?: string;
}

export interface Health {
  status: 'ok';
  api_key_configured: boolean;
  model: string;
  version: string;
}

export interface Settings {
  autoSkip: boolean;
  threshold: number;
  promotions: boolean;
  tangents: boolean;
  promotionUsefulnessThreshold: number;
  usefulnessThreshold: number;
  contextThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  autoSkip: false,
  threshold: 0.9,
  promotions: true,
  tangents: true,
  promotionUsefulnessThreshold: 0.8,
  usefulnessThreshold: 0.5,
  contextThreshold: 0.5,
};

// Older installs have only the marking threshold and category toggles. Apply
// new defaults in both the panel and content script without losing preferences.
export function normalizeSettings(value: unknown): Settings {
  const stored = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  type ThresholdKey = Exclude<keyof Settings, 'autoSkip' | 'promotions' | 'tangents'>;
  const probability = (key: ThresholdKey, minimum = 0): number => {
    const candidate = stored[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(minimum, Math.min(1, candidate)) : DEFAULT_SETTINGS[key];
  };
  return {
    autoSkip: typeof stored.autoSkip === 'boolean' ? stored.autoSkip : DEFAULT_SETTINGS.autoSkip,
    threshold: probability('threshold', 0.5),
    promotions: typeof stored.promotions === 'boolean' ? stored.promotions : DEFAULT_SETTINGS.promotions,
    tangents: typeof stored.tangents === 'boolean' ? stored.tangents : DEFAULT_SETTINGS.tangents,
    promotionUsefulnessThreshold: probability('promotionUsefulnessThreshold'),
    usefulnessThreshold: probability('usefulnessThreshold'),
    contextThreshold: probability('contextThreshold'),
  };
}

export const SETTINGS_KEY = 'jev:settings';
export const videoKey = (id: string, field: 'analysis' | 'kept' | 'job' | 'subject') => `jev:${id}:${field}`;
