const REQUEST = 'jev:description-request';
const RESPONSE = 'jev:description-response';

interface Description {
  video_id: string;
  description: string;
}

type PlayerResponse = { videoDetails?: { videoId?: unknown; shortDescription?: unknown } };

// Called in YouTube's main world: content scripts cannot access its JS objects.
export function readPlayerDescription(doc: Document, videoId: string | null): Description | null {
  if (!videoId) return null;
  const sources = [
    () => (doc.querySelector('#movie_player') as Element & { getPlayerResponse?: () => PlayerResponse })?.getPlayerResponse?.(),
    () => (doc.querySelector('ytd-watch-flexy') as Element & { playerData?: PlayerResponse })?.playerData,
    () => (doc.defaultView as Window & { ytInitialPlayerResponse?: PlayerResponse } | null)?.ytInitialPlayerResponse,
  ];
  for (const source of sources) {
    try {
      const details = source()?.videoDetails;
      if (details?.videoId === videoId && typeof details.shortDescription === 'string') {
        return { video_id: videoId, description: details.shortDescription };
      }
    } catch { /* A player being replaced during navigation may be unavailable. */ }
  }
  return null;
}

export function installDescriptionBridge(doc: Document, currentVideoId: () => string | null): () => void {
  const respond = () => {
    const value = readPlayerDescription(doc, currentVideoId());
    if (value) doc.dispatchEvent(new CustomEvent(RESPONSE, { detail: JSON.stringify(value) }));
  };
  doc.addEventListener(REQUEST, respond);
  return () => doc.removeEventListener(REQUEST, respond);
}

// The synchronous DOM event carries only the current video's public description.
export function readDescription(doc: Document, videoId: string): string {
  let description: string | null = null;
  const receive = (event: Event) => {
    try {
      const value = JSON.parse((event as CustomEvent<string>).detail) as Description;
      if (value.video_id === videoId && typeof value.description === 'string') description = value.description;
    } catch { /* Ignore malformed page messages and use the scoped DOM fallback. */ }
  };
  doc.addEventListener(RESPONSE, receive);
  try { doc.dispatchEvent(new CustomEvent(REQUEST)); }
  finally { doc.removeEventListener(RESPONSE, receive); }
  if (description !== null) return description;

  // Never read the expander itself: it also contains buttons and channel cards.
  for (const selector of [
    '#description-inline-expander #expanded > yt-attributed-string',
    '#description-inline-expander #expanded > yt-formatted-string',
    '#description-inline-expander #attributed-snippet-text',
    '#description-inline-expander #plain-snippet-text',
    '#description-inline-expander #formatted-snippet-text',
    '#description > yt-formatted-string',
  ]) {
    const text = doc.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return '';
}
