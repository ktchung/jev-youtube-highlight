import asyncio
import html
import logging
from urllib.parse import urlparse

import httpx
import requests
from youtube_transcript_api import YouTubeTranscriptApi

from .models import TranscriptCue


class TranscriptError(Exception):
    """A caption retrieval failure safe to show in the extension."""


class _TimedSession(requests.Session):
    def request(self, *args, **kwargs):
        kwargs.setdefault("timeout", (10, 20))
        return super().request(*args, **kwargs)


class _QuietLogger:
    def debug(self, message):
        pass

    info = debug
    warning = debug
    error = debug


def _fetch_youtube(video_id: str) -> tuple[list[TranscriptCue], str]:
    with _TimedSession() as session:
        result = YouTubeTranscriptApi(http_client=session).fetch(
            video_id, languages=["en", "en-US", "en-GB"]
        )
    cues = [
        TranscriptCue(start=cue.start, duration=cue.duration, text=html.unescape(cue.text))
        for cue in result
        if cue.text.strip() and cue.duration > 0
    ]
    source = "youtube-auto" if result.is_generated else "youtube-manual"
    if not cues:
        raise TranscriptError("YouTube returned an empty English transcript.")
    return cues, source


def _find_ytdlp_caption(video_id: str) -> str:
    try:
        import yt_dlp
    except ImportError as error:
        raise TranscriptError(
            "The optional caption fallback is enabled but yt-dlp is not installed. "
            "Install the helper's fallback extra."
        ) from error

    with yt_dlp.YoutubeDL(
        {
            "quiet": True,
            "no_warnings": True,
            "logger": _QuietLogger(),
            "skip_download": True,
            "socket_timeout": 15,
            "retries": 1,
            "extractor_retries": 1,
            "noplaylist": True,
        }
    ) as downloader:
        info = downloader.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
    for key in ("subtitles", "automatic_captions"):
        tracks = info.get(key) or {}
        languages = sorted(tracks, key=lambda code: (code != "en", code))
        for language in languages:
            if language == "en" or language.startswith("en-"):
                for track in tracks[language]:
                    if track.get("ext") == "json3":
                        address = track.get("url", "")
                        parsed = urlparse(address)
                        if parsed.scheme == "https" and parsed.hostname in {
                            "www.youtube.com",
                            "youtube.com",
                            "video.google.com",
                        }:
                            return address
    raise TranscriptError("No English captions were available from the fallback.")


async def fetch_transcript(
    video_id: str, enable_fallback: bool = False
) -> tuple[list[TranscriptCue], str]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(_fetch_youtube, video_id), timeout=70)
    except Exception:
        # Do not relay upstream exception text: it may contain URLs or request internals.
        logging.getLogger(__name__).info("Primary caption retrieval failed; video_id=%s", video_id)
    if enable_fallback:
        try:
            url = await asyncio.wait_for(
                asyncio.to_thread(_find_ytdlp_caption, video_id), timeout=70
            )
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                response = await client.get(url)
                response.raise_for_status()
                if len(response.content) > 2_000_000:
                    raise TranscriptError("The caption response was too large.")
                events = response.json().get("events", [])
            cues = []
            for event in events:
                text = "".join(part.get("utf8", "") for part in event.get("segs", []))
                if text.strip() and event.get("dDurationMs", 0) > 0:
                    cues.append(
                        TranscriptCue(
                            start=event["tStartMs"] / 1000,
                            duration=event["dDurationMs"] / 1000,
                            text=html.unescape(text),
                        )
                    )
            if cues:
                return cues, "youtube-ytdlp"
        except TranscriptError:
            raise
        except Exception:
            logging.getLogger(__name__).info("Fallback captions failed; video_id=%s", video_id)
    raise TranscriptError(
        "Could not retrieve English captions from YouTube. Auto-generated captions are supported, "
        "but YouTube can block extraction. Open the video's transcript in YouTube and retry with "
        "browser captions, or enable the optional yt-dlp fallback in .env."
    )
