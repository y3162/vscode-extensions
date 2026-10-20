# AI Agents

v1.0.0は現在受入途中（NO-GO）です。[変更点](RELEASE_NOTES.md)・[Backend対応表](BACKENDS.md)・[導入/更新/復旧](INSTALL.md)を参照してください。出荷確認対象はmacOS arm64のみです。

VS Codeのサイドバーから、CursorとCodexの公式SDKを利用して質問やコード変更を依頼する拡張機能です。

## 使い方

1. 作業対象のフォルダをVS Codeで開きます。
2. アクティビティバーまたはセカンダリサイドバーの **AI Agents** を開きます。コマンドパレットの **AI Agents: Open Sidebar** でも開けます。
3. Home で **Codex** または **Cursor** を選び、過去の会話を開くか、右上から新しいチャットを始めます。ログイン、APIキー、診断、バックエンドは歯車の詳細設定にあります。
4. Chat の入力欄には、モード、モデル、添付、送信があります。サンドボックスと承認は詳細設定で変えます。バックエンドは既定で公式SDKです。対話型の承認や Codex のレビューには、詳細設定で Codex は **App Server**、Cursor は **ACP** を選びます。
5. モデル名を押すと、そのバックエンドが変更できる Effort やモデルを階層メニューから選べます。コマンドパレットの **AI Agents: Select Model** と **AI Agents: Configure Model Details** は、これまでどおり VS Code の選択画面を開きます。
6. 依頼を入力し、送信ボタンをクリックします。Enterで改行できます。実行中は追加入力がキューに入り、停止してもキューは残ります。左上の戻るで Home に戻っても、実行中のエージェントは止まりません。

例: 「このリポジトリの構成を説明して」「READMEの誤字を修正して」

同じ会話への追加依頼、ツール実行状況の表示、**停止**、**新しい会話**に対応しています。複数フォルダを開いた場合は作業フォルダを選べます。エージェントやフォルダを切り替えると会話がリセットされます。Codex App Server のモデルと Effort は次のターンへ反映します。Codex SDK は新しいセッションが必要なため、会話があるときは確認します。Cursor SDK では次の送信から反映し、会話は閉じません。

子エージェントの一覧はComposer直上に表示され、クリックすると同じサイドバー内で子の詳細を確認できます。親の待機表示と各Backendの取得可能な子情報・制限は [docs/SUBAGENTS.md](docs/SUBAGENTS.md) を参照してください。

## モデル選択

入力欄のモデル名を押すと、検索できるモデル一覧が Composer のそばに開きます。コマンドパレットの **AI Agents: Select Model** は、VS Code の選択画面を開きます。モデルIDの手入力は不要です。

- Codexは同梱CLIのApp Server `model/list`、Cursorは公式SDKの `Cursor.models.list()` から、選択画面を開くたびに一覧を取得します。
- モデル本体ごとに1項目表示します。Effort・Context size・Fast・Thinkingなどの設定の組み合わせは、モデル一覧の項目を増やしません。
- Cursorの一覧取得にはSDKログインまたはAPIキーが必要です。設定項目・候補値・既定値・プリセットはモデル本体と分けて保持します。
- 右上の再取得ボタンで一覧を更新できます。取得に失敗した場合も再試行できます。
- **既定のモデル** を選ぶと、Codexは既存のCodex設定、CursorはAutoを使用します。
- 選択したモデルはワークスペースごと・エージェントごとに保存され、再読み込み後も復元されます。Escで閉じた場合は選択や会話を変更しません。
- 同じモデルを選び直しても、保存済みの詳細値や会話を維持します。別のモデルへ変更した場合は新しいモデルの既定値を使います。

モデル一覧は各プロバイダーが返すカタログです。アカウントやチームの設定によって内容が異なり、一覧への掲載だけで実際の推論リクエストの利用権限を保証するものではありません。

## 詳細設定の変更

1. モデル名を押します。Fast、Context、Effort は、今のバックエンドとモデルが対応しているときだけ並びます。
2. **Model** から検索してモデルを選びます。Effort や Context はサブメニューの値を選びます。Fast はスイッチです。
3. コマンドパレットの **AI Agents: Configure Model Details** からも、同じカタログの値を VS Code の選択画面で変更できます。こちらは最後に **適用** を選びます。

モデルが対応している設定項目・値だけを表示します。Codexはモデル一覧が返すEffort、Cursor SDKはモデルごとのEffort・Context size・Fast等を設定できます。Cursor ACP はモデルやこれらのパラメータをセッションへ送らないため、Composer には出しません。Codex に Context や Fast の変更APIはないため出しません。

Codexの未指定のEffortは既存のCodex設定を使用し、Cursorの未指定値はSDKが返すモデルの既定値を使用します。別のモデルへ切り替えたとき、新しいモデルが対応する値だけを引き継ぎます。

Escやメニューの外で閉じても、入力中の文章と現在の設定は残ります。Cursor SDK の変更は次の送信で反映されます。Codex App Server は同じ会話の次ターンへ反映します。Codex SDK は新しいセッションが必要で、会話があるときは確認してから現在の会話表示を閉じます。選択値は再読み込み後も復元します。

## 認証

### Codex

既存のCodex CLIの認証を使用できます。未認証の場合は詳細設定の **ログイン** から開くターミナルで `codex login` を実行します。このログイン操作にはCLIがPATH上に必要です。SDK自体にはCLIが同梱されているため、APIキー認証時にCLIの別途インストールは不要です。

APIキーで利用する場合は、詳細設定の **APIキー** または **AI Agents: Set Codex API Key** で設定します。環境変数 `CODEX_API_KEY` / `OPENAI_API_KEY` にも対応します。明示的なAPIキーがなければCodexの既存ログインを使用します。

### Cursor

Home で Cursor を選び、詳細設定の **ログイン** を押してブラウザで認証します。これはCursor SDK用のログインです。CursorエディタやCLIへのログインとは別で、エディタの認証情報は自動では引き継がれません。

APIキーを使う場合は詳細設定の **APIキー** または **AI Agents: Set Cursor API Key** で設定します。環境変数 `CURSOR_API_KEY` にも対応します。ユーザーまたはサービスアカウント用のAPIキーが必要です。

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

既定では Codex は `workspace-write` / `approvalPolicy: never`、Cursor は `local.sandboxOptions.enabled: true` です。詳細設定から、サンドボックスと、プロトコルが対応する承認ポリシーを変更できます。SDKの `codex exec` は対話承認を受け取れないため、承認が必要なポリシーは App Server を選びます。Cursor SDKでサンドボックスが拒否した操作は、確認ダイアログにはなりません。ACPを選ぶと `session/request_permission` をチャット内で承認・拒否できます。

自動承認は既定でオフです。有効化には確認が必要で、サンドボックスを切ることとは別です。

`@` でワークスペース内のファイルやフォルダ、`/` でコマンドやスキルを参照できます。補完候補は上下キーで選び、Tabまたはクリックで確定します。画像の貼り付け、選択範囲、Problems、Git差分、シェル統合で見えた最近のコマンドも添付できます。変更ファイルは VS Code の Diff Editor で開き、変更前の内容を保持しているものはワークスペース内に限って復元できます。

会話はサイドバーを隠しても継続します。表示履歴はワークスペースごとの拡張機能専用保存領域 `history/v1` に保存し、Reload後も履歴から本文・ツール結果・Plan・Usageを復元します。バックエンドの会話コンテキストとは別の保存で、過去プロンプトをモデルに再送しません。Cursor SDKの会話ストアはglobalStorage配下、Codexの会話はCodex標準の保存先です。

表示履歴は手動削除までローカルに保持します。会話本文やツール出力に含まれる機密情報も保存され得ます。認証設定・承認トークン・画像バイナリは保存しません。`ai-agents.history.enabled` で新しい保存を無効化でき、`AI Agents: Delete Local Display History` で現在／すべてのローカル履歴を削除できます。バックエンド側の会話は削除しません。旧Codex SDK会話で、この拡張機能が保存していなかった表示履歴は取得できません。

回答全文・コード・ユーザー本文・ツール出力のCopyはExtension HostのクリップボードAPIを使い、完了または失敗を表示します。回答全文はMarkdown原文、コードはコード本文をコピーします。

Token Usageは会話とターンの概要から確認できます。Cursor SDKはRun計測、Codex SDKは累積値からの差分、App Serverはtotal／lastを区別します。cacheの包含関係を表示し、reasoningを二重計上しません。Cursor ACPは非対応、未取得値は「—」です。課金額を推定しません。

Cursor SDK 1.0.37のヘルパー探索に合わせ、拡張機能配下の専用プロセスで実行します。sandboxは有効のままです。起動できない場合はDiagnoseでSDK・実行環境・ヘルパー・設定の適用元を確認してください。Retryは入力を戻す操作で、実行には明示Sendが必要です。設定エラーの自動再送は行いません。

設計と機能差分は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md)、[docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md)、[docs/UI_GAP_ANALYSIS.md](docs/UI_GAP_ANALYSIS.md) を参照してください。

## テスト

リポジトリのルートで実行します。

```sh
npm test                 # 単体・モックプロトコル・DOM。認証も推論も不要
npm run test:coverage    # 行、分岐、関数のカバレッジ
npm run test:hygiene     # 生データや秘密らしき追跡ファイルの検査
npm run test:integration # 隔離した Extension Host。一時ワークスペースと profile を使う
npm run test:protocol    # インストール済みCLIの接続確認
npm run test:live        # 短い実推論。利用枠を使う
npm run test:tools       # 一時ディレクトリでの実ツールと承認
npm run test:runtime     # 実子エージェントと Background Terminal
```

`npm test` は実CLIの保存済み会話やスクリーンショットを読みません。プロトコルの境界は `test/fixtures/synthetic-runtime.cjs` の合成イベントで再現します。作業ファイルはOSの一時ディレクトリに作り、終了時に削除します。Live系の証拠やspikeの出力を残す場合は、`AI_AGENTS_RELIABILITY_EVIDENCE` と `AI_AGENTS_SPIKE_OUT` をリポジトリの外に向けてください。DOMテストの成功は、実OSのIMEやGUI操作の成功ではありません。ACPの並列子タイムアウトと、非TTYコマンドが初期stdoutを出さない制限は、実CLIのLive Testで区別します。

## VSIXの作成・インストール

リポジトリのルートで `npm run package` を実行すると、`extensions/ai-agents/dist/ai-agents-<OS>-<CPU>.vsix` が生成されます。VS Codeの **Extensions: Install from VSIX...** でインストールできます。

SDKにはOS/CPU別のネイティブバイナリが含まれるため、VSIXは作成した環境向けです。SDKの動的ロードを壊さないように依存パッケージを同梱し、npm workspacesのhoistingに影響されない一時ディレクトリでパッケージ化します。

## 公式SDKを確認した結果

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): `@cursor/sdk`。`Agent.create({ local: { cwd } })`、`agent.send()`、`run.stream()`、`run.cancel()` でローカルエージェントを制御。Node.js 22.13以降が必要。VS Code内でのSQLite依存を避けるため `JsonlLocalAgentStore` を使用。
- [Codex SDK](https://developers.openai.com/codex/sdk/): `@openai/codex-sdk`。ローカルCLIをラップし、`startThread()`、`runStreamed()`、`AbortSignal` で会話と停止を制御。モデルは固定せず、既存のCodex設定を利用可能。
- [Codex認証](https://developers.openai.com/codex/auth/)
- [Codex App Server](https://developers.openai.com/codex/app-server/): モデル一覧の自動取得に `model/list` を使用。
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

利用バージョン: `@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`。ACP と App Server の接続確認は、インストールされている CLI の応答を正とします。検証結果は [docs/VERIFICATION.md](docs/VERIFICATION.md) です。

## 0.9.0 の実行状態と制限

Plan の改訂に失敗した場合や Stop した場合は、改訂前の版と状態を保持します。Build 済みの版は再 Build できません。「Build 終了」は実装ターンの終了を示し、依頼内容の達成はファイルと結果から確認してください。Codex SDK の Plan と、Cursor ACP の会話途中のモデル変更は非対応です。

`ai-agents.maxBackgroundSessions` は既定 3 で、親ターンを実行中の会話だけを数えます。子エージェントや Background Terminal が残る会話は、表示切替だけで破棄しません。親の Stop は子やプロセスの停止を保証しません。状態は実イベントと公開一覧から更新します。App Server の Background Terminal は非空一覧の取得後、2 秒間隔で更新し、取得失敗時は直前の情報とエラーを表示します。

Codex SDK / App Server の変更前全文は、ターン前の Git 状態から確実に取得できた場合だけ Review / 復元に利用します。未コミットのユーザー変更を保持し、変更前全文が不明なファイルは復元できません。Git 管理外・バイナリ・大きなファイルには制限があります。Rename の復元先にファイルが再作成されていた場合は上書きしません。

旧実行経路では、このmacOS環境でCursor SDKのsandbox helper探索が失敗していました。専用プロセス経由への修復後は、sandbox有効の通常推論・編集・Plan / Buildと、実Task 1子のshell実行を確認しました。子別モデル・全継承・Foreground / Backgroundの全組合せと、今回のGUI手動受入は未完了です。保護設定は解除していません。実機結果・未検証項目は [検証記録](docs/VERIFICATION.md) を参照してください。
