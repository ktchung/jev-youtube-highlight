import asyncio
import json

import httpx
from conftest import jev_response

from jev_helper.cache import Cache
from jev_helper.jev import JevClient
from jev_helper.models import AnalysisRequest, TranscriptCue
from jev_helper.segmentation import segment_transcript
from jev_helper.service import AnalysisService
from jev_helper.transcripts import TranscriptError


def test_sentence_boundaries_and_uncaptioned_gaps():
    cues = [
        TranscriptCue(start=0, duration=5, text="Here is the first part"),
        TranscriptCue(start=5, duration=4, text="and its conclusion."),
        TranscriptCue(start=9, duration=4, text="The next thought begins."),
        TranscriptCue(start=30, duration=4, text="After a long demonstration."),
    ]
    passages = segment_transcript(cues)
    assert [(p.start, p.end) for p in passages] == [(0, 9), (9, 13), (30, 34)]
    assert "conclusion" in passages[0].text
    assert passages[1].end < passages[2].start


def test_segment_identity_follows_content_when_earlier_passages_are_added():
    original = [TranscriptCue(start=30, duration=9, text="A useful independent explanation.")]
    earlier = TranscriptCue(start=0, duration=9, text="An unrelated introduction.")
    previous_id = segment_transcript(original)[0].id
    assert segment_transcript([earlier, *original])[1].id == previous_id
    changed = [original[0].model_copy(update={"text": "Different explanation."})]
    assert segment_transcript(changed)[0].id != previous_id


async def test_active_deduplication_bounded_concurrency_and_force(settings, payload):
    active = maximum = calls = 0
    gate = asyncio.Event()

    async def handler(request):
        nonlocal active, maximum, calls
        calls += 1
        active += 1
        maximum = max(maximum, active)
        await gate.wait()
        active -= 1
        return httpx.Response(200, json=jev_response())

    settings.jev_max_concurrency = 2
    service = AnalysisService(
        settings,
        Cache(settings.helper_cache_path),
        JevClient(settings, httpx.MockTransport(handler)),
    )
    request = AnalysisRequest.model_validate(payload)
    try:
        first = service.submit(request)
        second = service.submit(request)
        assert first.id == second.id
        for _ in range(20):
            await asyncio.sleep(0)
            if calls == 2:
                break
        assert calls == 2
        assert maximum == 2
        gate.set()
        await asyncio.gather(*service.tasks)
        assert first.status == "complete"
        assert calls == 3
        assert service.submit(request).analysis.id == first.analysis.id
        forced = service.submit(request.model_copy(update={"force": True}))
        await asyncio.gather(*service.tasks)
        assert forced.status == "complete"
        assert calls == 6
    finally:
        await service.close()


async def test_force_refreshes_scores_without_refetching_cached_captions(
    settings, payload, monkeypatch
):
    captions = [TranscriptCue.model_validate(cue) for cue in payload["transcript"]]
    fetches = []
    calls = []

    async def fetch(video_id, enable_fallback):
        fetches.append(video_id)
        return captions, "youtube-auto"

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=jev_response())

    monkeypatch.setattr("jev_helper.service.fetch_transcript", fetch)
    cache = Cache(settings.helper_cache_path)
    service = AnalysisService(settings, cache, JevClient(settings, httpx.MockTransport(handler)))
    request = AnalysisRequest.model_validate({**payload, "transcript": None})
    try:
        initial = service.submit(request)
        await asyncio.gather(*service.tasks)
        assert initial.status == "complete"
        assert fetches == [request.video_id]
        assert len(calls) == 3
        assert cache.get_transcript(request.video_id) == (captions, "youtube-auto")

        async def blocked_fetch(*args):
            raise TranscriptError("YouTube blocked caption extraction")

        monkeypatch.setattr("jev_helper.service.fetch_transcript", blocked_fetch)

        cached = service.submit(request)
        assert cached.status == "complete"
        assert cached.analysis.id == initial.analysis.id
        assert len(calls) == 3
        assert not service.tasks

        forced = service.submit(request.model_copy(update={"force": True}))
        await asyncio.gather(*service.tasks)
        assert forced.status == "complete"
        assert forced.analysis.id != initial.analysis.id
        assert forced.analysis.transcript_source == "youtube-auto"
        assert forced.analysis.segments == initial.analysis.segments
        assert len(calls) == 6
    finally:
        await service.close()


async def test_force_prefers_supplied_browser_captions_over_cached_captions(
    settings, payload, monkeypatch
):
    async def blocked_fetch(*args):
        raise TranscriptError("YouTube blocked caption extraction")

    monkeypatch.setattr("jev_helper.service.fetch_transcript", blocked_fetch)
    cache = Cache(settings.helper_cache_path)
    cache.save_transcript(
        payload["video_id"],
        [TranscriptCue(start=0, duration=10, text="Older cached captions.")],
        "youtube-auto",
    )
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["state"]["target_passage"])
        return httpx.Response(200, json=jev_response())

    service = AnalysisService(settings, cache, JevClient(settings, httpx.MockTransport(handler)))
    request = AnalysisRequest.model_validate({**payload, "force": True})
    try:
        job = service.submit(request)
        await asyncio.gather(*service.tasks)
        assert job.status == "complete"
        assert job.analysis.transcript_source == "browser-transcript"
        assert cache.get_transcript(request.video_id) == (request.transcript, "browser-transcript")
        assert len(calls) == 3
        assert all("Older cached captions" not in text for text in calls)
    finally:
        await service.close()


async def test_retry_reuses_completed_scores_and_cache_survives_restart(settings, payload):
    calls = []

    def handler(request):
        state = json.loads(request.content)["state"]
        calls.append(state["target_passage"])
        if state["target_passage"].startswith("Subscribe"):
            return httpx.Response(200, json={"answers": {}})
        return httpx.Response(200, json=jev_response())

    cache = Cache(settings.helper_cache_path)
    service = AnalysisService(settings, cache, JevClient(settings, httpx.MockTransport(handler)))
    request = AnalysisRequest.model_validate(payload)
    job = service.submit(request)
    await asyncio.gather(*service.tasks)
    assert job.status == "failed"
    assert cache.get_analysis(service.request_key(request)) is None
    await service.close()
    calls.clear()

    def successful_handler(request):
        calls.append(request)
        return httpx.Response(200, json=jev_response())

    restarted = AnalysisService(
        settings,
        Cache(settings.helper_cache_path),
        JevClient(settings, httpx.MockTransport(successful_handler)),
    )
    try:
        retried = restarted.submit(request)
        await asyncio.gather(*restarted.tasks)
        assert retried.status == "complete"
        assert len(calls) == 1
        assert retried.analysis.usage.input_tokens == 3000
        assert restarted.submit(request).status == "complete"
        assert len(calls) == 1
    finally:
        await restarted.close()
