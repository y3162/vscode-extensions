import type { AgentModel, ModelParameter, Selection } from './types.js';

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
