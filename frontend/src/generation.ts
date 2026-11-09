import { create } from "zustand";
import { api } from "./api";
import { useStore } from "./store";

interface GenState {
  busy: boolean;
  error: string;
}

export const useGeneration = create<GenState>(() => ({ busy: false, error: "" }));

export async function runGenerate(): Promise<void> {
  const { toGraph, refreshRuns, updateNode, activeId } = useStore.getState();
  useGeneration.setState({ busy: true, error: "" });
  try {
    const runs = await api.generate(toGraph(), activeId);
    const queued = runs.find((r) => r.status !== "error") ?? runs[0];
    if (queued.error) useGeneration.setState({ error: queued.error });
    const snapshot = await api.snapshot(runs[0].id);
    for (const pick of snapshot.picks) updateNode(pick.node_id, { lastPick: pick.item_id });
    await refreshRuns();
  } catch (e) {
    useGeneration.setState({ error: (e as Error).message });
  } finally {
    useGeneration.setState({ busy: false });
  }
}

export async function cancelAll(): Promise<void> {
  try {
    await api.cancelAll();
    await useStore.getState().refreshRuns();
  } catch (e) {
    useGeneration.setState({ error: (e as Error).message });
  }
}
