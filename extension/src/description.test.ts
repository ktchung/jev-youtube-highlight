// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMetadata } from './content-core';
import { installDescriptionBridge, readPlayerDescription } from './description';

const videoId = 'MgvwZaDPCs4';
const url = `https://www.youtube.com/watch?v=${videoId}`;
let dispose: (() => void) | undefined;

function playerResponse(id: string, description: string) {
  return { videoDetails: { videoId: id, shortDescription: description } };
}

describe('full description bridge', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="movie_player"></div><ytd-watch-flexy></ytd-watch-flexy><div id="description-inline-expander"><yt-attributed-string id="attributed-snippet-text">Truncated snippet...</yt-attributed-string><button>...more</button></div>';
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    Reflect.deleteProperty(window, 'ytInitialPlayerResponse');
  });
  it('passes the entire player description and original links through to isolated metadata', () => {
    const description = `First paragraph.\n\n${'Full description. '.repeat(150)}\nhttps://example.com/original-link`;
    Object.assign(document.querySelector('#movie_player')!, { getPlayerResponse: () => playerResponse(videoId, description) });
    dispose = installDescriptionBridge(document, () => videoId);
    expect(readMetadata(document, url)?.description).toBe(description);
  });
  it('reads fresh player data after SPA navigation even when initial metadata is stale', () => {
    Object.assign(window, { ytInitialPlayerResponse: playerResponse('dQw4w9WgXcQ', 'Previous video') });
    Object.assign(document.querySelector('#movie_player')!, { getPlayerResponse: () => playerResponse(videoId, 'Current full description') });
    dispose = installDescriptionBridge(document, () => videoId);
    expect(readMetadata(document, url)?.description).toBe('Current full description');
  });
  it('uses matching watch-page data if the player is temporarily unavailable', () => {
    Object.assign(document.querySelector('#movie_player')!, { getPlayerResponse: () => { throw new Error('Player is changing'); } });
    Object.assign(document.querySelector('ytd-watch-flexy')!, { playerData: playerResponse(videoId, 'Watch-page description') });
    expect(readPlayerDescription(document, videoId)?.description).toBe('Watch-page description');
  });
  it('uses matching initial metadata as a fallback', () => {
    Object.assign(window, { ytInitialPlayerResponse: playerResponse(videoId, 'Initial description') });
    dispose = installDescriptionBridge(document, () => videoId);
    expect(readMetadata(document, url)?.description).toBe('Initial description');
  });
  it('ignores stale metadata and falls back to scoped creator text', () => {
    Object.assign(window, { ytInitialPlayerResponse: playerResponse('dQw4w9WgXcQ', 'Previous video') });
    dispose = installDescriptionBridge(document, () => videoId);
    expect(readMetadata(document, url)?.description).toBe('Truncated snippet...');
  });
  it('preserves an intentionally empty description', () => {
    Object.assign(window, { ytInitialPlayerResponse: playerResponse(videoId, '') });
    dispose = installDescriptionBridge(document, () => videoId);
    expect(readMetadata(document, url)?.description).toBe('');
  });
  it('rejects a response for a different video', () => {
    Object.assign(window, { ytInitialPlayerResponse: playerResponse('dQw4w9WgXcQ', 'Other description') });
    dispose = installDescriptionBridge(document, () => 'dQw4w9WgXcQ');
    expect(readMetadata(document, url)?.description).toBe('Truncated snippet...');
  });
});
