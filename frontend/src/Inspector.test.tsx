import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "./store";

vi.mock("./SceneHistory", () => ({ SceneHistory: () => null }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, compile: vi.fn().mockResolvedValue({ positive: "", negative: "" }) } };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("disables unsupported settings and clears incompatible overrides when changing profiles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useStore.getState();
  useStore.setState({
    selectedId: "generate",
    nodes: [{ id: "generate", type: "generate", position: { x: 0, y: 0 },
      data: { profile: "old", scheduler: "karras", width: 640 } }],
    profiles: [
      { id: "old", name: "Old", format: "tags", defaults: {} },
      { id: "advanced", name: "Advanced", format: "natural", defaults: {},
        supported_params: ["seed", "width"], source: { type: "comfyui", path: "test.json" } },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Inspector />));
    const profileSelect = [...container.querySelectorAll("select")].find((s) => s.value === "old")!;
    await act(async () => {
      profileSelect.value = "advanced";
      profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const scheduler = [...container.querySelectorAll("label")].find((label) => label.textContent?.trim() === "Scheduler")!;
    expect(scheduler.querySelector("input")?.disabled).toBe(true);
    expect(useStore.getState().nodes[0].data.scheduler).toBeUndefined();
    expect(useStore.getState().nodes[0].data.width).toBe(640);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState(previous);
  }
});
