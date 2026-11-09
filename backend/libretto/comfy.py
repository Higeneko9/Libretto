from urllib.parse import quote

import httpx


class ComfyClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url
        self._timeout = timeout
        self._client = httpx.Client(base_url=base_url, timeout=timeout)

    def set_base_url(self, base_url: str) -> None:
        old = self._client
        self.base_url = base_url
        self._client = httpx.Client(base_url=base_url, timeout=self._timeout)
        old.close()

    def queue_prompt(self, workflow: dict, client_id: str) -> str:
        response = self._client.post("/prompt", json={"prompt": workflow, "client_id": client_id})
        if response.status_code != 200:
            raise RuntimeError(f"ComfyUI rejected the workflow: {response.text}")
        return response.json()["prompt_id"]

    def history(self, prompt_id: str) -> dict | None:
        response = self._client.get(f"/history/{prompt_id}")
        response.raise_for_status()
        return response.json().get(prompt_id)

    def queue_state(self) -> dict:
        response = self._client.get("/queue")
        response.raise_for_status()
        return response.json()

    def view(self, filename: str, subfolder: str, folder_type: str) -> bytes:
        response = self._client.get(
            "/view", params={"filename": filename, "subfolder": subfolder, "type": folder_type}
        )
        response.raise_for_status()
        return response.content

    def system_stats(self) -> dict:
        response = self._client.get("/system_stats")
        response.raise_for_status()
        return response.json()

    def interrupt(self) -> None:
        self._client.post("/interrupt")

    def delete_queued(self, prompt_ids: list[str]) -> None:
        self._client.post("/queue", json={"delete": prompt_ids}).raise_for_status()

    def list_workflows(self) -> list[dict]:
        response = self._client.get(
            "/api/userdata",
            params={"dir": "workflows", "recurse": "true", "split": "false", "full_info": "true"},
        )
        response.raise_for_status()
        return sorted(response.json(), key=lambda f: f["path"].lower())

    def get_workflow(self, path: str) -> dict:
        response = self._client.get("/api/userdata/" + quote("workflows/" + path, safe=""))
        response.raise_for_status()
        return response.json()

    def object_info(self, node_type: str) -> dict | None:
        response = self._client.get("/object_info/" + quote(node_type, safe=""))
        if response.status_code != 200:
            return None
        return response.json().get(node_type)
