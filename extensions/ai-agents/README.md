# AI Agents

VS Codeのサイドバーから、CursorとCodexの公式SDKを利用して質問やコード変更を依頼する拡張機能です。

## 使い方

1. 作業対象のフォルダをVS Codeで開きます。
2. アクティビティバーの **AI Agents** を開きます。コマンドパレットの **AI Agents: Open Sidebar** でも開けます。
3. **Codex** または **Cursor** を選び、必要に応じてログインします。
4. 依頼を入力して送信します。Enterで送信、Shift+Enterで改行できます。

例: 「このリポジトリの構成を説明して」「READMEの誤字を修正して」

同じ会話への追加依頼、ツール実行状況の表示、**停止**、**新しい会話**に対応しています。複数フォルダを開いた場合は作業フォルダを選べます。エージェント・モデル・フォルダを切り替えると会話がリセットされます。

## 認証

### Codex

既存のCodex CLIの認証を使用できます。未認証の場合はサイドバーの **ログイン** から開くターミナルで `codex login` を実行します。このログイン操作にはCLIがPATH上に必要です。SDK自体にはCLIが同梱されているため、APIキー認証時にCLIの別途インストールは不要です。

APIキーで利用する場合は、サイドバーの **APIキー** または **AI Agents: Set Codex API Key** で設定します。環境変数 `CODEX_API_KEY` / `OPENAI_API_KEY` にも対応します。明示的なAPIキーがなければCodexの既存ログインを使用します。

### Cursor

サイドバーでCursorを選び、**ログイン** を押してブラウザで認証します。これはCursor SDK用のログインです。CursorエディタやCLIへのログインとは別で、エディタの認証情報は自動では引き継がれません。

APIキーを使う場合は **APIキー** または **AI Agents: Set Cursor API Key** で設定します。環境変数 `CURSOR_API_KEY` にも対応します。ユーザーまたはサービスアカウント用のAPIキーが必要です。

手入力したキーはVS CodeのSecretStorageに保存します。空欄を確定するとその保存済みキーを削除します。設定ファイルやWebviewにはキーを渡しません。CursorのブラウザログインはSDK標準の `~/.cursor/sdk/auth.json` に認証情報を保存します。

## 設定

| 設定 | 既定値 | 用途 |
| --- | --- | --- |
| `ai-agents.defaultProvider` | `codex` | 起動時のエージェント |
| `ai-agents.codex.model` | 空欄 | CodexのモデルID。空欄で既存のCodex設定を利用 |
| `ai-agents.cursor.model` | `auto` | CursorのモデルID |
| `ai-agents.codex.executablePath` | 空欄 | CLIを指定する場合の絶対パス。通常はSDK同梱CLIを利用 |

モデルはサイドバーからも変更できます。設定値の変更は新しく開くサイドバーに反映します。

## 実行について

SDKは選択したフォルダを作業ディレクトリとして、ファイルの読み書きとコマンド実行を行います。信頼済みのファイルシステム上のワークスペースが必要です。VS Code Webには対応していません。Remote SSH等では拡張機能ホスト側で実行するため、その環境での認証とSDK実行条件が必要です。

Codexは `workspace-write` / `approvalPolicy: never`、Cursorは `local.sandboxOptions.enabled: true` で実行します。SDKのサンドボックスで許可されない操作は拒否されます。追加承認のUIはまだありません。Cursorが追加入力を要求した場合は実行を停止して案内を表示します。

会話は現在の拡張機能ホスト内で継続します。サイドバーを隠しても継続し、ウィンドウをリロードすると新しい会話になります。SDK側には履歴が保存されますが、この版には過去の会話を開き直すUIはありません。CursorのSDK履歴は拡張機能のglobalStorage配下、Codexの履歴はCodex標準の保存先に置かれます。

## VSIXの作成・インストール

リポジトリのルートで `npm run package` を実行すると、`extensions/ai-agents/dist/ai-agents-0.1.0-<OS>-<CPU>.vsix` が生成されます。VS Codeの **Extensions: Install from VSIX...** でインストールできます。

SDKにはOS/CPU別のネイティブバイナリが含まれるため、VSIXは作成した環境向けです。SDKの動的ロードを壊さないように依存パッケージを同梱し、npm workspacesのhoistingに影響されない一時ディレクトリでパッケージ化します。

## 公式SDKを確認した結果

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): `@cursor/sdk`。`Agent.create({ local: { cwd } })`、`agent.send()`、`run.stream()`、`run.cancel()` でローカルエージェントを制御。Node.js 22.13以降が必要。VS Code内でのSQLite依存を避けるため `JsonlLocalAgentStore` を使用。
- [Codex SDK](https://developers.openai.com/codex/sdk/): `@openai/codex-sdk`。ローカルCLIをラップし、`startThread()`、`runStreamed()`、`AbortSignal` で会話と停止を制御。モデルは固定せず、既存のCodex設定を利用可能。
- [Codex認証](https://developers.openai.com/codex/auth/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

利用バージョン: `@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`。
