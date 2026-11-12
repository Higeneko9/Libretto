import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
let level: number;
let contents: EventEmitter & {
  getZoomLevel: () => number;
  setZoomLevel: ReturnType<typeof vi.fn>;
  setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  level = 0;
  contents = Object.assign(new EventEmitter(), {
    getZoomLevel: () => level,
    setZoomLevel: vi.fn((value: number) => { level = value; }),
    setIgnoreMenuShortcuts: vi.fn(),
  });
  const context = createContext({
    __dirname: desktopRoot,
    process: { platform: "win32" },
    require: (name: string) => {
      if (name === "electron") return {
        app: { requestSingleInstanceLock: () => false, quit: vi.fn(), getPath: () => "C:\\Libretto-test-data" },
      };
      if (name === "node:fs") return { readFileSync: vi.fn(), writeFileSync: vi.fn() };
      return require(name);
    },
    win: { webContents: contents },
  });
  runInContext(readFileSync(join(desktopRoot, "main.js"), "utf8"), context);
  runInContext("setupZoom(win)", context);
});

function input(type: string, key: string, modifiers = { control: true, meta: false, shift: false, alt: false }) {
  const event = { preventDefault: vi.fn() };
  contents.emit("before-input-event", event, { type, key, ...modifiers });
  return event;
}

describe("desktop zoom shortcut key delivery", () => {
  it.each([
    ["=", 0.5],
    ["+", 0.5],
    ["-", -0.5],
    ["0", 0],
  ] as const)("keeps %s key events intact and restores menu shortcuts on release", (key, expected) => {
    level = key === "0" ? 1 : 0;
    const down = input("keyDown", key);
    expect(level).toBe(expected);
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    expect(down.preventDefault).not.toHaveBeenCalled();

    const up = input("keyUp", key);
    const controlUp = input("keyUp", "Control", { control: false, meta: false, shift: false, alt: false });
    expect(up.preventDefault).not.toHaveBeenCalled();
    expect(controlUp.preventDefault).not.toHaveBeenCalled();
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(contents.setZoomLevel).toHaveBeenCalledTimes(1);
  });

  it("supports shifted plus without swallowing Shift release or other menu shortcuts", () => {
    const down = input("keyDown", "+", { control: true, meta: false, shift: true, alt: false });
    const shiftUp = input("keyUp", "Shift");
    expect(level).toBe(0.5);
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(shiftUp.preventDefault).not.toHaveBeenCalled();
    input("keyDown", "c");
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(contents.setZoomLevel).toHaveBeenCalledTimes(1);
  });
});
