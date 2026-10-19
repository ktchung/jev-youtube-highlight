import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from jev_helper.app import create_app
from jev_helper.config import Settings
from jev_helper.jev import JevClient

VIDEO_ID = "MgvwZaDPCs4"
EXTENSION_ORIGIN = "chrome-extension://" + "a" * 32


def jev_response(scores=None):
    values = scores or {"relevance": 0.2, "promotion": 0.99, "context_needed": 0.1, "tangent": 0.1}
    return {
        "model": "jev-1.14.0",
        "answers": {name: {"type": "noul", "noul": value} for name, value in values.items()},
        "usage": {"input_tokens": 1000, "output_tokens": 40},
    }


@pytest.fixture
def payload():
    return {
        "video_id": VIDEO_ID,
        "title": "Understanding AI tools",
        "description": "An introduction to useful AI tools\n4:08 Free AI OS Kit",
        "duration": 60,
        "subject": None,
        "transcript": [
            {"start": 0, "duration": 5, "text": "Here is how this useful tool works."},
            {"start": 5, "duration": 5, "text": "It can summarize documents."},
            {"start": 10, "duration": 5, "text": "Subscribe to my newsletter for more."},
            {"start": 15, "duration": 5, "text": "You can join using the link below."},
            {"start": 20, "duration": 5, "text": "Now let us compare the results."},
            {"start": 25, "duration": 5, "text": "The first tool correctly cites its sources."},
        ],
    }


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        jev_api_key="secret-test-key-never-leak",
        helper_cache_path=tmp_path / "cache.sqlite3",
    )


@pytest.fixture
def client_factory(settings):
    clients = []

    def factory(handler=None, config=None):
        configuration = config or settings
        calls = []

        def default_handler(request):
            calls.append(json.loads(request.content))
            return httpx.Response(200, json=jev_response())

        jev = JevClient(configuration, httpx.MockTransport(handler or default_handler))
        client = TestClient(create_app(configuration, jev), base_url="http://127.0.0.1")
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def wait_for_job(client, job_id):
    for _ in range(100):
        response = client.get(f"/api/analyses/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in ("complete", "failed"):
            return job
        time.sleep(0.01)
    pytest.fail("Analysis did not finish")
