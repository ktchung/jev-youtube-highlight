import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VideoId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{11}$")]
Timestamp = Annotated[float, Field(ge=0, le=14_400, allow_inf_nan=False)]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]


class TranscriptCue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: Timestamp
    duration: Annotated[float, Field(gt=0, le=120, allow_inf_nan=False)]
    text: str = Field(min_length=1, max_length=8000)

    @field_validator("text")
    @classmethod
    def clean_text(cls, value: str) -> str:
        value = re.sub(r"\s+", " ", value).strip()
        if not value:
            raise ValueError("Caption text must not be blank")
        return value

    @model_validator(mode="after")
    def finite_end(self):
        if self.start + self.duration > 14_400:
            raise ValueError("Captions must end within four hours")
        return self


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_id: VideoId
    title: str = Field(min_length=1, max_length=1000)
    description: str = Field(default="", max_length=12_000)
    duration: Annotated[float, Field(gt=0, le=14_400, allow_inf_nan=False)] | None = None
    subject: str | None = Field(default=None, max_length=13_002)
    transcript: list[TranscriptCue] | None = Field(default=None, min_length=1, max_length=10_000)
    force: bool = Field(
        default=False,
        description="Recompute Jev scores while retaining cached captions unless supplied anew.",
    )

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A video title is required")
        return value.strip()

    @field_validator("subject")
    @classmethod
    def blank_subject_is_none(cls, value):
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def validate_transcript(self):
        if self.transcript is not None:
            if sum(len(cue.text) for cue in self.transcript) > 500_000:
                raise ValueError("Transcript text is too long")
            if any(
                a.start > b.start
                for a, b in zip(self.transcript, self.transcript[1:], strict=False)
            ):
                raise ValueError("Transcript timestamps must be in chronological order")
            if self.duration and any(cue.start >= self.duration for cue in self.transcript):
                raise ValueError("Transcript starts after the video ends")
        return self


class Passage(BaseModel):
    id: str
    start: Timestamp
    end: Timestamp
    text: str


class Segment(Passage):
    relevance: Probability
    promotion: Probability
    context_needed: Probability
    tangent: Probability


class Usage(BaseModel):
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    estimated_cost_usd: float = Field(default=0, ge=0, allow_inf_nan=False)
    requests: int = Field(default=0, ge=0)

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.estimated_cost_usd = round(self.estimated_cost_usd + other.estimated_cost_usd, 10)
        self.requests += other.requests


class Analysis(BaseModel):
    id: str
    video_id: VideoId
    title: str
    subject: str
    model: str
    prompt_version: str
    created_at: str
    segments: list[Segment]
    usage: Usage
    transcript_source: str
    visual_analysis: Literal[False] = False


class Progress(BaseModel):
    completed: int = 0
    total: int = 0


class Job(BaseModel):
    id: str
    status: Literal["queued", "fetching", "analyzing", "complete", "failed"] = "queued"
    video_id: VideoId
    progress: Progress = Field(default_factory=Progress)
    analysis: Analysis | None = None
    error: str | None = None
