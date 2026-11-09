import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { parseTags, presetTitle, tagChoices } from "./tags";
import { useTags } from "./useTags";
import { canBelong, categoryInfo, characterLabel, isCharacterNode, useStore, type LbNode } from "./store";
import { SceneHistory } from "./SceneHistory";
import { useT } from "./i18n/useT";
import { HAIR_COLORS, HAIR_SWATCH, RANDOM_COLOR, normalizeOrder, type Category, type GraphNodeData } from "./types";

function Text({
  label,
  value,
  onChange,
  multiline,
  placeholder,
}: {
  label: string;
  value?: string | number;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={3} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function Num({
  label,
  value,
  onChange,
  placeholder,
  step,
}: {
  label: string;
  value?: number;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </label>
  );
}

function TagsField({ label, value, onChange, suggestions = [] }: { label: string; value: string[]; onChange: (v: string[]) => void; suggestions?: string[] }) {
  const tags = useTags();
  const [text, setText] = useState(() => value.map(tags.path).join(", "));
  const listId = `tags-${label.replace(/\W/g, "")}`;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        list={listId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseTags(tags.idx, e.target.value));
        }}
      />
      <datalist id={listId}>
        {suggestions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </label>
  );
}

function HairColorField({ id, value, allowRandom }: { id: string; value?: string; allowRandom?: boolean }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const color = value ?? "";
  const set = (hair_color: string) => update(id, { hair_color });
  const isCustom = color !== "" && color !== RANDOM_COLOR && !HAIR_COLORS.includes(color);
  const [custom, setCustom] = useState(isCustom);
  const showCustom = custom || isCustom;
  const pick = (v: string) => {
    setCustom(false);
    set(v);
  };
  return (
    <div className="field">
      <span>
        {t("inspector.hairColor")} <strong>{color || t("inspector.none")}</strong>
        {allowRandom ? ` ${t("inspector.hairColorRandomHint")}` : ""}
      </span>
      <div className="swatches">
        <button className={`swatch none ${color === "" && !showCustom ? "on" : ""}`} title={t("inspector.hairNoneHint")} onClick={() => pick("")}>
          ∅
        </button>
        {HAIR_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${color === c ? "on" : ""}`}
            style={{ background: HAIR_SWATCH[c] }}
            title={c}
            onClick={() => pick(c)}
          />
        ))}
        {allowRandom && (
          <button className={`swatch random ${color === RANDOM_COLOR ? "on" : ""}`} title={t("inspector.random")} onClick={() => pick(RANDOM_COLOR)}>
            ?
          </button>
        )}
        <button className={`swatch none ${showCustom ? "on" : ""}`} title={t("inspector.customColor")} onClick={() => (setCustom(true), set(isCustom ? color : ""))}>
          …
        </button>
      </div>
      {showCustom && <input value={color} placeholder={t("inspector.customColorPlaceholder")} autoFocus onChange={(e) => set(e.target.value)} />}
    </div>
  );
}

function OwnerField({ id, data }: { id: string; data: GraphNodeData }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const nodes = useStore((s) => s.nodes);
  const characters = nodes.filter(isCharacterNode);
  const current = characters.some((n) => n.id === data.owner) ? data.owner : "";
  return (
    <label className="field" title={t("inspector.ownerHint")}>
      <span>{t("inspector.belongsTo")}</span>
      <select value={current} onChange={(e) => update(id, { owner: e.target.value || undefined })}>
        <option value="">{t("inspector.wholeScene")}</option>
        {characters.map((n) => (
          <option key={n.id} value={n.id}>
            {characterLabel(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

function PresetFields({ id, category, data }: { id: string; category: Category; data: GraphNodeData }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const refresh = useStore((s) => s.refreshPresets);
  const bump = useStore((s) => s.bumpThumbs);
  const [message, setMessage] = useState("");
  const categoryPresets = useStore((s) => s.presets[category]);
  const info = useStore((s) => s.categories).find((c) => c.id === category) ?? categoryInfo(category);
  const library = useStore((s) => s.library);
  const tags = useTags();
  const allTags = useMemo(() => tagChoices(tags.idx, tags.locale).map((t) => t.path), [tags]);

  const save = async () => {
    const saved = await api.savePreset(
      category,
      {
        name: data.name,
        names: data.names,
        keywords: data.keywords,
        description: data.description,
        negative: data.negative,
        labels: data.labels ?? [],
        weight: data.weight ?? 1,
        lora: data.lora?.name ? data.lora : undefined,
      },
      data.presetId,
    );
    update(id, { presetId: saved.id, name: saved.name, lib: library });
    await refresh(category);
    setMessage(t("inspector.presetSaved", { id: saved.id }));
  };

  const upload = async (file?: File) => {
    if (!file || !data.presetId) return;
    await api.uploadThumbnail(category, data.presetId, file);
    bump();
    await refresh(category);
  };

  return (
    <>
      <Text label={t("inspector.name")} value={data.name} onChange={(v) => update(id, { name: v })} />
      <Text
        label={t("inspector.nameLocalized", { locale: tags.locale })}
        value={data.names?.[tags.locale] ?? ""}
        onChange={(v) => update(id, { names: { ...data.names, [tags.locale]: v } })}
      />
      {info.can_belong && <OwnerField id={id} data={data} />}
      {info.has_color && <HairColorField id={id} value={data.hair_color} />}
      <Text
        label={info.has_color ? t("inspector.keywordsColor") : t("inspector.keywords")}
        multiline
        value={data.keywords}
        onChange={(v) => update(id, { keywords: v })}
      />
      <Text
        label={t("inspector.description")}
        multiline
        value={data.description}
        onChange={(v) => update(id, { description: v })}
      />
      <Text label={t("inspector.negative")} value={data.negative} onChange={(v) => update(id, { negative: v })} />
      <TagsField
        key={id}
        label={t("inspector.searchTags")}
        value={data.labels ?? []}
        suggestions={allTags}
        onChange={(v) => update(id, { labels: v })}
      />
      <Num label={t("inspector.emphasis")} step={0.05} value={data.emphasis ?? 1} onChange={(v) => update(id, { emphasis: v ?? 1 })} />
      <Text
        label={t("inspector.loraFile")}
        value={data.lora?.name}
        placeholder={t("inspector.none")}
        onChange={(v) => update(id, { lora: { name: v, strength: data.lora?.strength ?? 1 } })}
      />
      <Num
        label={t("inspector.loraStrength")}
        step={0.05}
        value={data.lora?.strength ?? 1}
        onChange={(v) => update(id, { lora: { name: data.lora?.name ?? "", strength: v ?? 1 } })}
      />
      <div className="row">
        <button onClick={save}>{data.presetId ? t("inspector.updatePreset") : t("inspector.saveAsPreset")}</button>
        {data.presetId && (
          <label className="button">
            {t("inspector.uploadThumbnail")}
            <input type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
          </label>
        )}
      </div>
      {message && <p className="muted">{message}</p>}
    </>
  );
}

function PromptFields({ id, data }: { id: string; data: GraphNodeData }) {
  const t = useT();
  const categories = useStore((s) => s.categories);
  const update = useStore((s) => s.updateNode);
  const placement = data.placement ?? "inline";
  return (
    <>
      <Text label={t("inspector.promptText")} multiline value={data.text} onChange={(v) => update(id, { text: v })} />
      <label className="field">
        <span>{t("inspector.type")}</span>
        <select value={data.polarity ?? "positive"} onChange={(e) => update(id, { polarity: e.target.value as "positive" | "negative" })}>
          <option value="positive">{t("inspector.positive")}</option>
          <option value="negative">{t("inspector.negativeDarkRed")}</option>
        </select>
      </label>
      {data.placement !== "prepend" && data.placement !== "append" && data.polarity !== "negative" && <OwnerField id={id} data={data} />}
      <label className="field">
        <span>{t("inspector.placement")}</span>
        <select value={placement} onChange={(e) => update(id, { placement: e.target.value as GraphNodeData["placement"] })}>
          <option value="prepend">{t("inspector.prepend")}</option>
          <option value="inline">{t("inspector.inline")}</option>
          <option value="append">{t("inspector.append")}</option>
        </select>
      </label>
      <label className="field">
        <span>{t("inspector.promptCategory")}</span>
        <select value={data.category ?? ""} onChange={(e) => update(id, { category: (e.target.value || undefined) as Category | undefined })}>
          <option value="">{t("inspector.noneEndOfInline")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function CollectionFields({ id, data }: { id: string; data: GraphNodeData }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const category = (data.category ?? "costume") as Category;
  const categories = useStore((s) => s.categories);
  const info = categories.find((c) => c.id === category) ?? categoryInfo(category);
  const presets = useStore((s) => s.presets[category]) ?? [];
  const ids = data.item_ids ?? [];
  const tags = useTags();
  const allTags = useMemo(() => tagChoices(tags.idx, tags.locale).map((t) => t.path), [tags]);
  const toggle = (pid: string) =>
    update(id, { item_ids: ids.includes(pid) ? ids.filter((i) => i !== pid) : [...ids, pid] });
  return (
    <>
      <label className="field">
        <span>{t("inspector.category")}</span>
        <select value={category} onChange={(e) => update(id, { category: e.target.value as Category, item_ids: [] })}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {info.can_belong && <OwnerField id={id} data={data} />}
      {info.has_color && <HairColorField id={id} value={data.hair_color} allowRandom />}
      <label className="field">
        <span>{t("inspector.pickMode")}</span>
        <select value={data.mode ?? "random"} onChange={(e) => update(id, { mode: e.target.value as GraphNodeData["mode"] })}>
          <option value="random">{t("inspector.modeRandom")}</option>
          <option value="shuffle">{t("inspector.modeShuffle")}</option>
          <option value="sequential">{t("inspector.modeSequential")}</option>
          <option value="fixed">{t("inspector.modeFixed")}</option>
        </select>
      </label>
      {data.mode === "fixed" && (
        <label className="field">
          <span>{t("inspector.fixedItem")}</span>
          <select value={data.fixed_id ?? ""} onChange={(e) => update(id, { fixed_id: e.target.value })}>
            <option value="">{t("inspector.first")}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {presetTitle(p.name, p.names, tags.locale)}
              </option>
            ))}
          </select>
        </label>
      )}
      <TagsField
        key={id}
        label={t("inspector.onlyTags")}
        value={data.filter_labels ?? []}
        suggestions={allTags}
        onChange={(v) => update(id, { filter_labels: v })}
      />
      <Num
        label={t("inspector.excludeLast")}
        value={data.exclude_last ?? 0}
        onChange={(v) => update(id, { exclude_last: v ?? 0 })}
      />
      <div className="field">
        <span>{t("inspector.limitItems")}</span>
        <div className="checks">
          {presets.map((p) => (
            <label key={p.id}>
              <input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} /> {presetTitle(p.name, p.names, tags.locale)}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function ProfileSettings({ profileId }: { profileId?: string }) {
  const t = useT();
  const profile = useStore((s) => s.profiles.find((p) => p.id === profileId));
  const refresh = useStore((s) => s.refreshProfiles);
  const [draft, setDraft] = useState({ format: "tags", quality_prefix: "", negative_template: "" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (profile)
      setDraft({
        format: profile.format,
        quality_prefix: profile.quality_prefix ?? "",
        negative_template: profile.negative_template ?? "",
      });
    setMessage("");
  }, [profile]);

  if (!profile) return null;
  const save = async () => {
    await api.patchProfile(profile.id, { ...draft, format: draft.format as "tags" | "natural" });
    await refresh();
    setMessage(t("inspector.saved"));
  };
  return (
    <details>
      <summary>{t("inspector.profileSettings", { name: profile.name })}</summary>
      <label className="field">
        <span>{t("inspector.promptFormat")}</span>
        <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
          <option value="tags">{t("inspector.formatTags")}</option>
          <option value="natural">{t("inspector.formatNatural")}</option>
        </select>
      </label>
      <Text label={t("inspector.prefix")} multiline value={draft.quality_prefix} onChange={(v) => setDraft({ ...draft, quality_prefix: v })} />
      <Text label={t("inspector.negativeTemplate")} multiline value={draft.negative_template} onChange={(v) => setDraft({ ...draft, negative_template: v })} />
      <button onClick={save}>{t("inspector.saveProfile")}</button> {message && <span className="muted">{message}</span>}
    </details>
  );
}

function PromptOrder({ id, data, defaultOrder }: { id: string; data: GraphNodeData; defaultOrder?: string[] }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const mode = data.order_mode ?? "category";
  const categories = useStore((s) => s.categories);
  const order = normalizeOrder(data.order ?? (defaultOrder ?? categories.map((c) => c.id)), categories);
  const labelOf = (c: string) => categories.find((x) => x.id === c)?.label ?? c;
  const move = (index: number, delta: number) => {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update(id, { order: next });
  };
  return (
    <>
      <h3>{t("inspector.promptOrder")}</h3>
      <label className="field">
        <span>{t("inspector.orderBy")}</span>
        <select value={mode} onChange={(e) => update(id, { order_mode: e.target.value as "category" | "position" })}>
          <option value="category">{t("inspector.orderCategory")}</option>
          <option value="position">{t("inspector.orderPosition")}</option>
        </select>
      </label>
      {mode === "category" && (
        <div className="order-list">
          {order.map((c, i) => (
            <div key={c} className="row">
              <span style={{ flex: 1 }}>{i + 1}. {labelOf(c)}</span>
              <button disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
              <button disabled={i === order.length - 1} onClick={() => move(i, 1)}>▼</button>
            </div>
          ))}
          {data.order && <button onClick={() => update(id, { order: undefined })}>{t("inspector.resetOrder")}</button>}
        </div>
      )}
      <p className="muted">{t("inspector.orderNote")}</p>
    </>
  );
}

function GenerateFields({ id, data }: { id: string; data: GraphNodeData }) {
  const t = useT();
  const update = useStore((s) => s.updateNode);
  const profiles = useStore((s) => s.profiles);
  const defaults = profiles.find((p) => p.id === data.profile)?.defaults ?? {};
  const d = (key: string) => (defaults[key] !== undefined ? String(defaults[key]) : "");
  return (
    <>
      <label className="field">
        <span>{t("inspector.profileWorkflow")}</span>
        <select value={data.profile} onChange={(e) => update(id, { profile: e.target.value })}>
          <optgroup label={t("inspector.builtIn")}>
            {profiles
              .filter((p) => !p.source)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
          <optgroup label={t("inspector.comfyWorkflows")}>
            {profiles
              .filter((p) => p.source)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        </select>
      </label>
      <ProfileSettings profileId={data.profile} />
      <Num label={t("inspector.batchImages")} value={data.batch ?? 1} onChange={(v) => update(id, { batch: Math.max(1, v ?? 1) })} />
      <label className="check">
        <input type="checkbox" checked={!!data.seed_locked} onChange={(e) => update(id, { seed_locked: e.target.checked })} />{" "}
        {t("inspector.lockSeed")}
      </label>
      <Num label={t("inspector.seed")} value={data.seed === -1 ? undefined : data.seed} placeholder={t("inspector.random")} onChange={(v) => update(id, { seed: v ?? -1 })} />
      <label className="check">
        <input type="checkbox" checked={!!data.pick_locked} onChange={(e) => update(id, { pick_locked: e.target.checked })} />{" "}
        {t("inspector.lockPickSeed")}
      </label>
      <Num
        label={t("inspector.pickSeed")}
        value={data.pick_seed === -1 ? undefined : data.pick_seed}
        placeholder={t("inspector.random")}
        onChange={(v) => update(id, { pick_seed: v ?? -1 })}
      />
      <Text label={t("inspector.checkpoint")} value={data.checkpoint} placeholder={d("checkpoint")} onChange={(v) => update(id, { checkpoint: v })} />
      <Num label={t("inspector.width")} value={data.width} placeholder={d("width")} onChange={(v) => update(id, { width: v })} />
      <Num label={t("inspector.height")} value={data.height} placeholder={d("height")} onChange={(v) => update(id, { height: v })} />
      <Num label={t("inspector.steps")} value={data.steps} placeholder={d("steps")} onChange={(v) => update(id, { steps: v })} />
      <Num label="CFG" step={0.5} value={data.cfg} placeholder={d("cfg")} onChange={(v) => update(id, { cfg: v })} />
      <Text label={t("inspector.sampler")} value={data.sampler} placeholder={d("sampler")} onChange={(v) => update(id, { sampler: v })} />
      <Text label={t("inspector.scheduler")} value={data.scheduler} placeholder={d("scheduler")} onChange={(v) => update(id, { scheduler: v })} />
      <label className="field" title={t("inspector.breakHint")}>
        <span>{t("inspector.betweenCharacters")}</span>
        <select value={data.group_sep ?? "comma"} onChange={(e) => update(id, { group_sep: e.target.value as "comma" | "break" })}>
          <option value="comma">{t("inspector.sepComma")}</option>
          <option value="break">BREAK</option>
        </select>
      </label>
      <PromptOrder id={id} data={data} defaultOrder={profiles.find((p) => p.id === data.profile)?.order} />
      <h3>{t("inspector.replacePrompt")}</h3>
      <p className="muted">{t("inspector.replaceNote")}</p>
      <Text label={t("inspector.replacePositive")} multiline value={data.override_positive} onChange={(v) => update(id, { override_positive: v })} />
      <Text label={t("inspector.replaceNegative")} multiline value={data.override_negative} onChange={(v) => update(id, { override_negative: v })} />
      <h3>{t("inspector.output")}</h3>
      <Text
        label={t("inspector.outputPrefix")}
        value={data.output_prefix}
        placeholder={t("inspector.outputPrefixPlaceholder")}
        onChange={(v) => update(id, { output_prefix: v })}
      />
      <p className="muted">
        {t("inspector.outputNote")}
      </p>
      <Text
        label={t("inspector.outputDir")}
        value={data.output_dir}
        placeholder={t("inspector.outputDirPlaceholder")}
        onChange={(v) => update(id, { output_dir: v })}
      />
    </>
  );
}

function SceneFields() {
  const t = useT();
  const scenePrompt = useStore((s) => s.scenePrompt);
  const sceneNegative = useStore((s) => s.sceneNegative);
  const setScenePrompt = useStore((s) => s.setScenePrompt);
  const setSceneNegative = useStore((s) => s.setSceneNegative);
  return (
    <details open={!!(scenePrompt || sceneNegative)}>
      <summary>{t("inspector.scenePromptSummary")}</summary>
      <Text label={t("inspector.scenePrompt")} multiline value={scenePrompt} onChange={(v) => setScenePrompt(v ?? "")} />
      <Text label={t("inspector.sceneNegative")} multiline value={sceneNegative} onChange={(v) => setSceneNegative(v ?? "")} />
    </details>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button className="copy" onClick={() => void copy()} title={t("inspector.copyToClipboard")}>
      {done ? `✓ ${t("inspector.copied")}` : `⧉ ${label ?? t("inspector.copy")}`}
    </button>
  );
}

export function PromptBox({ text, negative }: { text: string; negative?: boolean }) {
  const t = useT();
  return (
    <div className="promptbox">
      <CopyButton text={text} label={negative ? t("inspector.copyNegative") : t("inspector.copyPositive")} />
      <pre className={negative ? "neg" : undefined}>{text}</pre>
    </div>
  );
}

export function PromptPreview() {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const toGraph = useStore((s) => s.toGraph);
  const library = useStore((s) => s.library);
  const scenePrompt = useStore((s) => s.scenePrompt);
  const sceneNegative = useStore((s) => s.sceneNegative);
  const [state, setState] = useState<{ positive?: string; negative?: string; error?: string }>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => {
      api
        .compile(toGraph())
        .then((r) => setState({ positive: r.positive, negative: r.negative }))
        .catch((e: Error) => setState({ error: e.message }));
    }, 400);
    return () => clearTimeout(handle);
  }, [nodes, edges, library, scenePrompt, sceneNegative, tick, toGraph]);

  return (
    <div className="preview">
      <h3>
        {t("inspector.promptPreview")}{" "}
        <button onClick={() => setTick(tick + 1)} title={t("inspector.rerollHint")}>
          🎲
        </button>
      </h3>
      {state.error ? (
        <pre className="error">{state.error}</pre>
      ) : (
        <>
          <PromptBox text={state.positive ?? ""} />
          {state.negative && <PromptBox text={state.negative} negative />}
        </>
      )}
    </div>
  );
}

const canOwn = (n: LbNode) =>
  n.type === "prompt"
    ? n.data.placement !== "prepend" && n.data.placement !== "append" && n.data.polarity !== "negative"
    : canBelong(n.type === "collection" ? n.data.category : n.type);

function sharedValue<T>(values: T[]): { mixed: boolean; value: T | undefined } {
  const first = values[0];
  return values.every((v) => v === first) ? { mixed: false, value: first } : { mixed: true, value: undefined };
}

function MultiFields({ nodes }: { nodes: LbNode[] }) {
  const t = useT();
  const update = useStore((s) => s.updateNodes);
  const removeNodes = useStore((s) => s.removeNodes);
  const characters = useStore((s) => s.nodes).filter(isCharacterNode);
  const ids = (list: LbNode[]) => list.map((n) => n.id);
  const ownable = nodes.filter(canOwn);
  const owner = sharedValue(ownable.map((n) => (characters.some((c) => c.id === n.data.owner) ? n.data.owner : "") ?? ""));
  const weighted = nodes.filter((n) => n.type !== "prompt");
  const emphasis = sharedValue(weighted.map((n) => n.data.emphasis ?? 1));
  const disabled = sharedValue(nodes.map((n) => !!n.data.disabled));
  const mixedOption = <option value="__mixed" disabled>— {t("inspector.mixed")} —</option>;
  return (
    <>
      <h2>
        {t("inspector.nodesSelected", { count: nodes.length })} <button onClick={() => removeNodes(ids(nodes))}>{t("inspector.delete")}</button>
      </h2>
      <p className="muted">{t("inspector.multiNote")}</p>
      <label className="field">
        <span>{t("inspector.state")} {disabled.mixed && <em className="mixed-badge">{t("inspector.mixed")}</em>}</span>
        <select value={disabled.mixed ? "__mixed" : disabled.value ? "off" : "on"} onChange={(e) => update(ids(nodes), { disabled: e.target.value === "off" })}>
          {disabled.mixed && mixedOption}
          <option value="on">{t("inspector.enabled")}</option>
          <option value="off">{t("inspector.disabledIgnored")}</option>
        </select>
      </label>
      {ownable.length > 0 && (
        <label className="field">
          <span>
            {t("inspector.belongsToCharacterN", { count: ownable.length })} {owner.mixed && <em className="mixed-badge">{t("inspector.mixed")}</em>}
          </span>
          <select value={owner.mixed ? "__mixed" : (owner.value ?? "")} onChange={(e) => update(ids(ownable), { owner: e.target.value || undefined })}>
            {owner.mixed && mixedOption}
            <option value="">(whole scene)</option>
            {characters.map((n) => (
              <option key={n.id} value={n.id}>
                {characterLabel(n)}
              </option>
            ))}
          </select>
        </label>
      )}
      {weighted.length > 0 && (
        <Num
          label={`${t("inspector.emphasisN", { count: weighted.length })}${emphasis.mixed ? ` — ${t("inspector.mixed")}` : ""}`}
          step={0.05}
          value={emphasis.mixed ? undefined : emphasis.value}
          placeholder={emphasis.mixed ? `— ${t("inspector.mixed")} —` : ""}
          onChange={(v) => update(ids(weighted), { emphasis: v ?? 1 })}
        />
      )}
    </>
  );
}

export function Inspector() {
  const t = useT();
  const selectedId = useStore((s) => s.selectedId);
  const node = useStore((s) => s.nodes.find((n) => n.id === selectedId));
  const picked = useStore((s) => s.nodes).filter((n) => n.selected && n.type !== "generate");
  const removeNode = useStore((s) => s.removeNode);
  return (
    <div className="inspector">
      {picked.length > 1 ? (
        <MultiFields nodes={picked} />
      ) : node ? (
        <>
          <h2>
            {t("inspector.nodeTitle", { type: node.type === "generate" || node.type === "collection" || node.type === "prompt" ? t(`nodes.type_${node.type}`) : (node.type ?? "") })}{" "}
            {node.type !== "generate" && <button onClick={() => removeNode(node.id)}>{t("inspector.delete")}</button>}
          </h2>
          {node.type === "generate" ? (
            <GenerateFields id={node.id} data={node.data} />
          ) : node.type === "prompt" ? (
            <PromptFields id={node.id} data={node.data} />
          ) : node.type === "collection" ? (
            <CollectionFields key={node.id} id={node.id} data={node.data} />
          ) : (
            <PresetFields key={node.id} id={node.id} category={node.type as Category} data={node.data} />
          )}
        </>
      ) : (
        <p className="muted">{t("inspector.selectNode")}</p>
      )}
      <SceneFields />
      <SceneHistory />
      <PromptPreview />
    </div>
  );
}
