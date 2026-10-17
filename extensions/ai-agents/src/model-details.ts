import * as vscode from 'vscode';
import { ModelSettingsDraft, type ModelParams } from './model-settings.js';
import type { AgentModel, ModelParameter, Selection } from './types.js';

interface DetailItem extends vscode.QuickPickItem {
  id: string;
  action: 'parameter' | 'value' | 'apply' | 'reset';
  parameter?: ModelParameter;
  value?: string;
}

export class ModelDetails implements vscode.Disposable {
  private readonly picker = vscode.window.createQuickPick<DetailItem>();
  private activeItem?: string;
  private draft?: ModelSettingsDraft;

  isReady(id?: string): boolean {
    return !this.picker.busy && this.activeItem !== undefined && (id === undefined || id === this.activeItem);
  }

  show(): void { this.picker.show(); }
  hide(): void { this.picker.hide(); }

  async edit(selection: Selection, load: () => Promise<AgentModel | undefined>): Promise<ModelParams | undefined> {
    const picker = this.picker;
    picker.title = 'モデルの詳細設定';
    picker.placeholder = '設定項目を取得中…';
    picker.busy = true;
    const subscriptions: vscode.Disposable[] = [];
    const parameterLabel = (parameter: ModelParameter) => {
      const value = this.draft?.value(parameter.id);
      return value === undefined ? '既定の設定' : parameter.values.find((item) => item.value === value)?.label ?? value;
    };
    const showParameters = () => {
      if (!this.draft) return;
      picker.title = `${this.draft.model.label} の詳細設定`;
      picker.placeholder = '設定項目を選択し、最後に「適用」で反映';
      picker.buttons = [];
      picker.value = '';
      picker.items = [
        ...this.draft.model.parameters!.filter((parameter) => parameter.values.length).map((parameter): DetailItem => ({
          id: `parameter:${parameter.id}`, action: 'parameter', parameter,
          label: parameter.label, description: parameterLabel(parameter),
        })),
        { id: 'apply', action: 'apply', label: '$(check) 適用', detail: '変更がある場合は新しい会話に反映します' },
        { id: 'reset', action: 'reset', label: '$(discard) 既定値に戻す', detail: '変更後に「適用」を選択してください' },
      ];
      picker.activeItems = picker.items.slice(0, 1);
    };
    const showValues = (parameter: ModelParameter) => {
      picker.title = `${this.draft!.model.label} — ${parameter.label}`;
      picker.placeholder = '設定値を選択';
      picker.buttons = [vscode.QuickInputButtons.Back];
      picker.value = '';
      picker.items = [
        { id: `default:${parameter.id}`, action: 'value', parameter, label: '既定の設定を使用' },
        ...parameter.values.map((value): DetailItem => ({
          id: `value:${parameter.id}:${value.value}`, action: 'value', parameter, value: value.value,
          label: value.label, detail: value.description,
        })),
      ];
      picker.activeItems = [picker.items.find((item) => item.value === this.draft?.value(parameter.id)) ?? picker.items[0]!];
    };
    try {
      return await new Promise<ModelParams | undefined>((resolve, reject) => {
        let hidden = false;
        subscriptions.push(
          picker.onDidChangeActive((items) => { this.activeItem = items[0]?.id; }),
          picker.onDidHide(() => { hidden = true; resolve(undefined); }),
          picker.onDidTriggerButton(() => showParameters()),
          picker.onDidAccept(() => {
            if (picker.busy || !this.draft) return;
            const item = picker.selectedItems[0];
            if (!item) return;
            switch (item.action) {
              case 'parameter': showValues(item.parameter!); break;
              case 'value': this.draft.set(item.parameter!, item.value); showParameters(); break;
              case 'reset': this.draft.reset(); showParameters(); break;
              case 'apply': resolve(this.draft.params()); break;
            }
          }),
        );
        picker.show();
        void load().then((model) => {
          if (hidden) return;
          if (!model) throw new Error('モデル一覧から、詳細設定を変更するモデルを選択してください。');
          if (!model.parameters?.some((parameter) => parameter.values.length)) {
            void vscode.window.showInformationMessage(`${model.label} には変更できる詳細設定がありません。`);
            resolve(undefined);
            return;
          }
          this.draft = new ModelSettingsDraft(model, selection.provider, selection.modelParams);
          showParameters();
          picker.busy = false;
        }).catch((error: unknown) => { if (!hidden) reject(error); });
      });
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      this.dispose();
    }
  }

  dispose(): void { this.picker.hide(); this.picker.dispose(); }
}
