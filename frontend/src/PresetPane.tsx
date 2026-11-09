import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { parseTags, tagChoices } from "./tags";
import { useTags } from "./useTags";
import { useT } from "./i18n/useT";
import { Thumb } from "./nodes";
import { categoryInfo, useStore } from "./store";
import type { Category, Preset } from "./types";

const SAVE_DELAY_MS = 600;

export interface PaneItem {
  category: Category;
  id: string;
}

const dk = (i: PaneItem) => `${i.category}|${i.id}`;

function common<T>(values: T[]): { mixed: boolean; value: T } {
  const first = values[0];
  return { mixed: values.some((v) => v !== first), value: first };
}

function MixedLabel({ text, mixed, count }: { text: string; mixed: boolean; count: number }) {
  const t = useT();
  return (
    <span>
      {text}
      {mixed && (
        <span className="mixed-badge"         title={t("presetPane.mixedTip", { count })}>
                  {t("presetPane.mixed")}
        </span>
      )}
    </span>
  );
}

/** Edits one or more library presets in place (autosaves). With several presets, a field shows "mixed" when values differ and writes to all when edited. */
export function PresetPane({ items }: { items: PaneItem[] }) {
  const t = useT();  const refresh = useStore((s) => s.refreshPresets);
  const bump = useStore((s) => s.bumpThumbs);
  useStore((s) => s.categories); // re-render when category labels change
  const presetsByCat = useStore((s) => s.presets);
  const library = useStore((s) => s.library);
  const [drafts, setDrafts] = useState<Record<string, Preset>>(() => {
    const state = useStore.getState().presets;
    const out: Record<string, Preset> = {};
    for (const i of items) {
      const p = (state[i.category] ?? []).find((x) => x.id === i.id);
      if (p) out[dk(i)] = p;
    }
    return out;
  });
  const [status, setStatus] = useState("");
  const [tagInput, setTagInput] = useState("");
  const dirty = useRef(new Set<string>());
  const latest = useRef(drafts);
  const timer = useRef(0);
  const savedLibrary = useRef(library);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const keys = [...dirty.current];
    dirty.current.clear();
    if (keys.length === 0) return;
    try {
      const cats = new Set<Category>();
      await Promise.all(
        keys.map((k) => {
          const d = latest.current[k];
          if (!d) return;
          cats.add(d.category);
          return api.savePreset(
            d.category,
            { name: d.name, names: d.names, keywords: d.keywords, description: d.description, negative: d.negative, labels: d.labels, weight: d.weight, lora: d.lora?.name ? d.lora : undefined },
            d.id,
          );
        }),
      );
      if (useStore.getState().library === savedLibrary.current) await Promise.all([...cats].map((c) => refresh(c)));
      setStatus(t("presetPane.saved", { n: keys.length }));
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  // switching selection (or unmounting) saves any pending edit first
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => items.map((i) => drafts[dk(i)]).filter(Boolean), [items, drafts]);
  const n = list.length;
  const tagIdx = useTags();
  const allTags = useMemo(() => tagChoices(tagIdx.idx, tagIdx.locale).map((c) => c.path), [tagIdx]);

  const apply = (fn: (p: Preset) => Partial<Preset>) => {
    const next = { ...latest.current };
    for (const i of items) {
      const k = dk(i);
      if (next[k]) {
        next[k] = { ...next[k], ...fn(next[k]) };
        dirty.current.add(k);
      }
    }
    latest.current = next;
    setDrafts(next);
    setStatus(t("presetPane.editing"));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  if (n === 0) return <p className="muted">{t("presetPane.notFound")}</p>;

  const field = (label: string, get: (p: Preset) => string, set: (v: string) => Partial<Preset>, multiline = false) => {
    const c = common(list.map(get));
    const props = {
      value: c.mixed ? "" : c.value,
      placeholder: c.mixed ? t("presetPane.mixedPlaceholder") : "",
      onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => apply(() => set(e.target.value)),
    };
    return (
      <label className="field">
        <MixedLabel text={label} mixed={c.mixed} count={n} />
        {multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
      </label>
    );
  };

  const tagCounts = new Map<string, number>();
  list.forEach((p) => p.labels.forEach((l) => tagCounts.set(l, (tagCounts.get(l) ?? 0) + 1)));
  const addTags = (text: string) => {
    const tags = parseTags(tagIdx.idx, text);
    if (tags.length) apply((p) => ({ labels: [...new Set([...p.labels, ...tags])] }));
    setTagInput("");
  };

  const loraName = common(list.map((p) => p.lora?.name ?? ""));
  const loraStrength = common(list.map((p) => p.lora?.strength ?? 1));
  const first = list[0];
  const categories = [...new Set(list.map((p) => p.category))];

  const upload = async (file?: File) => {
    if (!file) return;
    await api.uploadThumbnail(first.category, first.id, file);
    bump();
    await refresh(first.category);
  };

  return (
    <div className="preset-pane">
      <div className="preset-pane-head">
        {n === 1 ? (
          <>
            <Thumb category={first.category} id={first.id} size={64} />
            <div>
              <strong>{categoryInfo(first.category).label}</strong>
              <div className="muted">{first.id}</div>
              <label className="button">
                {t("presetPane.thumbnail")}
                <input type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
            </div>
          </>
        ) : (
          <div>
            <strong>{t("presetPane.nSelected", { n })}</strong>
            <div className="muted">{categories.map((c) => categoryInfo(c).label).join(", ")}</div>
            <div className="muted">{t("presetPane.multiHint")}</div>
          </div>
        )}
      </div>
      {field(t("presetPane.name"), (p) => p.name, (name) => ({ name }))}
      {(() => {
        const c = common(list.map((p) => p.names?.[tagIdx.locale] ?? ""));
        return (
          <label className="field">
            <MixedLabel text={t("presetPane.nameLocalized", { locale: tagIdx.locale })} mixed={c.mixed} count={n} />
            <input
              value={c.mixed ? "" : c.value}
              placeholder={c.mixed ? t("presetPane.mixedPlaceholder") : ""}
              onChange={(e) => apply((p) => ({ names: { ...p.names, [tagIdx.locale]: e.target.value } }))}
            />
          </label>
        );
      })()}
      {field(
        categories.length === 1 && categoryInfo(first.category).has_color ? t("presetPane.keywordsColor") : t("presetPane.keywords"),
        (p) => p.keywords,
        (keywords) => ({ keywords }),
        true,
      )}
      {field(t("presetPane.description"), (p) => p.description, (description) => ({ description }), true)}
      {field(t("presetPane.negative"), (p) => p.negative ?? "", (negative) => ({ negative }))}
      <div className="field">
        <span>{t("presetPane.tags")}</span>
        <div className="tag-chips">
          {[...tagCounts].sort().          map(([tag, k]) => (
                      <span key={tag} className={`chip on ${k < n ? "partial" : ""}`} title={k < n ? t("presetPane.tagPartial", { k, n }) : t("presetPane.tagAll")}>
                        {tagIdx.path(tag)}
              {k < n && (
                <em>
                  {" "}
                  {k}/{n}
                </em>
              )}
              <button className="chip-x" title={t("presetPane.removeTag")} onClick={() => apply((p) => ({ labels: p.labels.filter((x) => x !== tag) }))}>
                ×
              </button>
            </span>
          ))}
          {tagCounts.size === 0 && <span className="muted">{t("presetPane.noTags")}</span>}
        </div>
        <input
          list="preset-pane-tags"
          value={tagInput}
          placeholder={n > 1 ? t("presetPane.addTagAll") : t("presetPane.addTag")}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") (e.preventDefault(), addTags(tagInput));
          }}
          onBlur={() => tagInput.trim() && addTags(tagInput)}
        />
        <datalist id="preset-pane-tags">
          {allTags.map((path) => (
                      <option key={path} value={path} />
          ))}
        </datalist>
      </div>
      <label className="field">
        <MixedLabel text={t("presetPane.loraFile")} mixed={loraName.mixed} count={n} />
        <input
          value={loraName.mixed ? "" : loraName.value}
          placeholder={loraName.mixed ? t("presetPane.mixedPlaceholder") : t("presetPane.none")}
          onChange={(e) => apply((p) => ({ lora: { name: e.target.value, strength: p.lora?.strength ?? 1 } }))}
        />
      </label>
      <label className="field">
        <MixedLabel text={t("presetPane.loraStrength")} mixed={loraStrength.mixed} count={n} />
        <input
          type="number"
          step={0.05}
          value={loraStrength.mixed ? "" : loraStrength.value}
          placeholder={loraStrength.mixed ? t("presetPane.mixedPlaceholder") : ""}
          onChange={(e) => e.target.value !== "" && apply((p) => ({ lora: { name: p.lora?.name ?? "", strength: Number(e.target.value) } }))}
        />
      </label>
      <p className="muted">{status || t("presetPane.autosave")}</p>
    </div>
  );
}
