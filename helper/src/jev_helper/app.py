import re
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .cache import Cache
from .config import Settings
from .jev import PROMPT_VERSION, JevClient
from .models import Analysis, AnalysisRequest, Job
from .service import AnalysisService, ServiceBusyError

EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
LOCAL_DEV_ORIGIN = re.compile(r"^http://(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$")
MAX_BODY_BYTES = 2_000_000


def create_app(settings: Settings | None = None, jev: JevClient | None = None) -> FastAPI:
    configuration = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.service = AnalysisService(
            configuration,
            Cache(configuration.helper_cache_path),
            jev or JevClient(configuration),
        )
        yield
        await app.state.service.close()

    app = FastAPI(
        title="Jev YouTube Highlights local helper",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def local_client_only(request: Request, call_next):
        origin = request.headers.get("origin")
        allowed = (
            origin is None
            or bool(EXTENSION_ORIGIN.fullmatch(origin))
            or (
                configuration.helper_allow_localhost_origins
                and bool(LOCAL_DEV_ORIGIN.fullmatch(origin))
            )
        )
        if not allowed:
            return JSONResponse(
                {"detail": "This helper accepts requests from Chrome extensions only."}, 403
            )
        if request.method == "OPTIONS":
            if not origin:
                return JSONResponse({"detail": "Missing Origin header."}, 400)
            response = JSONResponse({"status": "ok"})
        else:
            if request.method == "POST":
                if (
                    request.headers.get("content-type", "").split(";", 1)[0].strip()
                    != "application/json"
                ):
                    return JSONResponse({"detail": "Use application/json."}, 415)
                try:
                    declared_length = int(request.headers.get("content-length", "0"))
                except ValueError:
                    return JSONResponse({"detail": "Invalid Content-Length."}, 400)
                if declared_length > MAX_BODY_BYTES:
                    return JSONResponse({"detail": "Request body is too large."}, 413)
                chunks, total = [], 0
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MAX_BODY_BYTES:
                        return JSONResponse({"detail": "Request body is too large."}, 413)
                    chunks.append(chunk)
                request._body = b"".join(chunks)
            response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Vary"] = "Origin"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        # FastAPI's default includes user-provided input. Do not reflect arbitrary
        # transcript contents, secrets, or non-finite numbers into API responses.
        return JSONResponse(
            {
                "detail": [
                    {"loc": item["loc"], "msg": item["msg"], "type": item["type"]}
                    for item in error.errors()
                ],
            },
            status_code=422,
        )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "api_key_configured": configuration.api_key_configured,
            "model": configuration.jev_model,
            "version": __version__,
        }

    @app.post("/api/analyses", response_model=Job, status_code=202)
    async def start_analysis(body: AnalysisRequest, request: Request):
        if not configuration.api_key_configured:
            raise HTTPException(
                status_code=503,
                detail="Set JEV_API_KEY in the repository's .env file and restart the helper.",
            )
        try:
            return request.app.state.service.submit(body)
        except ServiceBusyError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None

    @app.get("/api/analyses/{job_id}", response_model=Job)
    async def get_job(job_id: str, request: Request):
        job = request.app.state.service.jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found. Start another analysis.")
        return job

    @app.get("/api/videos/{video_id}/analysis", response_model=Analysis)
    async def get_analysis(
        video_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{11}$")], request: Request
    ):
        result = request.app.state.service.cache.latest_analysis(
            video_id, configuration.jev_model, PROMPT_VERSION
        )
        if result is None:
            raise HTTPException(status_code=404, detail="No cached analysis for this video.")
        return result

    # Register last so Host is checked even when our middleware handles preflight.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
    return app
