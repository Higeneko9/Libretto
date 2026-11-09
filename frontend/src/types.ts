/** A category id. Ids are stable; labels are only for display and may be renamed. */
export type Category = string;

export interface AppSettings {
  comfy_url: string;
  port: number;
  configured?: boolean;
  setup_seen?: boolean;
}

export type CategoryKind = "group_head" | "attribute" | "situation" | "scene" | "custom";

export interface CategoryConfig {
  id: Category;
  /** display names keyed by BCP 47 locale; "und" is the neutral fallback */
  names: Record<string, string>;
  /** `names` resolved for the current UI language (derived by the store, not saved) */
  label: string;
  kind: CategoryKind;
  color: string;
  folder: string;
  locked: boolean;
  can_belong: boolean;
  has_color: boolean;
  template: string;
}

export interface CategoryKindInfo {
  id: CategoryKind;
  can_belong: boolean;
  color: string;
}

const JA: Record<string, string> = {
  style: "スタイル", character: "キャラクター", hair: "髪型", costume: "衣装", pose: "ポーズ", emotion: "表情",
  props: "小道具", situation: "シチュエーション", location: "ロケーション", lighting: "ライティング", view: "視点",
};

const builtin = (id: string, label: string, kind: CategoryKind, color: string, folder: string, can_belong: boolean, has_color = false): CategoryConfig => ({
  id, label, names: { "en-US": label, "ja-JP": JA[id] }, kind, color, folder, locked: true, can_belong, has_color, template: "{text}",
});

/** Mirrors the backend defaults; used until the library's own list is loaded. */
export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  builtin("style", "Style", "scene", "#b07cf0", "styles", false),
  builtin("character", "Character", "group_head", "#e5739b", "characters", false),
  builtin("hair", "Hair", "attribute", "#c98a5a", "hairstyles", true, true),
  builtin("costume", "Costume", "attribute", "#7c9cf0", "costumes", true),
  builtin("pose", "Pose", "attribute", "#e58a5c", "poses", true),
  builtin("emotion", "Emotion", "attribute", "#f07ca0", "emotions", true),
  builtin("props", "Props", "attribute", "#8fb85c", "props", true),
  builtin("situation", "Situation", "situation", "#f0b45c", "situations", true),
  builtin("location", "Location", "scene", "#5cc08a", "locations", false),
  builtin("lighting", "Lighting", "scene", "#f0e05c", "lighting", false),
  builtin("view", "View", "scene", "#5cc0c0", "views", false),
];

/** Node and category colors by node type; kept in sync with the library's categories by the store. */
export const COLORS: Record<string, string> = {
  ...Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c.color])),
  collection: "#e0e0e0",
  generate: "#ff7a45",
  prompt: "#9aa0ad",
};

export const HAIR_COLORS = [
  "black", "dark brown", "brown", "light brown", "auburn", "red", "ginger", "orange", "blonde",
  "platinum blonde", "white", "silver", "gray", "pink", "purple", "blue", "light blue", "green",
];
export const RANDOM_COLOR = "random";

export const HAIR_SWATCH: Record<string, string> = {
  black: "#1a1a1d",
  "dark brown": "#3b2416",
  brown: "#6b4226",
  "light brown": "#a07040",
  auburn: "#7a2e1d",
  red: "#c0301f",
  ginger: "#d2691e",
  orange: "#f08a24",
  blonde: "#e8cd7a",
  "platinum blonde": "#f1ebd3",
  white: "#fafafa",
  silver: "#b8bcc4",
  gray: "#808590",
  pink: "#f27fb0",
  purple: "#8e5bd0",
  blue: "#3f6fe0",
  "light blue": "#8fcdf2",
  green: "#3fae5a",
};

/** Categories missing from a saved order are placed after the nearest earlier category (in library order) that is in it. */
export function normalizeOrder(order: Category[], categories: CategoryConfig[] = DEFAULT_CATEGORIES): Category[] {
  const result = [...order];
  categories.forEach((c, i) => {
    if (result.includes(c.id)) return;
    const before = categories.slice(0, i).reverse().find((p) => result.includes(p.id));
    if (before) result.splice(result.indexOf(before.id) + 1, 0, c.id);
  });
  return result;
}

export interface Lora {
  name: string;
  strength: number;
}

export interface Preset {
  id: string;
  category: Category;
  /** the original name, as used in prompts */
  name: string;
  /** translated display names keyed by locale */
  names?: Record<string, string>;
  keywords: string;
  description: string;
  negative: string;
  labels: string[];
  weight: number;
  lora?: Lora;
  has_thumbnail: boolean;
  thumbnail_profiles: string[];
}

export interface Profile {
  order?: string[];
  id: string;
  name: string;
  format: "tags" | "natural";
  quality_prefix?: string;
  negative_template?: string;
  use_negative?: boolean;
  source?: { type: string; path: string };
  defaults: Record<string, string | number>;
}

export interface WorkflowFile {
  path: string;
  modified?: number;
  profile_id: string | null;
}

export interface Run {
  id: string;
  created_at: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  prompt_id: string | null;
  profile: string;
  seed: number;
  positive: string;
  parent_id: string | null;
  error: string | null;
  images: string[];
  started_at?: string | null;
  finished_at?: string | null;
  duration_s?: number | null;
}

export interface Pick {
  node_id: string;
  category: Category;
  item_id: string;
  name: string;
}

export interface Snapshot {
  id: string;
  profile: string;
  graph: { nodes: unknown[]; edges: unknown[] };
  params: Record<string, unknown>;
  pick_seed: number;
  picks: Pick[];
  prompt: { positive: string; negative: string };
}

export interface LibraryInfo {
  id: string;
  name: string;
  names?: Record<string, string>;
  counts: Record<string, number>;
}

export interface SceneMeta {
  id: string;
  name: string;
  names?: Record<string, string>;
  updated_at: string;
  starter?: number | null;
}

export interface SceneSnap {
  version: number;
  hash: string;
  created_at: string;
  last_used_at: string;
  keep: boolean;
  name?: string;
  thumb_at: string | null;
  generated_at: string;
  run_id: string | null;
}

export interface SceneSnapList {
  max: number;
  default_max: number;
  items: SceneSnap[];
}

/** Tags can be nested with "/": an item tagged "dress/formal" also has the tag "dress". */

export interface PresetClip {
  library: string;
  items: { category: Category; id: string }[];
  cut: boolean;
}

export interface BackupInfo {
  id: string;
  created_at: string;
  size: number;
  note: string;
  kind: "manual" | "auto" | "pre-restore" | "imported";
  includes_history: boolean;
  counts: { libraries: number; scenes: number; profiles: number; runs: number };
}

export interface GraphNodeData extends Record<string, unknown> {
  owner?: string;
  /** library the preset was taken from, so thumbnails resolve across libraries */
  lib?: string;
  group_sep?: "comma" | "break";
  presetId?: string;
  name?: string;
  names?: Record<string, string>;
  keywords?: string;
  description?: string;
  negative?: string;
  emphasis?: number;
  lora?: Lora;
  category?: Category;
  hair_color?: string;
  mode?: "random" | "sequential" | "shuffle" | "fixed";
  filter_labels?: string[];
  exclude_last?: number;
  item_ids?: string[];
  fixed_id?: string;
  profile?: string;
  seed?: number;
  seed_locked?: boolean;
  pick_seed?: number;
  pick_locked?: boolean;
  batch?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  checkpoint?: string;
  override_positive?: string;
  override_negative?: string;
  labels?: string[];
  weight?: number;
  text?: string;
  polarity?: "positive" | "negative";
  placement?: "prepend" | "inline" | "append";
  prepend_positive?: string;
  append_positive?: string;
  prepend_negative?: string;
  append_negative?: string;
  order_mode?: "category" | "position";
  order?: Category[];
  output_prefix?: string;
  output_dir?: string;
  lastPick?: string;
  disabled?: boolean;
}
