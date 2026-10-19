import hashlib
import re

from .models import Passage, TranscriptCue


def segment_transcript(cues: list[TranscriptCue], duration: float | None = None) -> list[Passage]:
    """Group cues at natural boundaries without extending into uncaptioned gaps.

    Scores never imply frame-level precision: an individual subtitle cue is the
    smallest unit, and long individual cues remain intact to avoid invented timing.
    """
    passages: list[Passage] = []
    group: list[TranscriptCue] = []

    def flush() -> None:
        if not group:
            return
        start = group[0].start
        end = max(cue.start + cue.duration for cue in group)
        if duration:
            end = min(end, duration)
        if end > start:
            passages.append(
                Passage(
                    id=f"s{len(passages):04d}",
                    start=start,
                    end=end,
                    text=" ".join(cue.text for cue in group),
                )
            )
        group.clear()

    for cue in cues:
        if group:
            previous_end = max(item.start + item.duration for item in group)
            elapsed = previous_end - group[0].start
            next_end = cue.start + cue.duration
            gap = cue.start - previous_end
            sentence_end = re.search(r"[.!?][\"')\]]?$", group[-1].text)
            if (
                gap > 2
                or elapsed >= 20
                or (elapsed >= 8 and sentence_end)
                or (next_end - group[0].start > 20 and elapsed >= 8)
            ):
                flush()
        group.append(cue)
    flush()

    # Automatic caption windows can overlap. Give each time instant one owner;
    # retain all text while preventing double-counted duration in the extension.
    for current, following in zip(passages, passages[1:], strict=False):
        current.end = min(current.end, following.start)
    for passage in passages:
        identity = f"{passage.start:.6f}:{passage.end:.6f}:{passage.text}"
        passage.id = "s_" + hashlib.sha256(identity.encode()).hexdigest()[:20]
    return [passage for passage in passages if passage.end > passage.start]
