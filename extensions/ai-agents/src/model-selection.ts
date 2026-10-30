import { reconcileModelParams } from './model-settings.js';
import type { AgentModel, Selection } from './types.js';

export function matchesModel(model: AgentModel, selectedId: string): boolean {
  return model.id === selectedId || Boolean(model.aliases?.includes(selectedId));
}

// A CLI list that contains only IDs does not describe which overrides it accepts.
// Fail closed without changing the stored selection when metadata is unavailable.
export function validateCursorParams(selection: Selection, models: AgentModel[]): void {
  if (!selection.modelParams?.length) return;
  const model = models.find((item) => matchesModel(item, selection.model));
  if (!model) throw new Error(`Cursor CLI のモデル一覧に ${selection.model} がありません。設定は保持されています。`);
  if (!model.parameters) throw new Error(`Cursor CLI のモデル一覧に ${selection.model} のパラメータ定義がなく、保存済み設定を検証できません。設定は保持されています。同じモデルを再選択すると、確認後にパラメータを消去して既定値で使用できます。`);
  for (const param of selection.modelParams) {
    const definition = model.parameters.find((item) => item.id === param.id);
    if (!definition || !definition.values.some((value) => value.value === param.value)) {
      throw new Error(`Cursor CLI のモデル ${selection.model} の保存済みパラメータ ${param.id}=${param.value} は現在の一覧では無効です。設定を確認してください。`);
    }
  }
}

export function selectBaseModel(model: AgentModel, current: Selection): Selection {
  const sameModel = matchesModel(model, current.model);
  const params = sameModel ? current.modelParams : reconcileModelParams(model, current.modelParams, current.provider);
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
