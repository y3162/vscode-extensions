# AI Agents

VS Code のサイドバーから Codex CLI と Cursor CLI を使い、質問やコード変更を依頼できます。信頼済みのローカルファイルシステム上のワークスペースが必要です。VS Code Web には対応していません。

## 使い方

1. 作業するフォルダーを開き、アクティビティバーの **AI Agents** を開きます。
2. Home で Codex または Cursor を選び、チャットを開始します。
3. モデルと利用可能なモードを選択し、依頼を送信します。実行中に入力した依頼はキューに入ります。停止してもキューは残ります。
4. 歯車メニューからサンドボックス、ログイン、API キー、診断などにアクセスできます。

会話の各ターンは Codex の `codex exec --json` または Cursor の `agent --print` で実行します。実行方式を選択する必要はありません。Codex のモデル一覧および CLI ターンの履歴照合・分岐には、同梱 CLI の App Server を補助的に使用します。

## 認証とモデル

Codex は同梱 CLI または `ai-agents.codex.executablePath` で指定した CLI を使用します。既存の Codex ログイン、保存した API キー、または `CODEX_API_KEY` / `OPENAI_API_KEY` を使用できます。

Cursor はインストール済みの `agent` コマンドを使用します。詳細設定の **ログイン** から CLI のログインを実行するか、保存した API キーまたは `CURSOR_API_KEY` を使用してください。コマンドの場所は `ai-agents.cursor.agentPath` で変更できます。

API キーは VS Code の SecretStorage に保存されます。空欄を確定すると保存済みキーを削除します。Codex のモデル一覧は App Server の `model/list`、Cursor のモデル一覧は CLI の `--list-models` から取得します。実際の利用可否はアカウントの設定に依存します。モデルや対応する詳細設定の変更は次の送信に反映されます。

## 設定

| 設定 | 既定値 | 用途 |
| --- | --- | --- |
| `ai-agents.defaultProvider` | `codex` | 起動時のエージェント |
| `ai-agents.codex.model` | 空欄 | Codex のモデル ID。空欄は Codex の既存設定を利用 |
| `ai-agents.cursor.model` | `auto` | Cursor のモデル ID |
| `ai-agents.codex.executablePath` | 空欄 | Codex CLI の絶対パス。空欄は同梱 CLI を利用 |
| `ai-agents.cursor.agentPath` | `agent` | Cursor CLI の起動コマンド |
| `ai-agents.history.enabled` | `true` | ローカル表示履歴の保存 |
| `ai-agents.maxBackgroundSessions` | `3` | 同時実行できる会話数 |
| `ai-agents.autoApprove` | `false` | 対応する操作の自動承認 |

Codex CLI の対話承認は利用できません。Cursor CLI の print モードは画像添付と使用量の報告に対応していません。サンドボックスや追加ディレクトリは詳細設定で変更できます。

## 履歴と変更

表示履歴はワークスペースごとにローカル保存され、会話本文やツール出力を含むことがあります。`AI Agents: Delete Local Display History` で削除できます。CLI の会話そのものは削除されません。CLI で作成されたことを確認できない旧履歴は誤った方式で再開せず、元のファイルを保持します。

Codex の送信済みプロンプトは、App Server でターン履歴と分岐を確認できる場合に編集・再送できます。変更ファイルの復元は、保存済みチェックポイントと現在の内容を確認できる場合に限ります。Cursor CLI はターン指定の巻き戻しに対応していません。

## 開発と配布

リポジトリのルートで `npm run check`、`npm test`、`npm run test:coverage`、`npm run test:hygiene` を実行します。`npm run test:integration` は VS Code が必要です。ライブテストは認証が必要で利用枠を消費する場合があります。

`npm run package` で実行環境向けの VSIX を `dist` に生成します。導入・更新については [INSTALL.md](INSTALL.md) を参照してください。過去の検証記録は当時の実装に対するもので、現在の CLI 経路の受入を保証しません。
