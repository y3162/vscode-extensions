import type { AgentModel, ModelParameter, ModelParameterPresentation, ModelParameterRole, Provider, Selection } from './types.js';

export type ModelParams = NonNullable<Selection['modelParams']>;

export function sameModelParams(left: Selection['modelParams'], right: Selection['modelParams']): boolean {
  const key = (params: Selection['modelParams']) => JSON.stringify([...(params ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  return key(left) === key(right);
}

export class ModelSettingsDraft {
  private readonly values = new Map<string, string>();

  constructor(readonly model: AgentModel, private readonly provider: Selection['provider'], params?: ModelParams) {
    this.reset();
    for (const param of params ?? []) {
      if (model.parameters?.some((definition) => definition.id === param.id
        && definition.values.some((value) => value.value === param.value))) this.values.set(param.id, param.value);
    }
  }

  reset(): void {
    this.values.clear();
    if (this.provider === 'cursor') {
      for (const param of this.model.defaultParams ?? []) this.values.set(param.id, param.value);
    }
  }

  value(id: string): string | undefined { return this.values.get(id); }

  set(parameter: ModelParameter, value: string | undefined): void {
    if (value === undefined) {
      const defaultValue = this.provider === 'cursor'
        ? this.model.defaultParams?.find((param) => param.id === parameter.id)?.value ?? parameter.defaultValue
        : undefined;
      if (defaultValue === undefined) this.values.delete(parameter.id);
      else this.values.set(parameter.id, defaultValue);
      return;
    }
    if (!parameter.values.some((item) => item.value === value)) throw new Error('このモデルでは選択できない設定値です。');
    this.values.set(parameter.id, value);
  }

  params(): ModelParams { return [...this.values].map(([id, value]) => ({ id, value })); }
}

const effortLabels: Record<string, string> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra High', max: 'Max', ultra: 'Ultra', persistent: 'Persistent',
};
const offValues = new Set(['false', 'off', '0', 'no']);
const onValues = new Set(['true', 'on', '1', 'yes']);

export function parameterRole(id: string): ModelParameterRole {
  if (id === 'effort' || id === 'modelReasoningEffort' || id === 'reasoning' || id === 'reasoning_effort') return 'effort';
  if (id === 'context' || id === 'context_size') return 'context';
  if (id === 'fast') return 'fast';
  return 'other';
}

export function displayValueLabel(value: string, label?: string): string {
  if (label && label !== value) return label;
  return formatToken(value);
}

export function formatToken(value: string): string {
  const effort = effortLabels[value];
  if (effort) return effort;
  const size = /^(\d+(?:\.\d+)?)([km])$/i.exec(value);
  if (size?.[1] && size[2]) return `${size[1]}${size[2].toUpperCase()}`;
  return value;
}

export function parameterPresentation(parameter: { id: string; role?: ModelParameterRole; values: { value: string }[] }): ModelParameterPresentation | 'hidden' {
  if (!parameter.values.length) return 'hidden';
  const role = parameter.role ?? parameterRole(parameter.id);
  if (role === 'fast' && parameter.values.length === 2) {
    const values = parameter.values.map((item) => item.value.toLowerCase());
    if (values.every((value) => offValues.has(value) || onValues.has(value))
      && values.some((value) => offValues.has(value)) && values.some((value) => onValues.has(value))) return 'toggle';
  }
  return parameter.values.length >= 2 ? 'menu' : 'hidden';
}

export function annotateParameter(parameter: ModelParameter): ModelParameter | undefined {
  const role = parameter.role ?? parameterRole(parameter.id);
  const values = parameter.values.map((value) => ({ ...value, label: displayValueLabel(value.value, value.label) }));
  const presentation = parameterPresentation({ id: parameter.id, role, values });
  if (presentation === 'hidden') return undefined;
  return { ...parameter, role, presentation, values, label: parameterTitle(parameter.id, parameter.label) };
}

function parameterTitle(id: string, label: string): string {
  if (label && label !== id) return label;
  const role = parameterRole(id);
  if (role === 'effort') return 'Effort';
  if (role === 'context') return 'Context';
  if (role === 'fast') return 'Fast';
  return label || id;
}

const parameterRank: Record<ModelParameterRole, number> = { fast: 0, context: 1, effort: 2, other: 3 };

export function orderedParameters(parameters: ModelParameter[] | undefined): ModelParameter[] {
  return (parameters ?? []).flatMap((parameter) => {
    const annotated = parameter.presentation ? parameter : annotateParameter(parameter);
    return annotated ? [annotated] : [];
  }).sort((left, right) => {
    const toggle = Number(left.presentation !== 'toggle') - Number(right.presentation !== 'toggle');
    return toggle || parameterRank[left.role ?? 'other'] - parameterRank[right.role ?? 'other'];
  });
}

export function isToggleOn(value: string | undefined): boolean {
  return Boolean(value && onValues.has(value.toLowerCase()));
}

export function toggleOnValue(values: { value: string }[]): string | undefined {
  return values.find((item) => onValues.has(item.value.toLowerCase()))?.value;
}

export function filterModels<T extends { id: string; label: string; aliases?: string[]; description?: string }>(models: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => [model.label, model.id, model.description, ...(model.aliases ?? [])]
    .some((field) => field?.toLowerCase().includes(needle)));
}

export function catalogIsCurrent(
  expected: { requestId: number; provider: string; cwd: string },
  incoming: { requestId: number; provider: string; cwd: string },
): boolean {
  return expected.requestId === incoming.requestId && expected.provider === incoming.provider && expected.cwd === incoming.cwd;
}

export function toCatalogModel(model: AgentModel): {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  parameters: ModelParameter[];
} {
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.aliases?.length ? { aliases: model.aliases } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    parameters: orderedParameters(model.parameters),
  };
}

export function reconcileModelParams(model: AgentModel, current: Selection['modelParams'], provider: Provider): Selection['modelParams'] {
  if (!model.id) return undefined;
  const definitions = orderedParameters(model.parameters);
  if (!definitions.length) return model.defaultParams?.length ? model.defaultParams.map((param) => ({ ...param })) : undefined;
  const kept = new Map<string, string>();
  for (const param of current ?? []) {
    const definition = definitions.find((item) => item.id === param.id);
    if (definition?.values.some((item) => item.value === param.value)) kept.set(param.id, param.value);
  }
  for (const definition of definitions) {
    if (kept.has(definition.id)) continue;
    const hadInvalid = (current ?? []).some((param) => param.id === definition.id);
    const fallback = model.defaultParams?.find((param) => param.id === definition.id)?.value ?? definition.defaultValue;
    const fallbackOk = fallback !== undefined && definition.values.some((item) => item.value === fallback);
    if (!fallbackOk || fallback === undefined) continue;
    if (provider === 'cursor' || hadInvalid) kept.set(definition.id, fallback);
  }
  const params = [...kept].map(([id, value]) => ({ id, value }));
  params.sort((left, right) => parameterRank[parameterRole(left.id)] - parameterRank[parameterRole(right.id)] || left.id.localeCompare(right.id));
  return params.length ? params : undefined;
}
