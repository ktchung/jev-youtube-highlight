import asyncio
import logging
from datetime import UTC, datetime
from uuid import uuid4

from pydantic import ValidationError

from .cache import Cache, fingerprint
from .config import Settings
from .jev import PROMPT_VERSION, JevClient, JevError, make_state
from .models import Analysis, AnalysisRequest, Job, Segment, Usage
from .segmentation import segment_transcript
from .transcripts import TranscriptError, fetch_transcript


class ServiceBusyError(Exception):
    pass


class AnalysisService:
    def __init__(self, settings: Settings, cache: Cache, jev: JevClient):
        self.settings = settings
        self.cache = cache
        self.jev = jev
        self.jobs: dict[str, Job] = {}
        self.active: dict[str, str] = {}
        self.tasks: set[asyncio.Task] = set()
        self.job_slots = asyncio.Semaphore(4)

    def request_key(self, request: AnalysisRequest) -> str:
        return fingerprint(
            {
                "request": request.model_dump(exclude={"force"}),
                "model": self.settings.jev_model,
                "prompt_version": PROMPT_VERSION,
            }
        )

    def submit(self, request: AnalysisRequest) -> Job:
        cache_key = self.request_key(request)
        if cache_key in self.active:
            return self.jobs[self.active[cache_key]]
        if len(self.active) >= 8:
            raise ServiceBusyError("Eight videos are already queued. Wait for one to finish.")
        # Bound in-memory job history, keeping results available in persistent cache.
        for job_id in list(self.jobs):
            if len(self.jobs) < 128:
                break
            if self.jobs[job_id].status in ("complete", "failed"):
                del self.jobs[job_id]
        job = Job(id=str(uuid4()), video_id=request.video_id)
        self.jobs[job.id] = job
        cached = None if request.force else self.cache.get_analysis(cache_key)
        if cached:
            job.status = "complete"
            job.progress.completed = job.progress.total = len(cached.segments)
            job.analysis = cached
            return job
        self.active[cache_key] = job.id
        task = asyncio.create_task(self._run(request, job, cache_key))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return job

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.jev.close()

    async def _run(self, request: AnalysisRequest, job: Job, cache_key: str):
        try:
            async with self.job_slots:
                await self._analyze(request, job, cache_key)
        except (JevError, TranscriptError, ServiceBusyError) as error:
            job.status = "failed"
            job.error = str(error)
        except asyncio.CancelledError:
            job.status = "failed"
            job.error = (
                "The helper stopped during analysis. Retry to reuse completed segment scores."
            )
            raise
        except Exception as error:
            # Exception messages and tracebacks can contain request internals.
            logging.getLogger(__name__).error("Analysis failed (%s)", type(error).__name__)
            job.status = "failed"
            job.error = "Analysis failed unexpectedly. Restart the helper and retry."
        finally:
            self.active.pop(cache_key, None)

    async def _analyze(self, request: AnalysisRequest, job: Job, cache_key: str):
        job.status = "fetching"
        if request.transcript:
            cues, source = request.transcript, "browser-transcript"
        else:
            # Force refreshes Jev judgments, not the video captions. Re-downloading
            # unchanged captions can fail even when a usable transcript is cached.
            existing = self.cache.get_transcript(request.video_id)
            if existing:
                cues, source = existing
            else:
                cues, source = await fetch_transcript(
                    request.video_id, self.settings.helper_enable_ytdlp_fallback
                )
        # Fetched captions receive the same bounds/order checks as browser input.
        checked = request.model_copy(update={"transcript": cues})
        try:
            checked = AnalysisRequest.model_validate(checked.model_dump())
        except ValidationError:
            raise TranscriptError(
                "The caption timestamps were invalid. Try browser captions instead."
            ) from None
        self.cache.save_transcript(request.video_id, checked.transcript, source)
        passages = segment_transcript(checked.transcript, request.duration)
        if not passages:
            raise TranscriptError("The transcript did not contain any usable passages.")
        if len(passages) > 1500:
            raise TranscriptError(
                "This transcript has too many separate passages for the prototype."
            )
        job.status = "analyzing"
        job.progress.total = len(passages)
        usage = Usage()
        results: list[Segment | None] = [None] * len(passages)

        async def score(index: int):
            state = make_state(request, passages, index)
            score_key = fingerprint(
                {
                    "state": state,
                    "model": self.settings.jev_model,
                    "prompt_version": PROMPT_VERSION,
                }
            )
            saved = None if request.force else self.cache.get_score(score_key)
            if saved:
                try:
                    segment = Segment(**passages[index].model_dump(), **saved["scores"])
                    segment_usage = Usage.model_validate(saved["usage"])
                except (ValidationError, KeyError, TypeError):
                    saved = None
            if not saved:
                scores, segment_usage = await self.jev.classify(state)
                segment = Segment(**passages[index].model_dump(), **scores)
                self.cache.save_score(
                    score_key,
                    {
                        "scores": scores,
                        "usage": segment_usage.model_dump(),
                    },
                )
            # Analysis usage describes the successful calls that produced these
            # scores, including calls reused from a previous partial run. It is
            # not a bill for this invocation. Unknown failed-request charges are
            # unavailable from Jev and cannot be included in this estimate.
            usage.add(segment_usage)
            results[index] = segment
            job.progress.completed += 1

        # Cancel outstanding requests after any failed segment; never publish a
        # partial transcript as a complete analysis. Finished scores remain cached.
        tasks = [asyncio.create_task(score(index)) for index in range(len(passages))]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        analysis = Analysis(
            id=str(uuid4()),
            video_id=request.video_id,
            title=request.title,
            subject=request.subject or request.title,
            model=self.settings.jev_model,
            prompt_version=PROMPT_VERSION,
            created_at=datetime.now(UTC).isoformat(),
            segments=[segment for segment in results if segment is not None],
            usage=usage,
            transcript_source=source,
        )
        self.cache.save_analysis(cache_key, analysis)
        job.analysis = analysis
        job.status = "complete"
