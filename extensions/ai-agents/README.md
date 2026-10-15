# AI Agents

VS Codeのサイドバーから、CursorとCodexの公式SDKを利用して質問やコード変更を依頼する拡張機能です。

## 使い方

1. 作業対象のフォルダをVS Codeで開きます。
2. アクティビティバーまたはセカンダリサイドバーの **AI Agents** を開きます。コマンドパレットの **AI Agents: Open Sidebar** でも開けます。
3. **Codex** または **Cursor** を選び、必要に応じてログインします。
4. **バックエンド** は既定で公式SDKです。対話型の承認や Codex のレビューには、Codex は **App Server**、Cursor は **ACP** を選びます。
5. **モデル** のボタンを押すと、取得したモデル一覧から検索・選択できます。
6. 依頼を入力して送信します。Enterで送信、Shift+Enterで改行できます。実行中は追加入力がキューに入り、停止してもキューは残ります。

例: 「このリポジトリの構成を説明して」「READMEの誤字を修正して」

同じ会話への追加依頼、ツール実行状況の表示、**停止**、**新しい会話**に対応しています。複数フォルダを開いた場合は作業フォルダを選べます。エージェント・モデル・フォルダを切り替えると会話がリセットされます。

## モデル選択

サイドバーの **モデル** を押すか、コマンドパレットの **AI Agents: Select Model** を実行すると、VS Codeの検索できるモデル選択画面が開きます。モデルIDの手入力は不要です。

- Codexは同梱CLIのApp Server `model/list`、Cursorは公式SDKの `Cursor.models.list()` から、選択画面を開くたびに一覧を取得します。
- モデル本体ごとに1項目表示します。Effort・Context size・Fast・Thinkingなどの設定の組み合わせは、モデル一覧の項目を増やしません。
- Cursorの一覧取得にはSDKログインまたはAPIキーが必要です。設定項目・候補値・既定値・プリセットはモデル本体と分けて保持します。
- 右上の再取得ボタンで一覧を更新できます。取得に失敗した場合も再試行できます。
- **既定のモデル** を選ぶと、Codexは既存のCodex設定、CursorはAutoを使用します。
- 選択したモデルはワークスペースごと・エージェントごとに保存され、再読み込み後も復元されます。Escで閉じた場合は選択や会話を変更しません。
- 同じモデルを選び直しても、保存済みの詳細値や会話を維持します。別のモデルへ変更した場合は新しいモデルの既定値を使います。

モデル一覧は各プロバイダーが返すカタログです。アカウントやチームの設定によって内容が異なり、一覧への掲載だけで実際の推論リクエストの利用権限を保証するものではありません。

## 詳細設定の変更

1. **モデル** から使うモデルを選択します。
2. モデル欄の右側の **詳細設定** を押します。コマンドパレットの **AI Agents: Configure Model Details** でも開けます。
3. **Effort** や **Context** などの設定項目を選び、一覧から値を選択します。左上の戻るボタンで項目一覧に戻れます。
4. 設定が終わったら **適用** を選択します。

モデルが対応している設定項目・値だけを表示します。Codexはモデル一覧が返すEffort、CursorはモデルごとのEffort・Context size・Fast・Thinking等を設定できます。SDKから変更項目が返らないモデルでは、その旨を表示します。

**既定値に戻す** で設定を戻してから **適用** することもできます。Codexの「既定」は既存のCodex設定を使用し、Cursorの「既定」はSDKが返すモデルの既定値を使用します。

変更は **適用** するまで保存されません。Escで閉じると編集を破棄し、設定と会話を維持します。設定値を変更して適用した場合は新しい会話になり、次の依頼からSDKに反映します。選択値は再読み込み後も復元します。

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
| `ai-agents.codex.backend` | `sdk` | `sdk` または `app-server` |
| `ai-agents.cursor.backend` | `sdk` | `sdk` または `acp` |
| `ai-agents.cursor.agentPath` | `agent` | ACPで起動するCursor CLI |
| `ai-agents.autoApprove` | `false` | ツール承認を省略する。サンドボックスは無効にしない |

モデルは通常、サイドバーの選択画面から変更してください。上記モデル設定は、まだモデルを選択していない場合の初期値です。選択画面で保存したモデルを優先します。

## 実行について

SDKは選択したフォルダを作業ディレクトリとして、ファイルの読み書きとコマンド実行を行います。信頼済みのファイルシステム上のワークスペースが必要です。VS Code Webには対応していません。Remote SSH等では拡張機能ホスト側で実行するため、その環境での認証とSDK実行条件が必要です。

既定では Codex は `workspace-write` / `approvalPolicy: never`、Cursor は `local.sandboxOptions.enabled: true` です。サイドバーからサンドボックスと、プロトコルが対応する承認ポリシーを変更できます。SDKの `codex exec` は対話承認を受け取れないため、承認が必要なポリシーは App Server を選びます。Cursor SDKでサンドボックスが拒否した操作は、確認ダイアログにはなりません。ACPを選ぶと `session/request_permission` をチャット内で承認・拒否できます。

自動承認は既定でオフです。有効化には確認が必要で、サンドボックスを切ることとは別です。

`@` でワークスペース内のファイルやフォルダ、`/` でコマンドやスキルを参照できます。画像の貼り付け、選択範囲、Problems、Git差分、シェル統合で見えた最近のコマンドも添付できます。変更ファイルは VS Code の Diff Editor で開き、変更前の内容を保持しているものはワークスペース内に限って復元できます。

会話は現在の拡張機能ホスト内で継続します。サイドバーを隠しても継続し、ウィンドウをリロードすると新しい会話になります。履歴ボタンから、SDK・ACP・App Server が返すセッションを開き直せます。CursorのSDK履歴は拡張機能のglobalStorage配下、Codexの履歴はCodex標準の保存先に置かれます。

設計と機能差分は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md)、[docs/GAP_ANALYSIS.md](docs/GAP_ANALYSIS.md) を参照してください。

## VSIXの作成・インストール

リポジトリのルートで `npm run package` を実行すると、`extensions/ai-agents/dist/ai-agents-<バージョン>-<OS>-<CPU>.vsix` が生成されます。VS Codeの **Extensions: Install from VSIX...** でインストールできます。

SDKにはOS/CPU別のネイティブバイナリが含まれるため、VSIXは作成した環境向けです。SDKの動的ロードを壊さないように依存パッケージを同梱し、npm workspacesのhoistingに影響されない一時ディレクトリでパッケージ化します。

## 公式SDKを確認した結果

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): `@cursor/sdk`。`Agent.create({ local: { cwd } })`、`agent.send()`、`run.stream()`、`run.cancel()` でローカルエージェントを制御。Node.js 22.13以降が必要。VS Code内でのSQLite依存を避けるため `JsonlLocalAgentStore` を使用。
- [Codex SDK](https://developers.openai.com/codex/sdk/): `@openai/codex-sdk`。ローカルCLIをラップし、`startThread()`、`runStreamed()`、`AbortSignal` で会話と停止を制御。モデルは固定せず、既存のCodex設定を利用可能。
- [Codex認証](https://developers.openai.com/codex/auth/)
- [Codex App Server](https://developers.openai.com/codex/app-server/): モデル一覧の自動取得に `model/list` を使用。
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

利用バージョン: `@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`。
