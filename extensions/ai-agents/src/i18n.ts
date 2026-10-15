export type Locale = 'ja' | 'en';

const text = {
  'error.signInCursor': ['Cursor SDKに未ログインです。サイドバーの「ログイン」または「APIキー」から認証してください。', 'Sign in to the Cursor SDK from the sidebar, or set an API key.'],
  'error.node': ['Cursor SDKにはNode.js 22.13以降が必要です。VS Codeを更新してください。', 'The Cursor SDK requires Node.js 22.13 or newer. Update VS Code.'],
  'error.trust': ['このフォルダを信頼してから実行してください。', 'Trust this folder before running an agent.'],
  'error.noFolder': ['作業対象のフォルダをVS Codeで開いてください。', 'Open a workspace folder in VS Code first.'],
  'error.folderMissing': ['作業対象のフォルダが見つかりません。', 'The selected workspace folder could not be found.'],
  'error.badSelection': ['エージェント設定が不正です。', 'The agent settings are invalid.'],
  'error.promptLength': ['依頼は100,000文字以内で入力してください。', 'Enter a prompt of at most 100,000 characters.'],
  'error.busyModel': ['実行が終わってからモデルを選択してください。', 'Wait for the current run to finish before choosing a model.'],
  'error.busyDetails': ['実行が終わってから詳細設定を変更してください。', 'Wait for the current run to finish before changing model details.'],
  'error.modelList': ['モデル一覧を取得できませんでした: {0}', 'Could not load the model list: {0}'],
  'error.switchBackend': ['この承認ポリシーは対話操作が必要です。バックエンドを Codex App Server に切り替えてください。', 'This approval policy needs interactive prompts. Switch the Codex backend to App Server.'],
  'error.steer': ['このバックエンドは実行中の追加入力に対応していません。', 'This backend cannot steer a running turn.'],
  'error.outside': ['ワークスペース外のファイルは変更できません。', 'Refusing to change a file outside the workspace.'],
  'error.noBaseline': ['変更前の内容が無いため、このファイルは復元できません。', 'This file cannot be restored because its previous contents were not captured.'],
  'error.image': ['画像は PNG / JPEG / GIF / WebP を4枚まで、1枚5MB以下にしてください。', 'Attach up to 4 PNG, JPEG, GIF, or WebP images, each at most 5 MB.'],
  'error.agentLaunch': ['Cursor CLI を起動できません。ACP を使う場合は agent コマンドのパスを確認してください。', 'Could not start the Cursor CLI. Check the agent path used for ACP.'],
  'error.codexLaunch': ['Codex App Server を起動できません。', 'Could not start the Codex app server.'],
  'error.compact': ['このバックエンドはコンテキスト圧縮に対応していません。', 'This backend cannot compact the conversation.'],
  'error.fork': ['このバックエンドは会話の分岐に対応していません。', 'This backend cannot fork the conversation.'],
  'error.review': ['コードレビューAPIは Codex App Server でのみ使えます。差分を添付して依頼してください。', 'The review API is only available with the Codex app server. Attach the git diff instead.'],
  'status.cancelled': ['停止しました。', 'Stopped.'],
  'status.stopping': ['停止中…', 'Stopping…'],
  'status.restored': ['セッションを再開しました。', 'Session restored.'],
  'status.noTranscript': ['セッションは再開しましたが、このバックエンドは表示用の履歴を返しません。続きを入力できます。', 'The session was resumed, but this backend did not return a display transcript. You can continue the conversation.'],
  'status.controls': ['設定を変更したため、新しい会話になりました。', 'Started a new conversation because the execution settings changed.'],
  'status.autoApprove': ['自動承認を有効にしました。サンドボックスの強制とは別です。危険な操作も確認なしで許可されます。', 'Auto-approve is on. This is not the same as a sandbox; risky actions are allowed without a prompt.'],
  'confirm.autoApprove': ['自動承認を有効にしますか？ファイル変更とコマンド実行の確認を省略します。サンドボックスが無効になるという意味ではありません。', 'Enable auto-approve? File changes and command execution will be allowed without a prompt. This does not disable the sandbox.'],
  'confirm.enable': ['有効にする', 'Enable'],
  'model.default': ['既定のモデル', 'Default model'],
  'model.defaultDetail': ['エージェントの既定設定を使用', 'Use the agent default'],
  'model.search': ['モデルを検索して選択', 'Search and select a model'],
  'model.empty': ['モデルが見つかりません。再取得または既定のモデルを選択', 'No models found. Refresh or use the default model.'],
  'model.loading': ['モデル一覧を取得中…', 'Loading models…'],
  'model.failed': ['取得に失敗しました。右上の再取得ボタンで再試行できます', 'Loading failed. Use the refresh button to try again.'],
  'model.recommended': ['推奨', 'Recommended'],
  'model.pickerTitle': ['{0} のモデルを選択', 'Select a {0} model'],
  'model.refresh': ['モデル一覧を再取得', 'Refresh model list'],
  'cursor.followUp': ['追加入力が必要なため停止しました。依頼を具体的にして再送してください。', 'Stopped because the run requested more input. Make the request more specific and send it again.'],
  'cursor.failed': ['Cursorの実行に失敗しました。', 'The Cursor run failed.'],
  'codex.exit': ['Codexのモデル一覧取得プロセスが終了しました ({0})。', 'The Codex model-list process exited ({0}).'],
  'codex.badResponse': ['Codexからのモデル一覧の応答が不正です。', 'The Codex model list response was invalid.'],
  'codex.badList': ['Codexのモデル一覧が不正です。', 'The Codex model list was invalid.'],
  'codex.loop': ['Codexのモデル一覧のページ取得が循環しています。', 'Codex model-list pagination looped.'],
  'diag.ok': ['診断が完了しました。', 'Diagnostics finished.'],
  'usage.unavailable': ['このバックエンドは使用量APIを公開していません。ターンごとのトークンは実行後に表示できる場合があります。', 'This backend does not expose a usage API. Per-turn tokens may still appear after a run.'],
  'terminal.unavailable': ['VS Codeはターミナルの画面出力を拡張機能へ渡さないため、シェル統合で観測できた最近のコマンドだけを添付します。', 'VS Code does not expose the terminal scrollback to extensions. Only recent commands observed through shell integration are attached.'],
} as const;

export type TextKey = keyof typeof text;

export function localeFrom(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function translate(locale: Locale, key: TextKey, ...values: string[]): string {
  const template = text[key][locale === 'ja' ? 0 : 1];
  return values.reduce((message, value, index) => message.replace(`{${index}}`, value), template);
}
