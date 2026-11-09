import { describe, expect, it } from "vitest";
import { presetPayload } from "./Palette";
import type { Preset } from "./types";

describe("presetPayload", () => {
  it("carries the keywords and description so a dropped node is not empty", () => {
    const preset = { id: "p-00000001", name: "Nancy", keywords: "nancy, red hair", description: "a girl", negative: "", labels: [] } as unknown as Preset;
    const { type, data } = presetPayload("character", preset, "default");
    expect(type).toBe("character");
    expect(data.keywords).toBe("nancy, red hair");
    expect(data.description).toBe("a girl");
    expect(data.presetId).toBe("p-00000001");
  });
});
