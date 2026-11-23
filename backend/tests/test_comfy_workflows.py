import httpx

from libretto.comfy import ComfyClient


def test_only_json_workflows_are_listed():
    def handle(request):
        assert request.url.path == "/api/userdata"
        return httpx.Response(200, json=[
            {"path": "notes.txt"}, {"path": "B.JSON"}, {"path": "preview.webp"},
            {"path": "nested/a.json"}, {"path": "README.md"},
        ])

    client = ComfyClient("http://comfy")
    client._client.close()
    client._client = httpx.Client(base_url="http://comfy", transport=httpx.MockTransport(handle))
    assert [entry["path"] for entry in client.list_workflows()] == ["B.JSON", "nested/a.json"]
