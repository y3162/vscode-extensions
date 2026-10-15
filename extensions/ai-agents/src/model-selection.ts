import type { AgentModel, Selection } from './types.js';

export function matchesModel(model: AgentModel, selectedId: string): boolean {
  return model.id === selectedId || Boolean(model.aliases?.includes(selectedId));
}

export function selectBaseModel(model: AgentModel, current: Selection): Selection {
  const sameModel = matchesModel(model, current.model);
  const params = sameModel ? current.modelParams : model.defaultParams;
  return {
    provider: current.provider, cwd: current.cwd,
    model: sameModel ? current.model : model.id,
    ...(params?.length ? { modelParams: params } : {}),
  };
}

// v0.2.0 stored labels such as "Model — High 1M"; keep the settings, show its base name.
export function baseModelLabel(label: string): string {
  return label.split(' — ')[0] || label;
}
