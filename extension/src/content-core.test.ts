// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseTimestamp, readMetadata, videoIdFromUrl } from './content-core';

const url = 'https://www.youtube.com/watch?v=MgvwZaDPCs4';

describe('YouTube metadata extraction', () => {
  beforeEach(() => { document.body.innerHTML = ''; document.title = 'Test video - YouTube'; });
  it('accepts only supported watch URLs and valid video IDs', () => {
    expect(videoIdFromUrl(url)).toBe('MgvwZaDPCs4');
    expect(videoIdFromUrl('https://evil.example/watch?v=MgvwZaDPCs4')).toBe(null);
    expect(videoIdFromUrl('https://www.youtube.com/shorts/MgvwZaDPCs4')).toBe(null);
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=bad')).toBe(null);
  });
  it('parses hour timestamps and rejects invalid minute/second components', () => {
    expect(parseTimestamp(' 4:08 ')).toBe(248);
    expect(parseTimestamp('1:04:08')).toBe(3848);
    expect(parseTimestamp('4:77')).toBe(null);
    expect(parseTimestamp('no timestamp')).toBe(null);
  });
  it('reads an already rendered transcript without opening any interface', () => {
    document.body.innerHTML = '<ytd-watch-metadata><h1><yt-formatted-string>Actual title</yt-formatted-string></h1></ytd-watch-metadata><video></video><ytd-transcript-segment-renderer><div class="segment-timestamp">4:08</div><div class="segment-text">First passage</div></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><div class="segment-timestamp">4:12</div><div class="segment-text">Next passage</div></ytd-transcript-segment-renderer>';
    Object.defineProperty(document.querySelector('video'), 'duration', { value: 551 });
    expect(readMetadata(document, url)).toMatchObject({ video_id: 'MgvwZaDPCs4', title: 'Actual title', duration: 551, transcript: [{ start: 248, duration: 4, text: 'First passage' }, { start: 252, duration: 5, text: 'Next passage' }] });
  });
  it('ignores stale metadata during SPA navigation', () => {
    document.body.innerHTML = '<ytd-watch-flexy video-id="dQw4w9WgXcQ"></ytd-watch-flexy>';
    expect(readMetadata(document, url)).toBe(null);
  });
  it('reads only the creator text from the collapsed description', () => {
    document.body.innerHTML = `<div id="description-inline-expander">
      <div id="expanded"><yt-attributed-string></yt-attributed-string></div>
      <div id="snippet"><yt-attributed-string id="attributed-snippet-text">Creator text with a <a>link</a>.</yt-attributed-string><button>...more</button></div>
      <button id="expand">...more</button>
      <div hidden>Subtitles and auto-dubbing<br>Show transcript<br>Channel name<br>Video details</div>
      <button id="collapse" hidden>Show less</button>
    </div>`;
    expect(readMetadata(document, url)?.description).toBe('Creator text with a link.');
  });
  it('prefers expanded creator text without duplicating the collapsed snippet', () => {
    document.body.innerHTML = `<div id="description-inline-expander">
      <div id="expanded"><yt-attributed-string>Full creator description.\nSecond paragraph.</yt-attributed-string></div>
      <yt-attributed-string id="attributed-snippet-text">Full creator...</yt-attributed-string>
      <button>Show less</button>
    </div>`;
    expect(readMetadata(document, url)?.description).toBe('Full creator description.\nSecond paragraph.');
  });
  it('does not substitute channel cards when the creator description is missing', () => {
    document.body.innerHTML = '<div id="description"><div id="description-inline-expander"><button>...more</button><div><yt-attributed-string>Channel name</yt-attributed-string></div></div></div>';
    expect(readMetadata(document, url)?.description).toBe('');
  });
  it('does not assign long silence to speech or accept duplicate/out-of-bounds cues', () => {
    document.body.innerHTML = '<video></video>' + [
      ['0:01', 'First'], ['0:01', 'duplicate'], ['4:08', 'Second'], ['9:30', 'out of bounds'],
    ].map(([time, text]) => `<ytd-transcript-segment-renderer><div class="segment-timestamp">${time}</div><div class="segment-text">${text}</div></ytd-transcript-segment-renderer>`).join('');
    Object.defineProperty(document.querySelector('video'), 'duration', { value: 551 });
    expect(readMetadata(document, url)?.transcript).toEqual([{ start: 1, duration: 5, text: 'First' }, { start: 248, duration: 5, text: 'Second' }]);
  });
});
