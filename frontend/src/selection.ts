export interface SelectionState {
  selected: Set<string>;
  anchor: string | null;
}

export interface ClickOptions {
  ctrl: boolean;
  shift: boolean;
  /** selection mode: a plain click toggles instead of opening */
  toggleMode: boolean;
}

/** Explorer-style selection. Returns null when the click should not change the selection (plain click, not in selection mode). */
export function applyClick(state: SelectionState, ids: string[], clicked: string, options: ClickOptions): SelectionState | null {
  const { selected, anchor } = state;
  if (options.shift && anchor && ids.includes(anchor)) {
    const [from, to] = [ids.indexOf(anchor), ids.indexOf(clicked)].sort((a, b) => a - b);
    const range = ids.slice(from, to + 1);
    // ctrl+shift adds the range to the current selection; plain shift replaces it
    const next = options.ctrl ? new Set([...selected, ...range]) : new Set(range);
    return { selected: next, anchor };
  }
  if (options.ctrl || options.toggleMode || options.shift) {
    const next = new Set(selected);
    if (!next.delete(clicked)) next.add(clicked);
    return { selected: next, anchor: clicked };
  }
  return null;
}

export const selectAll = (ids: string[]): SelectionState => ({ selected: new Set(ids), anchor: ids[0] ?? null });

/** Drop ids that no longer exist (e.g. after deletion or a refresh). */
export function prune(state: SelectionState, ids: string[]): SelectionState {
  const valid = new Set(ids);
  const selected = new Set([...state.selected].filter((id) => valid.has(id)));
  if (selected.size === state.selected.size) return state;
  return { selected, anchor: state.anchor && valid.has(state.anchor) ? state.anchor : null };
}
