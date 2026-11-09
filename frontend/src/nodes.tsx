import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";
import { api } from "./api";
import type { LbNode } from "./store";
import { categoryInfo, characterLabel, isCharacterNode, useStore } from "./store";
import { COLORS, HAIR_SWATCH, type Category, type Preset } from "./types";
import { hasTag, presetTitle, resolveTagText } from "./tags";
import { useTags } from "./useTags";
import { useT } from "./i18n/useT";

export { COLORS };

export const NEGATIVE_COLOR = "#8b1a1a";

export const promptColor = (data: { polarity?: string; category?: string }) =>
  data.polarity === "negative" ? NEGATIVE_COLOR : (COLORS[data.category ?? ""] ?? COLORS.prompt);

export function Thumb({ category, id, size = 64, lib }: { category: Category; id?: string; size?: number; lib?: string }) {
  const version = useStore((s) => s.thumbVersion);
  const profile = useStore((s) => s.nodes.find((n) => n.type === "generate")?.data.profile);
  const [failed, setFailed] = useState<string | null>(null);
  const src = id ? api.thumbnailUrl(category, id, profile, version, lib) : null;
  const style = { width: size, height: size };
  if (!src || failed === src) return <div className="thumb empty" style={style} />;
  return <img className="thumb" style={style} src={src} onError={() => setFailed(src)} alt="" draggable={false} />;
}

function OwnerBadge({ owner }: { owner?: string }) {
  const t = useT();
  const label = useStore((s) => {
    const n = owner ? s.nodes.find((x) => x.id === owner) : undefined;
    return n && isCharacterNode(n) ? characterLabel(n) : "";
  });
  return label ? (
    <div className="owner-badge" title={t("nodes.belongsToCharacter")}>
      ↳ {label}
    </div>
  ) : null;
}

function Frame({
  id,
  disabled,
  type,
  selected,
  children,
  color,
  title,
}: {
  id?: string;
  disabled?: boolean;
  type: string;
  selected?: boolean;
  children: React.ReactNode;
  color?: string;
  title?: string;
}) {
  const t = useT();
  const tint = color ?? COLORS[type];
  const update = useStore((s) => s.updateNode);
  return (
    <div className={`lb-node ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`} style={{ borderColor: tint }}>
      <div className="lb-node-title" style={{ background: tint, color: color === NEGATIVE_COLOR ? "#fff" : undefined }}>
        {title ?? (type === "generate" || type === "collection" || type === "prompt" ? t(`nodes.type_${type}`) : type)}
        {id && type !== "generate" && (
          <button
            className="node-toggle nodrag"
            title={disabled ? t("nodes.disabledHint") : t("nodes.enabledHint")}
            onClick={(e) => (e.stopPropagation(), update(id, { disabled: !disabled }))}
          >
            {disabled ? "○" : "●"}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function CategoryNode({ id, type, data, selected }: NodeProps<LbNode>) {
  const t = useT();
  const category = type as Category;
  const locale = useStore((s) => s.ui.locale);
  const names = useStore((s) => s.presets[category]?.find((p) => p.id === data.presetId)?.names) ?? data.names;
  return (
    <Frame id={id} disabled={data.disabled} type={category} selected={selected} title={categoryInfo(category).label}>
      <div className="lb-node-body">
        <Thumb category={category} id={data.presetId} lib={data.lib} />
        <div>
          <strong>{data.name ? presetTitle(data.name, names, locale) : t("nodes.unnamed")}</strong>
          <div className="muted clip">{data.keywords}</div>
          {categoryInfo(category).has_color && data.hair_color && (
            <div className="clip">
              <span style={{ color: HAIR_SWATCH[data.hair_color] }}>●</span> {data.hair_color}
            </div>
          )}
          <OwnerBadge owner={data.owner} />
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </Frame>
  );
}

export function CollectionNode({ id, data, selected }: NodeProps<LbNode>) {
  const t = useT();
  const category = (data.category ?? "costume") as Category;
  const presets: Preset[] = useStore((s) => s.presets[category]) ?? [];
  const labels = data.filter_labels ?? [];
  const ids = data.item_ids ?? [];
  const tags = useTags();
  const candidates = presets.filter(
    (p) => (!ids.length || ids.includes(p.id)) && labels.every((l) => hasTag(tags.idx, p.labels, resolveTagText(tags.idx, l))),
  );
  return (
    <Frame id={id} disabled={data.disabled} type="collection" selected={selected}>
      <div className="lb-node-body column">
        <div>
          <strong>{categoryInfo(category).label}</strong> {t("nodes.poolSummary", { mode: data.mode ?? "random", count: candidates.length })}
          {categoryInfo(category).has_color && data.hair_color && (
            <>
              {" "}
              · <span style={{ color: HAIR_SWATCH[data.hair_color] }}>●</span> {data.hair_color}
            </>
          )}
        </div>
        <div className="strip">
          {candidates.slice(0, 8).map((p) => (
            <div key={p.id} className={p.id === data.lastPick ? "picked" : ""} title={presetTitle(p.name, p.names, tags.locale)}>
              <Thumb category={category} id={p.id} size={40} />
            </div>
          ))}
        </div>
        {data.lastPick && <div className="muted">{t("nodes.lastPick", { name: ((p) => (p ? presetTitle(p.name, p.names, tags.locale) : data.lastPick))(presets.find((p) => p.id === data.lastPick)) })}</div>}
        <OwnerBadge owner={data.owner} />
      </div>
      <Handle type="source" position={Position.Right} />
    </Frame>
  );
}

export function GenerateNode({ data, selected }: NodeProps<LbNode>) {
  const t = useT();
  return (
    <Frame type="generate" selected={selected}>
      <div className="lb-node-body column">
        <div>
          {t("nodes.profile")} <strong>{data.profile}</strong>
        </div>
        <div className="muted">
          {t("nodes.batchSeed", { batch: data.batch ?? 1, seed: data.seed_locked ? String(data.seed) : t("nodes.random") })}
        </div>
      </div>
      <Handle type="target" position={Position.Left} />
    </Frame>
  );
}

export function PromptNode({ id, data, selected }: NodeProps<LbNode>) {
  const t = useT();
  const negative = data.polarity === "negative";
  const placement = data.placement ?? "inline";
  const slot = placement === "inline" ? (data.category || "end") : placement;
  return (
    <Frame id={id} disabled={data.disabled} type="prompt" selected={selected} color={promptColor(data)} title={`${negative ? t("nodes.negative") : t("nodes.prompt")} · ${slot}`}>
      <div className="lb-node-body column">
        <div className="prompt-text">{data.text || <span className="muted">{t("nodes.emptyPrompt")}</span>}</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </Frame>
  );
}