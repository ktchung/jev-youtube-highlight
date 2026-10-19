import type { Analysis, VideoMetadata } from './types';

// Explicit UI-only fixture; never shown in the installed extension or sent to Jev.
export const previewVideo: VideoMetadata = {
  video_id: 'MgvwZaDPCs4',
  title: 'Grok Bot Just Got 2 Massive Upgrades. Do These Things Now.',
  description: 'UI demonstration using the user-supplied video and suspected promotion interval.',
  duration: 551,
};

export const previewAnalysis: Analysis = {
  id: 'demo-only', video_id: previewVideo.video_id, title: previewVideo.title,
  subject: 'Grok Bot upgrades and AI workflows', model: 'jev · demo', prompt_version: 'demo-only',
  created_at: '2026-10-19T00:00:00Z', transcript_source: 'Demo fixture · not a transcript', visual_analysis: false,
  usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, requests: 0 },
  segments: [
    { id: 'demo-1', start: 248, end: 274, text: 'Demonstration placeholder for the suspected “Free AI OS Kit” section. This text and these scores are illustrative, not Jev analysis.', relevance: 0.14, promotion: 0.97, context_needed: 0.08, tangent: 0.05 },
    { id: 'demo-2', start: 274, end: 302, text: 'A useful explanation would remain visible even if it also mentions a product or promotion. This is demonstration text.', relevance: 0.92, promotion: 0.73, context_needed: 0.82, tangent: 0.03 },
  ],
};
