import json

import httpx
import pytest
from conftest import EXTENSION_ORIGIN, VIDEO_ID, jev_response, wait_for_job


def test_analysis_cache_and_private_key(client_factory, payload, settings):
    client, calls = client_factory()
    health = client.get("/health")
    assert health.json() == {
        "status": "ok",
        "api_key_configured": True,
        "model": "jev-1.14.0",
        "version": "0.1.0",
    }
    assert settings.jev_api_key.get_secret_value() not in health.text
    created = client.post("/api/analyses", json=payload)
    assert created.status_code == 202
    job = wait_for_job(client, created.json()["id"])
    assert job["status"] == "complete", job
    analysis = job["analysis"]
    assert len(analysis["segments"]) == 3
    assert analysis["transcript_source"] == "browser-transcript"
    assert analysis["visual_analysis"] is False
    assert analysis["usage"]["input_tokens"] == 3000
    assert analysis["usage"]["requests"] == 3
    assert analysis["usage"]["estimated_cost_usd"] == pytest.approx(0.000126)
    assert "Free AI OS Kit" not in json.dumps(calls)
    assert calls[0]["state"]["next_passage"]
    assert calls[1]["state"]["previous_passage"]
    assert len(calls[0]["questions"]) == 4
    assert all("instructions" in question for question in calls[0]["questions"].values())
    assert settings.jev_api_key.get_secret_value() not in json.dumps(analysis)
    cached = client.post("/api/analyses", json=payload).json()
    assert cached["status"] == "complete"
    assert cached["analysis"]["id"] == analysis["id"]
    assert len(calls) == 3
    assert client.get(f"/api/videos/{VIDEO_ID}/analysis").json() == analysis
    assert (
        settings.jev_api_key.get_secret_value().encode()
        not in settings.helper_cache_path.read_bytes()
    )


def test_useful_content_keeps_separate_promotion_score(client_factory, payload):
    def handler(request):
        return httpx.Response(
            200,
            json=jev_response(
                {
                    "relevance": 0.98,
                    "promotion": 0.99,
                    "context_needed": 0.8,
                    "tangent": 0.01,
                }
            ),
        )

    client, _ = client_factory(handler)
    job = wait_for_job(client, client.post("/api/analyses", json=payload).json()["id"])
    assert job["status"] == "complete"
    segment = job["analysis"]["segments"][0]
    assert segment["relevance"] == 0.98
    assert segment["promotion"] == 0.99
    assert "skip" not in segment  # Classification and threshold policy stay independent.


@pytest.mark.parametrize("origin", ["https://evil.example", "https://www.youtube.com", "null"])
def test_web_origins_are_rejected(client_factory, payload, origin):
    client, calls = client_factory()
    for method, path in [
        ("GET", "/health"),
        ("POST", "/api/analyses"),
        ("OPTIONS", "/api/analyses"),
    ]:
        response = client.request(method, path, headers={"Origin": origin}, json=payload)
        assert response.status_code == 403
        assert "Access-Control-Allow-Origin" not in response.headers
    assert not calls


def test_extension_preflight_host_validation_and_form_csrf(client_factory, payload):
    client, calls = client_factory()
    response = client.options("/api/analyses", headers={"Origin": EXTENSION_ORIGIN})
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == EXTENSION_ORIGIN
    assert client.get("/health", headers={"Host": "attacker.example"}).status_code == 400
    assert (
        client.options(
            "/api/analyses",
            headers={
                "Origin": EXTENSION_ORIGIN,
                "Host": "attacker.example",
            },
        ).status_code
        == 400
    )
    assert client.post("/api/analyses", data=payload).status_code == 415
    assert (
        client.post(
            "/api/analyses", content="x" * 2_000_001, headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )
    assert not calls


def test_no_key_starts_health_but_refuses_analysis(client_factory, settings, payload):
    config = settings.model_copy(update={"jev_api_key": type(settings.jev_api_key)("")})
    client, calls = client_factory(config=config)
    assert client.get("/health").json()["api_key_configured"] is False
    response = client.post("/api/analyses", json=payload)
    assert response.status_code == 503
    assert "JEV_API_KEY" in response.json()["detail"]
    assert not calls


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(video_id="https://evil.example/"),
        lambda p: p.update(title=" "),
        lambda p: p["transcript"][0].update(start=float("nan")),
        lambda p: p["transcript"][0].update(duration=-1),
        lambda p: p["transcript"][0].update(text=" "),
        lambda p: p["transcript"][0].update(start=61),
        lambda p: p.update(transcript=[]),
        lambda p: p.update(duration=float("inf")),
    ],
)
def test_bad_input_is_safe_validation_error(client_factory, payload, mutate):
    client, calls = client_factory()
    mutate(payload)
    response = client.post(
        "/api/analyses", content=json.dumps(payload), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]
    assert not calls


def test_subject_change_invalidates_scores(client_factory, payload):
    client, calls = client_factory()
    original = wait_for_job(client, client.post("/api/analyses", json=payload).json()["id"])
    payload["subject"] = "Only document summarization"
    changed = wait_for_job(client, client.post("/api/analyses", json=payload).json()["id"])
    assert original["analysis"]["id"] != changed["analysis"]["id"]
    assert changed["analysis"]["subject"] == payload["subject"]
    assert len(calls) == 6


def test_auth_error_does_not_echo_upstream_secret(client_factory, payload, settings):
    def handler(request):
        return httpx.Response(401, json={"error": settings.jev_api_key.get_secret_value()})

    client, _ = client_factory(handler)
    job = wait_for_job(client, client.post("/api/analyses", json=payload).json()["id"])
    assert job["status"] == "failed"
    assert "API key" in job["error"]
    assert settings.jev_api_key.get_secret_value() not in json.dumps(job)
    assert client.get(f"/api/videos/{VIDEO_ID}/analysis").status_code == 404


def test_unknown_ids(client_factory):
    client, _ = client_factory()
    assert client.get("/api/analyses/missing").status_code == 404
    assert client.get(f"/api/videos/{VIDEO_ID}/analysis").status_code == 404
    assert client.get("/api/videos/not-valid/analysis").status_code == 422
