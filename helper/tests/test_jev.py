import httpx
import pytest
from conftest import jev_response

from jev_helper.jev import JevClient, JevError


@pytest.mark.parametrize(
    "mutate",
    [
        lambda response: response.pop("answers"),
        lambda response: response["answers"].pop("promotion"),
        lambda response: response["answers"]["relevance"].update(noul=float("nan")),
        lambda response: response["answers"]["relevance"].update(noul=1.01),
        lambda response: response["answers"]["promotion"].update(noul=True),
        lambda response: response["answers"]["tangent"].update(type="score"),
        lambda response: response.pop("usage"),
        lambda response: response["usage"].update(input_tokens=-1),
    ],
)
async def test_malformed_jev_response_is_not_interpreted_as_scores(settings, mutate):
    data = jev_response()
    mutate(data)
    # json.dumps permits NaN, matching a malformed server response.
    import json

    client = JevClient(
        settings, httpx.MockTransport(lambda request: httpx.Response(200, content=json.dumps(data)))
    )
    try:
        with pytest.raises(JevError, match="invalid scores"):
            await client.classify({"target_passage": "Text"})
    finally:
        await client.close()


async def test_transient_errors_retry_but_auth_errors_do_not(settings, monkeypatch):
    calls = []

    async def no_wait(seconds):
        pass

    monkeypatch.setattr("jev_helper.jev.asyncio.sleep", no_wait)

    def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer secret-test-key-never-leak"
        return httpx.Response(429 if len(calls) < 3 else 200, json=jev_response())

    client = JevClient(settings, httpx.MockTransport(handler))
    try:
        _, usage = await client.classify({})
        assert len(calls) == 3
        assert usage.requests == 3
    finally:
        await client.close()

    calls.clear()

    def auth_handler(request):
        calls.append(request)
        return httpx.Response(401, text="Secret server details")

    client = JevClient(settings, httpx.MockTransport(auth_handler))
    try:
        with pytest.raises(JevError, match="API key"):
            await client.classify({})
        assert len(calls) == 1
    finally:
        await client.close()
