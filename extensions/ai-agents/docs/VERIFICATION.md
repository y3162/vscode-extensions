# 0.10.0 再監査（2026-10-17）

今回の監査開始HEADは `b699abd`。過去版の成功と混同しない。改修内容・今回の証拠・未検証・v1.0.0判断は [AUDIT.md](AUDIT.md) を参照。

- 実推論: `npm run test:live` **5/5**、実ファイル/承認/復元: `npm run test:tools` **4/4**、実プロトコル: `npm run test:protocol` **2/2**。
- 実ランタイム: `npm run test:runtime` **12/12**。3経路のPlan改訂→同一会話Build、実2子並列、親Stop後更新、背景自然終了・停止・disposeを確認。[詳細](AUDIT_RUNTIME.md)
- ACP専用: Composer 2.5 Askの3ターンすべてfinal回答あり、dispose後のsession/loadで3回答を保持。反復delta欠落は決定的fixtureで再現し修正。[詳細](AUDIT_PROVIDERS.md)
- 実Extension Development Hostの結合テスト成功。コンテキスト展開中の会話切替で送信先を保持する回帰も追加。GUI目視とは別の証拠。
- GUI holdでは実ClipboardのUnicode往復に成功し元の内容を復元。一方、対象HostのGUIウィンドウを選択できず、300/390px・Dark/Light・nativeクリックは未検証。[詳細](UI_AUDIT.md)
- 最終型チェック・単体 **144/144** 成功。App Server Planのread-only / 承認never指定と、Agent / Buildで実sandbox・承認設定を戻す回帰3件を追加。追加の実Plan→改訂→Buildでもファイル非変更とBuild編集を確認。
- **v1.0.0: No-Go**。最終梱包と追加Planライブテストの詳細は総合監査に記録する。

以下は以前の検証記録を保持したもの。

---

# Verification

実施日: 2026-10-16。作業ディレクトリは `vscode-extensions`。対象は AI Agents 0.6.0。

プロセスとワークスペースは同じ Mac（darwin arm64、SSH ではない）。VS Code は 1.142.0、Extension Host の Node は 24.21.0。開発に使った Node は 26.7.0。どちらも Cursor SDK の 22.13 以上を満たす。

ユーザー設定に `ai-agents.*` の上書きはなかった。CLI のパスは固定していない。

| CLI | 解決結果 |
| --- | --- |
| Cursor | `which -a agent` → `~/.local/bin/agent` → `cursor-agent` 2026.06.26-7079533。`agent status` はログイン済み |
| Codex（PATH） | `~/.local/bin/codex` → スタンドアロン 0.162.1 |
| Codex（拡張機能の既定） | `node_modules/@openai/codex` 0.162.1 の `bin/codex.js`。空の `executablePath` はこちらを起動する |

認証ファイルの有無だけを見た。中身は読んでいない。`~/.cursor/sdk/auth.json` と `~/.codex/auth.json` はある。API キーへの切り替えはしていない。

プロトコルの正は、この 0.162.1 の `codex app-server generate-json-schema` と、起動した `agent acp` の `initialize` 応答である。公開ドキュメントの新しい camelCase サンドボックス名は、このバージョンの入力では使わない。`workspace-write` は受け付けられ、応答の `sandbox.type` は `workspaceWrite` になる。

## 実行した結果

| Check | Result |
| --- | --- |
| `npm run check` | 成功 |
| `npm test --workspace ai-agents` | 54 passed, 0 failed。通常のテストにライブ推論は含まれない |
| `npm run build` | 成功 |
| `npm run test:integration` | 成功。Webview の ready、モック SDK、停止、差分の復元、承認トークン、履歴プローブ |
| `npm run test:protocol` | 成功。実 `agent acp` と同梱 `codex app-server` |
| `npm run test:live` | 成功。4 バックエンドの短い推論、2 ターン、キャンセル、再開、Codex SDK から Cursor SDK への切替 |
| `npm run test:tools` | 成功。一時 Git ディレクトリだけ。このリポジトリの未コミット変更には触れていない |

## バックエンド

| | 接続 | 実推論 | ツール | 承認 | 再開 |
| --- | --- | --- | --- | --- | --- |
| Cursor SDK | 成功。SDK ログインでモデルと推論が動いた | 成功。`pong` / `pong2`、ストリーム更新、キャンセル、`resumed` | 成功。`note.txt` を `beta` に変更。承認 RPC は来なかった | SDK に対話承認はない。来たら失敗になるテストで、来なかった | 成功 |
| Cursor ACP | 成功。`initialize`、`cursor_login`、`session/new`、`session/list`、`session/set_mode`（agent / plan / ask） | 成功。キャンセルは `AbortError` | 成功。拒否した `denied.txt` は作られない。許可した編集は入る | 成功。`session/request_permission` を拒否、次の編集は `allow-once` | 成功。別プロセスの `session/load` が `pong` を返した |
| Codex SDK | 成功。同梱 CLI の exec | 成功。Effort `low` を渡して完了。キャンセルと再開も成功 | 成功。ワークスペース内の `note.txt` を変更。承認 RPC は来なかった | 対話承認は App Server が必要、という既存のエラーのまま | 成功 |
| Codex App Server | 成功。`initialize` / `initialized`、`model/list`、`thread/start`、`thread/resume` | 成功。キャンセルは `AbortError` | 成功。`untrusted` で拒否したコマンドはファイルを作らない。許可した編集は入る | 成功。`item/commandExecution/requestApproval` に `decline` / `accept` | 成功。表示履歴に `pong` が含まれる |

サンドボックスは UI だけでなく `thread/start` の応答で確認した。`read-only` は `readOnly`、`workspace-write` は `workspaceWrite`。Effort `low` は `reasoningEffort: low` で返った。

`on-request` と `workspace-write` では、サンドボックス内の `printf` は承認 RPC なしで実行された。これはこの CLI の動作である。承認の拒否を確かめるテストは `untrusted` を使い、サンドボックスは `workspace-write` のままにした。サンドボックスを外した確認はしていない。

Cursor ACP のファイル復元は、変更前テキストを書き戻して `alpha` に戻るところまで確認した。Cursor SDK も同様。Codex SDK と App Server のライブイベントには変更前テキストが無く、ライブの復元は未確認である。復元そのものは単体テストが通っている。

## 修正した不具合

- プロセス終了後も JSON-RPC の待ちが残り、死んだセッションを次の送信が再利用していた。終了後の要求はすぐ失敗し、次の送信は同じセッション ID で再開する。再開に失敗したときは、その ID を捨てて次の送信は新しい会話になる。自動では再送しない。
- App Server の `turn/completed` は `turnId` ではなく `turn.id` を持つ。失敗ステータスはエラーにする。`error` 通知は `error.message` を読む。
- ACP の「このセッションでは許可」は、CLI が選択肢を返さなければ `allow-always` を返す。ライブで通した許可は `allow-once` である。
- `skills/list` は `{ data: [{ skills: [{ name }] }] }` なので、名前を入れ子から読む。
- 診断は PATH の `codex` ではなく、セッションが起動する同梱 CLI または設定されたパスを見る。Extension Host の Node バージョンも出す。
- 標準エラーとエラー文字列から、トークン、API キー、`sk-` で始まる値を除く。

モックの `turn/completed` とスキル一覧は、この CLI の形に合わせた。モックを通すためだけの分岐は本番に足していない。

## 障害

単体テストまたはライブテストで確認したもの:

- CLI が無いとき、ACP は一度失敗してパスの確認を案内する。
- 認証失敗は `agent login` を案内し、再試行ループはしない。実アカウントのログアウトはしていない。
- 子プロセスが終了したあと、次の要求は待たずに失敗する。
- 初期化中の Stop は、そのプロンプトを実行しない。
- ユーザーの Stop はライブの 4 バックエンドでターンを止めた。
- 拒否した承認は実行されない。別の承認トークンは届かない。
- プロバイダー切替は会話を消してから新しいセッションを作る。

意図的にやっていないもの:

- 認証切れの再現。ログイン状態は壊していない。
- ネットワーク切断、非互換バージョンの CLI、ウィンドウの Reload、ワークスペースフォルダの変更。
- プロンプト全体のタイムアウト。モデル一覧は 20 秒で打ち切る。推論は Stop まで待つ。

## 画面

0.6.0 の記録: `docs/screenshots/` にあった PNG は 0.5.0 の Webview プレビューだった。Extension Development Host の撮影ではなかった。

### 0.7.0

2026-10-16。Home と Chat の見た目は、ビルド済み Webview をブラウザで 390×499（狭い画面は 300×499）に固定して撮った。Extension Development Host のサイドバーそのものは撮影していない。

| ファイル | 内容 |
| --- | --- |
| `home.png` | ダークテーマの Home。4件のセッションカード |
| `dark.png` | 上と同じダークの Home |
| `home-empty.png` | 履歴がない Home |
| `chat-new.png` | 新規チャット |
| `chat.png` | 過去の会話。Composer は下に固定 |
| `running.png` | 実行中。停止ボタン |
| `approval.png` | 承認カード |
| `composer.png` | 入力中の Composer |
| `narrow.png` | 幅 300px。モデル名は省略され、ボタンは重ならない |
| `light.png` | ライトテーマの Home |

統合テストは実 VS Code の Extension Host で、Webview の起動、`showHistory` のプローブ、実行中に別セッションへ戻そうとすると拒否して実行とキューが残ること、実行後のセッション復元、Diff Editor、承認トークンを確認した。幅 390px、IME、画像の貼り付け、ハイコントラストは Host の画面では見ていない。

### 0.8.0

2026-10-16。モデル設定メニュー。

| Check | Result |
| --- | --- |
| `npm run check` | 成功 |
| `npm test --workspace ai-agents` | 65 passed, 0 failed。ライブ推論は含まない |
| `npm run build` | 成功 |
| `npm run test:integration` | 成功。モック Codex で Quick Pick の Effort と、Webview メッセージ `setModelParam` の `medium` が `model_reasoning_effort` に載ることを確認。未対応の `context` は選択を変えない |

画面は Extension Development Host のサイドバーではなく、ビルド済み Webview のプレビューをブラウザで操作した。プレビューのカタログは見た目用で、Fast と Context を含む。実カタログでは Codex にこれらは出ない。

- ダーク: Composer は `Grok 4.7 Extra High`。メニューは Fast、Context、Effort Extra High、区切り、Model。
- Effort のサブメニューは Low / Medium / High / Extra High。選択中にチェック。
- モデル一覧は `Search models`、Default model、選択中の Grok 4.7 にチェック、Refresh。
- ビューポート幅 320px ではサブメニューが横に出ず、Back 付きの同一パネルになる。
- ライトとハイコントラストでもメニューの文字、枠、トグル、チェックが見える。
- モードは Agent（∞）、Plan、Ask。Debug と Multitask は出ない。メニュー操作後も入力文は残る。

未対応として記録し、成功扱いにはしない。

- Cursor ACP はモデル、Effort、Context、Fast をセッションへ送らない。Composer のモデル名はメニューを開かない。
- Codex SDK と App Server に Context と Fast の変更 API はない。メニューに出さない。
- Cursor SDK のモデル変更は次の `send({ model })`。実 SDK への推論は今回の通常テストでは実行していない。

### 0.8.1

2026-10-16。Enterで改行し、送信ボタンのクリックで送信する。補完候補の確定はTabまたはクリック。

- `npm run check`、`npm test`（65 passed）、`npm run package` は成功。
- VSIXへの `package.nls.json` と `package.nls.ja.json` の梱包漏れを修正。両ファイルがマニフェスト内の翻訳キーをすべて持つことを統合テストでも確認する。
- `ai-agents-0.8.1-darwin-arm64.vsix` を一時ディレクトリ内のVS Code 1.142.0へCLIでインストールし、成功。
- そのインストール済み拡張機能を `AI_AGENTS_TEST_EXTENSION_PATH` に指定して `npm run test:integration` を実行し、起動、Webview、モック送信、継続、停止、キュー、モデル選択、差分、承認まで成功。
- 報告された「VSIXとして無効」のエラーは手元で再現していない。旧0.8.0も同じ隔離環境ではインストールできたため、翻訳ファイルの梱包漏れがそのエラーの原因とは断定していない。

### 0.8.2

2026-10-16。AI出力の絶対パスから先頭の `/` が失われ、作業フォルダが重複する問題。

- 報告された `/Users/sekiyuuta/Developer/y3162/vscode-extensions/README.md` で再現する回帰テストを追加し、修正前に失敗、修正後に成功することを確認した。
- UIテストでは、Markdownリンク、絶対・相対パス、`file://`、空白を含むパス、行・列番号、Windows形式のパスがクリック時に正しく渡る。外部URLと未対応のスキームも検証した。
- `npm run check`、`npm test`（67 passed）、`npm run package` は成功。
- 0.8.2のVSIXを隔離したVS Code 1.142.0へインストールし、インストール済みファイルを使った `npm run test:integration` が成功。絶対パス、相対パス、空白をエンコードしたfile URIで同じREADMEの2行3列目を開けること、ワークスペース外のfile URIが拒否されることを確認した。

### 0.9.0

2026-10-16。Plan → Build、最終回答、ファイル変更、サブエージェント表示、別セッションの閲覧。

実機 Spike（一時ディレクトリ。API キーには切り替えていない）:

| Check | Result |
| --- | --- |
| ACP `session/new` | `modes` は agent / plan / ask。`mode: plan` を渡しても `currentModeId` は `agent` だった。続けて `session/set_mode` が必要 |
| ACP Plan + `cursor/create_plan` に `cancelled` | 計画名 Hello、To-do 3 件。`stopReason` は `end_turn`。同じターンで実装は始まらない。Design B を採用 |
| Cursor SDK `composer-2.5` Plan | `createPlan` のあとターンは `finished`。続けて `mode: agent` とモデル `composer-2` で `BUILD` を返した |
| SDK モデル一覧 | `composer-2.5` はある。`composer-2.5-fast` は CLI の `agent --list-models` にはあるが、SDK の `Cursor.models.list()` には無い |
| Codex App Server | `collaborationMode: plan` のターンのあと `default` と `gpt-5.6-luna` のターンが完了した。`thread/backgroundTerminals/list` は `{ data: [] }` |
| サブエージェントの並列 | 未実施。表示は `task` / `cursor/task` / `collabToolCall` のイベントに合わせ、Background とは結果にあるときだけ出す |

`npm test` は 72 件成功。ライブ推論は含まない。`npm run check` と `npm run test:integration` も成功。Extension Development Host での画面確認は未実施。

#### 0.9.0 実行制御の追加確認

2026-10-16。同じ作業ツリーの追加修正。0.6.0〜0.8.2 の記録はそのまま。

直したこと:

- 失敗または Stop で届いた途中の計画本文は公式版にしない。初回なら `idle`、改訂なら前の版を残す。`implemented` の復元は Build できない。
- Build 用に選んだモデルは、計画の改訂後も id とラベルを維持する。実行中の Build が送信前に失敗しても `building` のまま残さない。
- ACP の `session/set_mode` が成功してからローカルのモードを進める。`session/set_config_option` の失敗では巻き戻さない。
- App Server の Plan ターンに構造化 plan が無いときは、assistant 本文を計画にする。空のモデル ID は `collaborationMode.settings.model` に送らず、スレッドが返したモデルを使う。
- 実行中に New Chat しても、そのセッションへ戻って Stop できる。拡張機能の dispose は裏の会話も閉じる。未終了のバックグラウンドターミナルがある会話は hibernate しない。
- 変更 0 件でもターミナル一覧を出す。停止後は `thread/backgroundTerminals/list` で行を更新する。差分だけでは旧ファイルを復元できない変更は Review 対象にしない。
- `cursor/task` は status または duration が無いとき完了にしない。`spawn_agent` は assistant 本文にしない。子スレッドの本文は結果プレビューに残す。`unknown` は Background と表示しない。
- Codex 0.162.1 のバイナリに `spawn_agent`、`wait_agent`、`exec_command`、`write_stdin`、`thread/backgroundTerminals/list|terminate|clean` がある。子の終了待ち、stdin、ターミナル stdout の購読 RPC は使っていない。親の Stop は親ターンの interrupt だけ。

| Check | Result |
| --- | --- |
| `npm run check` | 成功 |
| `npm test --workspace ai-agents` | 78 passed, 0 failed。ライブ推論は含まない |
| `npm run build` | 成功 |
| `npm run test:integration` | 成功。実行中の New Chat のあと、同じセッションへ戻して Stop できる |
| `npm run test:protocol` | 成功。実 Cursor ACP `session/set_mode` の plan / ask / agent。同梱 Codex App Server の短い推論 |
| `npm run test:live` | 未実行。既存の 4 バックエンド推論スイートは今回回していない |
| `npm run test:tools` | 未実行 |

実 App Server（一時ディレクトリ、`gpt-6-luna`、read-only）:

- `model/list` に `gpt-6-luna` と `gpt-5.6-luna` がある。この確認で使ったのは `gpt-6-luna`。
- Plan ターンは `item/plan` ではなく assistant 本文だった。拡張機能はそれを `assistant-text` として記録した。同じスレッドの次ターンは `collaborationMode` default で、新しい plan は出さず `BUILD` を返した。
- その後の `thread/backgroundTerminals/list` は空。バックグラウンドプロセスの起動と terminate は未確認。
- サブエージェントを 2 つ起動するライブは未実施。並列実行とは記録しない。

Extension Development Host の画面撮影は未実施。Webview の自動テストで、変更 0 件のターミナル行、実行中のサブエージェント、Plan の Build ボタンを確認した。幅 300px と 390px の実画面、ダーク、ライト、ハイコントラストは未確認。

### 手動確認

Extension Development Host（`.vscode/launch.json` の Run AI Agents）で、次は未実施である。

- [ ] Primary Side Bar と Secondary Side Bar で Home と Chat を行き来する
- [ ] 幅 300px と 390px で、入力欄とツールカードがはみ出さない
- [ ] ダーク、ライト、ハイコントラスト
- [ ] 長い履歴、ストリーミング中、承認待ち、複数ツール、ファイル変更一覧
- [ ] 実行中に Back して同じチャットへ戻る
- [ ] 日本語 IME、画像の貼り付け
- [ ] キーボード操作、スクロール、フォーカス、入力欄の高さ

## 残る課題

- `on-request` は、サンドボックスが許可するコマンドには承認を出さない。承認カードを必ず試すときは `untrusted` を選ぶ。
- Codex のライブ変更は、変更前テキストがイベントに無いとこの拡張機能からは復元できない。
- 上の手動画面確認と、Reload、ワークスペース変更、通信断は未実施。
- Cursor Cloud / Background は起動していない。

## 0.9.0 実機検証・残存不具合修正（2026-10-16）

この節は上の履歴への追記である。着手時の未コミット変更 23 ファイルと既存の新規テストを保持した。対象バージョンは **0.9.0** のまま。移行評価は **Not Ready**。サンドボックス解除、認証変更、非公開 RPC の推測呼び出し、Release は行っていない。

### 環境とバックエンド別結果

macOS arm64、通常 Node 26.7.0、Extension Host Node 24.21.0、VS Code 1.142.0。ライブ操作は一時 Git ワークスペースに限定した。テスト用 VS Code の user-data / extensions はワークスペース外へ分離した。分離前は Git.log が変更として集計されることを確認したため、モデルによる変更の証拠には使っていない。

| バックエンド | SDK / CLI | 要求モデル → 観測モデル | 実際の API / イベント | 結果・制限 |
| --- | --- | --- | --- | --- |
| Cursor SDK | `@cursor/sdk 1.0.37` | 推論・編集 auto、Plan / Build composer-2.5。Task の解決モデルは実行前に失敗し不明 | `Agent.create` / `send` / `run.stream` / cancel、SDK tool / plan イベント | 推論・編集・Plan 改訂・Build 成功。Task + shell の Spike は通常 Node と Extension Host の両方で `Local SDK sandboxing was requested, but sandboxing is not supported in this environment`。設定は維持し、並列・子別モデル・継承・Foreground / Background の検証成功には含めない |
| Cursor ACP | CLI `2026.06.26-7079533` | モデルを送らず runtime-default → 実 Task 要求では composer-2.5-fast | `session/new` / `set_mode` / `prompt` / `cancel`、`session/update`、ID 付き `cursor/task` 要求と応答、permission RPC | 推論・編集・拒否 / 許可・Plan 改訂 / Build・実 Task 並列成功。モデル選択は既存の非対応を維持 |
| Codex SDK | `@openai/codex-sdk 0.162.1`、同梱 CLI `0.162.1` | gpt-6-luna。ランタイムが別の解決モデル ID を返さない箇所は要求値として記録 | `startThread` / `runStreamed` / resume、item / turn イベント、AbortSignal | 推論・編集・Git baseline / 復元成功。Plan と対話承認は非対応。SDK 経路の子並列は今回未検証 |
| Codex App Server | `@openai/codex 0.162.1` | gpt-6-luna → 実子イベントでも gpt-6-luna | `model/list`、`thread/start` / resume / read、`turn/start` / interrupt、`item/started` / completed / command output、`subAgentActivity`、`thread/backgroundTerminals/list` / terminate | 推論・編集・拒否 / 許可・Plan / Build・子並列・Background Terminal 成功。子の全終了を親 Stop から推定しない |

モデル一覧を取得してから明示モデルを選んだ。一覧にあることだけを実行成功とはしていない。ACP の Task の子 ID / モデルは実要求を採用し、親の回答に書かれた別の ID は採用しない。

### 発見した不具合、原因、修正と検証

| 期待仕様・再現結果 | 根本原因と修正 | 回帰・実機再確認 |
| --- | --- | --- |
| 子 1 件につきカード 1 枚。実 App Server の子が欠落、spawn / wait の終了と子完了が混同され得た | 実際の `subAgentActivity.agentThreadId` / agentPath / kind と collab の receiverThreadIds / agentsStates を読む。子 ID で upsert し、失敗・中断・unknown を保持 | 実イベント fixture 再生、失敗 / 中断 / wait 重複の自動テスト。実子 2 件の ID・区間重複・完了をライブ確認 |
| ACP の実 Task 要求に応答し、親本文へ子の回答を混ぜない | 通知だけを想定していた。ID 付き `cursor/task` サーバー要求にも同じ処理を適用して `{}` を返す。tool_call と更新を同じカードへ関連付け | 実要求 fixture 再生とライブ Task 並列。実 agentId / model / duration を保持 |
| 親終了後の自然終了でターミナル行と出力を更新する。修正前は RPC 空でも行が残った | run 内の emitter だけに依存していた。任意のセッション購読を追加し、元ターンへ関連付け。公開一覧を 2 秒でページング取得し、空も反映 | late update、poll-only exit、ページング、取得失敗、terminate 失敗の再生テスト。実自然終了・stdout / stderr・別会話・terminate をライブ / 実画面確認 |
| 取得失敗で停止済みや空と断定しない | 一覧失敗を空へ潰さず、最後の情報と error / unknown を保持。terminate 応答と再取得で確認 | LIST_FAIL / TERMINATE_FAIL の決定的再生。実機の非空 → terminated true → 空を別途確認 |
| 改訂失敗 / Stop は元の版と状態を戻す。Build 済みの旧版が ready へ戻って再 Build できた | 改訂前 phase を保持し、成功した改訂だけ新しい ready 版にする | implemented の失敗・Stop・復元で Build 不可、成功時新 revision だけ Build 可の状態テスト。成功改訂 / Build は対応 3 経路でライブ確認 |
| 別会話からの遅延操作や同時承認が対象を取り違えない | conversationId による対象確定、承認のトークン付きキュー、購読解除 / 復元購読、元ターン ID の維持 | stale 操作、同時承認、Stop 時拒否、late update の別会話隔離を自動 / Extension Host fixture で確認 |
| 子・ターミナルが残る会話を表示切替だけで破棄しない | 親 busy と別に live child / terminal を保持。hibernate を抑止 | 上限既定 3 と親 busy のみの集計、設定上限到達、New Chat / 復帰を自動確認。実ターミナルの Home 往復も確認 |
| ユーザーの未コミット原文を復元し、読み取りを変更に数えない | Git の開始時リビジョンを固定し、dirty / untracked の原文と正味差分を取得。特殊文字を含む porcelain -z を解析。不明な原文は HEAD で代用しない | 特殊文字・未追跡・dirty・途中 HEAD 変更・中断・read 除外・workspace 外を自動確認。4 経路の実編集と復元も確認 |
| Rename を元パスと移動先で 1 件として扱う | 実イベントは kind.type=update と move_path だった。移動先を path、元を oldPath として保持し、Git fallback の delete / add 重複を抑止。復元は元パスへの排他的作成で保護 | 実 move_path fixture、自動パス別名テスト。実機で dirty alpha → b.txt beta、+1/-1、1 行だけ、再作成した元ファイルの保護、原文 alpha への復元を確認 |
| 実画面の Build 状態とアイコンを正確に表示する | readonly 拒否でも「Implemented」と表示していたため「Build 終了」に変更。HC 枠線追加。テーマの CSS escape `\E023` を Unicode に変換 | 実 readonly 拒否と workspace-write の実変更を区別。HC 実画面とアイコン修正後の再読込、無効コードポイントを含む UI 回帰テスト |

### 子エージェント並列の実証

実機で確認した構造（子2件の `subAgentActivity`、`kind: "started"` の item/completed は子の完了ではない、空の `wait`、子スレッドの delta と final answer、ACP の `cursor/task`、`kind.type=update` の `move_path`）は、リポジトリ内の合成イベント `test/fixtures/synthetic-runtime.cjs` で再現する。採取した生 JSON、正規化ログ、スクリーンショットはテストの入力ではない。個人の一時パスと認証情報は含めていない。

- App Server の事前実機記録では alpha の実コマンド区間が 06:21:54–06:22:02 UTC、beta が 06:21:57–06:22:05 UTC。約 5 秒重複した。`subAgentActivity` と子の commandExecution 開始 / 終了で確認した。
- 修正後ライブでは子 `01a14382-ce0d-7eb0-b55e-50b6292acf83` と `01a14382-e542-7dc0-9d72-0e97c36402c7` が completed。イベントの開始 / 終了から両区間の重複を確認した。モデルは gpt-6-luna。
- ACP の修正後ライブでは実 agentId `55852c18-29fd-42af-b026-e6ddd6598d87` と `40161178-a721-4b38-b7e7-91692b693f13`。両者 composer-2.5-fast、実処理時間 14591 / 14748 ms、区間が重複した。親への結果返却は Task 更新 / 応答後、カードは各 1 枚で completed。
- ACP は別の実行では結果収集用 Task を追加して 5 件以上生成した。テストは「正確に 2 件」という誤った前提をやめ、2 件以上の別 ID と実区間重複を検証する。
- 親 Stop 後の bounded 観測では子が継続する場合があった。最終 runtime suite の 18 秒後は 2 件 running、独立した追加観測では 1 件 completed / 1 件 running。どちらも完了成功や停止へ書き換えていない。通知が来ない子には公開 `thread/read` の実 turn status を用いる。dispose は既存の CLI 終了方針を維持し、全子の強制停止保証とはしていない。
- Cursor SDK の並列は **環境制限で失敗 / 未検証**。通常推論や Plan の成功を並列成功へ転用しない。子別モデル指定・親コンテキスト継承の独立確認も残る。

### Background Terminal

App Server のモデル用 exec_command が返した processId と command itemId を関連付けた。`process/spawn` は使っていない。

- 事前実機: processId 61382 は親完了後に非空一覧へ残り、terminate 応答 terminated=true、再取得で空を確認した。
- 修正後 live runtime: 自然終了と最終 stdout / stderr / exitCode=0 を元会話へ配送。他会話へ移動しても元セッションを保持。別プロセス 14805 の terminate と空一覧も確認した。
- 実画面: processId 56619 は親回答後も running 行が表示された。Home を往復し、30 秒の自然終了後には行が消え、元の Tool Call に UI_BG_STARTED / UI_BG_DONE が表示された。別 processId 2974 は Terminate ボタン操作後に行が消えた。
- 取得失敗 / false terminate / ページングは fixture による決定的確認。今回の実機で通信断を注入した成功とは記録しない。

### Plan / Build 10 シナリオ

「live」は各バックエンドの実推論。「回帰」は状態関数・コントローラー・プロトコル fixture の自動テストであり、ライブ成功とは区別する。

| シナリオ | Cursor SDK | Cursor ACP | App Server |
| --- | --- | --- | --- |
| 初回 Plan 成功、編集せず停止 | live | live | live + 実画面 |
| 初回 Plan 失敗、途中本文を破棄 | 回帰、live 未再現 | 回帰、live 未再現 | 回帰、live 未再現 |
| Plan 中に Stop | 回帰、live 未確認 | 回帰、live 未確認 | 回帰、live 未確認 |
| Plan 改訂成功、版更新 | live | live | live |
| Plan 改訂失敗、旧版維持 | 回帰、live 未再現 | 回帰、live 未再現 | 回帰、live 未再現 |
| Build は同一会話の Agent ターン | live、実ファイル revised | live、実ファイル revised | live + 実画面、実ファイル revised / hello |
| Build 再押下、二重開始防止 | live + 回帰 | live + 回帰 | live + 回帰 |
| implemented 復元時の Build 不可 | 実 Plan を復元して確認 | 実 Plan を復元して確認 | 実 Plan を復元して確認 |
| 改訂後 Build のモデル ID / ラベル保持 | live、composer-2.5 | live、既定 / 保存ラベル | live、gpt-6-luna |
| 別モデルへの変更で履歴保持 | 回帰、別モデル live 未確認 | 非対応を維持 | 回帰・実画面の選択、別モデル推論は未確認 |

implemented の改訂失敗 / Stop と ready の改訂失敗 / Stop を別にテストした。失敗後の実装済み旧版は再 Build 不可。成功した改訂は新しい版だけ Build 可。全 30 ケースのライブ完了とはしていない。Codex SDK の Plan は非対応。

### 承認、変更ファイルと耐障害性

`test:tools` は 4 バックエンドを独立したテストに分けた。ACP は通常編集で承認を要求しない場合があるため、編集内容・イベントと、実要求があれば応答を確認する。対話承認は安全な shell の printf で拒否 → 許可を実際に確認する。直近実行のファイル編集時の要求数は ACP=1、App Server=3、各 SDK=0。要求数は固定仕様とみなさない。SDK は対話承認非対応である。

CLI の異常終了と次回再開、途中状態、古い承認トークン、同時承認は自動 / Extension Host の隔離 fixture で確認した。編集やコマンドの自動再送は追加していない。実認証の通信断、フル Reload、ワークスペース切替と進行中の副作用が重なるケースは未検証。

Review / 復元は確実に取得した原文だけを使う。Git 管理外、ignored、バイナリ、大きな全文、未知の新規ファイルには安全上の制限が残る。Rename は native move_path または Git の rename があると関連付ける。単なる unstaged シェル移動は delete / add となる場合がある。

### Extension Development Host の実画面

既存 Run AI Agents を起動した上で、操作を続けるホストは同じ拡張ソースをロードする VS Code 1.142.0 の隔離テストホストに統一した。ウィンドウタイトル `[Extension Development Host]` と Webview URL の `extensionId=y3162.ai-agents` を確認した。親ウィンドウが写った初期撮影は証拠に含めない。

保存した画面はローカルの検証記録であり、テスト実行には不要である。ブラウザの UI mock ではない。

- Primary / Secondary Side Bar、Home / Chat、幅 300 / 390 px、Abyss（dark）/ Light Modern / Dark High Contrast の実レイアウトを確認した。
- 実 Plan View、Build 操作、モデルカタログと選択、Effort メニュー、Thought / Tool Call の展開、ターミナル、File Changes、Review の `vscode.changes` 差分を確認した。子カードの詳細操作と代表画像、Effort の別値での実推論、実承認カードの手操作は未確認。承認要求 / 応答自体は実 CLI の自動テストで確認した。
- Composer 固定、履歴スクロール、Enter 改行、Tab フォーカス、日本語テキストの貼付と Webview 再作成後の下書き保持を確認した。長時間 / 超長履歴の全体的な負荷試験は未実施。
- 日本語入力は貼付であり、ネイティブ IME の変換中イベントを実機で確認したわけではない。composition の自動テストのみ。画像クリップボードの実貼付、フル Reload は未確認。子カードの撮影をやり直す追加ホストは起動できたが、UI 操作ツールの接続が繰り返し timeoutReached となった。画面外のカードを撮影成功には数えない。
- UI 修正は HC 枠線、状態文言、ファイルアイコンに限定した。デザイン刷新は行っていない。

### 実行したチェック

| チェック | 結果 |
| --- | --- |
| `npm run check` | 成功、最後のアイコン修正を含む |
| `npm test --workspace ai-agents` | **98 passed / 0 failed**。初期 78 件から追加。実 fixture 再生を含み、ライブ推論は含まない |
| `npm run build` | 成功、0.9.0 |
| `npm run test:integration` | 成功。実 Extension Host + プロトコル fixture。stale 操作、New Chat / Stop / 復帰、親上限、モデル、Review / 復元、承認 token を含む |
| `npm run test:protocol` | 実 Cursor CLI / 同梱 App Server、2 passed |
| `npm run test:live` | 実 4 バックエンドと切替、**5 passed** |
| `npm run test:tools` | 実 4 バックエンド独立、**4 passed** |
| `npm run test:runtime`（追加） | 実子並列 2 経路、自然終了 / terminate、Plan / Build 3 経路、親 Stop、**7 passed** |
| 追加の実 Rename | 1 行、+1/-1、dirty 原文保持、再作成元保護、復元を成功確認。evidence の LIVE_RENAME |

最後の実ライブ各 suite の後に追加した Rename / 履歴復元 / アイコン変更は、通常 98 テスト、型チェック、build、最終 Integration / protocol、実 Rename Spike、Webview 再読込で検証した。live / tools / runtime 全体をその後もう一巡したという意味ではない。

### 移行評価と残作業

**Not Ready**。確認した P0 の状態管理不具合は修正し、App Server / ACP の実並列と Background Terminal を証拠付きで確認した。一方、主要機能である Cursor SDK の子実行がこの環境では失敗し、全バックエンドの Plan 失敗・Stop のライブ再現にも未完了がある。

残作業:

- 保護設定が有効な対応環境で Cursor SDK の Task を実行し、継承・子別モデル・Foreground / Background と結果返却を確認する。この環境の設定を自動解除しない。
- Plan 10 シナリオの表にある未完了のライブ失敗 / Stop / 別モデル推論を安全な隔離環境で補う。
- 子カード詳細の実画面確認、IME 変換、画像貼付、実承認の手操作、フル Reload / ワークスペース切替 / 通信断 / 極端に長い会話を実機確認する。コマンド・編集の二重実行がないことも確認する。

公式仕様参照: [App Server](https://learn.chatgpt.com/docs/app-server)、[Cursor ACP](https://cursor.com/docs/cli/acp)、[Cursor SDK](https://cursor.com/docs/sdk/typescript)。公開一覧・thread read の範囲で実装し、モデルの説明文を状態の証拠にしない。

## 0.9.0 チャット信頼性修復（2026-10-17）

本節は今回の追記。バージョンは **0.9.0**。実装・自動テスト・実バックエンド確認に加え、GUI権限反映後に実サイドバーの手操作を追加した。ACPの最終回答欠落と未検証ケースが残るため、v1.0.0移行評価は **Not Ready** とする。スクリーンショットは今回の実Extension Development Hostで新規撮影した。

環境: macOS arm64、開発Node 26.7.0、VS Code 1.142.0、Extension Host Node 24.21.0。Cursor SDK 1.0.37／platform package 1.0.37、Cursor CLI 2026.06.26-7079533、Codex SDK／同梱CLI 0.162.1。実推論は一時Gitワークスペースと隔離profileで実施。グローバル認証・sandbox設定は変更していない。

### 原因と主要な変更

| 不具合 | 変更前の事実・根本原因 | 実装 |
| --- | --- | --- |
| Cursor SDKのsandboxエラー | `Agent.create`／`Agent.resume`は成功、最初の`agent.send`で`ConfigurationError`、isRetryable=false。SDKのplatform helper探索はSDK自身の場所でなくargv[1]／実行ファイルの祖先を使う。Extension Hostではその場所がVS Codeになる | 拡張機能配下の`dist/cursor-worker.cjs`をNodeモードでforkし、既存AgentSessionをIPCで提供。sandboxを有効のまま渡す。SDKコード・プロセス全体のargvを書き換えない |
| 「履歴を返さない」の表示 | 表示履歴全体の永続化がなく、Cursor `Agent.messages.list`のmessageをcontent配列として読んでいた。実物はprotobufのturn oneofで、JSONではagentConversationTurnになる | public messages APIのoneof／JSON双方を正規化。ユーザー・公開Thought・ツール・回答を復元。Run APIを補助に使う |
| ローカル会話の消失・混入 | reset中にbackend IDを失ったsnapshotが同じ保存先を上書きし得た。復元時のcwd／backendが現在の設定に依存。300メッセージ／40ターン／32,000文字の破棄があった | SessionRegistryで過去controllerを保持し、workspace storageへ会話UUID付きsnapshotを保存。保存済みbackend／cwdで再開し、backend turn/item IDで照合。元本文・Turnの固定件数破棄を撤去 |
| コピー不能・装飾混入 | Webview Clipboard APIへ直接書き込み、拒否を無視。回答は描画DOMのtextContentをコピー。ユーザー／ツールの操作も不足 | request ID付きでHostへ送信し、`vscode.env.clipboard.writeText`の完了／失敗を返す。Markdown原文・コード本文・元ツール文字列を保持 |
| Usage不可視・二重計上 | 可視表示がなく、使用量はsr-only要素に含まれていた。全通知を単純加算していた | 会話概要とターン値を可視化。Run sampleの置換とセッション累積snapshotを分離。Codex累積値は保存した基準から差分を計算 |
| Retry／追加不具合 | Retryは単なる下書き復帰で対象試行がなかった。失敗後もキューを自動送信し得た。空の会話でbackend変更が実行設定に伝わらず、休止済み会話では構造設定変更がresetされなかった | Retry対象・新試行IDを保持し、元ユーザー表示を共有。明示Sendまで実行しない。失敗で自動送信を停止。会話ごとの実行設定を更新し、backend名だけでなく実Usage.sourceも検証 |

変更箇所は、provider worker／履歴normalization、ChatController／SessionRegistry／HistoryStore、sidebar／ViewState／Webview、ビルド・パッケージ・テスト。Plan／Build、子、Terminal、Reviewの既存経路を維持した。SDKの実行不能時は設定エラーとして表示し、Diagnoseで環境・ヘルパー・設定ファイルの有無を確認できる。Logsにはredact済みのエラー種別・段階・本文を記録する。

ローカルにも変更前VSIXにもcursorsandboxとtree-sitterが存在し、helperは実行可能だった。ユーザーと調査workspaceにsandbox.jsonは存在しなかった。起動パスだけを拡張配下にした変更前比較では、sandbox有効のままHiと2ターン目が成功。SDK配置不足や設定ファイル削除で解決する問題ではなかった。

### 保存方針と復元

- ユーザー選択どおり手動削除まで保持する。保存先は`ExtensionContext.storageUri/history/v1`。新規保存を`ai-agents.history.enabled`で無効化できる。
- `AI Agents: Delete Local Display History`で現在／全ローカル履歴を削除する。既存Plan保存分も対象。遅延したbackground更新で削除分を復活させない。backendの会話は削除しない。
- 本文、公開Thought要約、ツール結果、Planと版、子・Terminal・変更ファイル・Turn状態・Usageを保存する。認証設定、環境変数、承認待ちトークン、セッション内許可、画像バイナリは保存しない。本文／ツール出力に含まれる機密情報は保存され得る。全文の暗号化は追加していない。
- ディレクトリ0700／ファイル0600、会話別の直列・atomic更新。実行中は500msで間引き、アイドル・切替・終了時にflushする。旧schema／破損ファイルは削除せず診断する。
- 表示snapshotを先に戻してからbackendへ接続する。過去プロンプトの再送はしない。保存済みIDは重複表示せず、backendの未知ターンと識別できる欠落itemを取り込む。取得失敗でもローカル本文を消さない。
- 保存時に実行中だったTurnは中断として戻し、承認待ちは再利用しない。子・Terminalは不明を完了扱いしない。旧Planは読み取り移行用として維持し、新規Planは会話snapshotに含める。

### Backend別の履歴とToken Usage

| Backend | 表示履歴の取得 | Usageの取得・集計 | 未取得・制限 |
| --- | --- | --- | --- |
| Cursor SDK | local snapshot + 公開Agent.messages.list／listRuns／run.conversation | SDKUsageMessage、run/result.usage fallback。Runの記録を会話へ集計。inputはcacheを含まず、totalはinput + output + cache read + cache write。reasoningはoutput内数 | context window未取得。Agent.getUsageのlocal usage UUIDとクライアントRun IDは別物。請求・価格推定は表示しない |
| Cursor ACP | local snapshot + initializeで広告されたsession/loadの再生 | このCLIのinitialize応答にはUsage広告がなく、使用量は非対応と表示 | session/resumeも未広告のため使用しない。未知の拡張通知から推測しない |
| Codex SDK | local snapshot。resumeThreadはモデル会話継続用 | 実0.162.1のturn.completed.usageは累積。input 15,991 → 32,003 → 再開49,189を変更前に実測。累積を置換し、既知の前値との差分だけTurnへ配分 | 公開SDKに本文履歴取得APIがなく、保存開始前の旧会話本文は復元不能。基準不明のTurn値は未取得 |
| Codex App Server | snapshot + thread/resume、thread/turns/list(full)、read fallback | 同梱Schemaのthread/tokenUsage/updatedのtotal／lastを分離。totalを置換しTurn差分を計算。lastは直近リクエストとしてcontext表示に使用 | cache write／reasoning／modelContextWindowは返却分のみ。lastをそのままTurn全体へ加算しない |

全経路で未取得と実測0を区別する。reasoningの二重加算、累積値の再加算、streamとresultの二重計上をしない。部分的にしか得られない内訳を会話全体の確定値にしない。

### 実行結果

| 検証 | 結果 |
| --- | --- |
| npm run check | 成功 |
| npm test | **108 passed / 0 failed**。表示保存・再構築・ID照合・protobuf oneof・320メッセージ／160Turn・長文・Usage差分・Retry・コピー原文／成功／失敗を含む |
| npm run build | 成功。extension／webview／cursor-workerの3成果物 |
| npm run test:integration | 実Extension Host + fixtureで成功。モデルpicker、Stop、Queue、背景会話、設定変更、承認、Review、webview probeを含む |
| npm run test:protocol | 実CLI、**2 passed** |
| npm run test:live | 実4backend + 切替、**5 passed**。新規・2ターン・Stop・再開 |
| npm run test:tools | 実4backend、**4 passed**。実編集・拒否／許可・原文復元。ツール出力処理の修正後にも再実行 |
| npm run test:runtime | 実子並列2経路、Terminal自然終了／terminate、Plan改訂／Build3経路、親Stop、**7 passed** |
| 追加Cursor SDK Task | runtime suiteへ新規ケースを追加し、そのケースを単独実行、**1 passed**。実Task running → completed、実子のshell出力CHILD_SANDBOX_OK。sandbox有効の専用worker。上の7件と合わせて1回の8件suiteを回したという意味ではない |
| 保存前Cursor会話の復元 | 実JsonlLocalAgentStoreを公開APIで再開し、2ユーザー＋2公開Thought＋2回答をworker経由で復元。型fixtureだけでなく実protobuf oneofを確認 |
| VSIX package／install | 0.9.0 darwin-arm64 VSIX生成・隔離profileへのCLIインストール成功 |
| インストール済みVSIX | 開発source指定をinstalled extension pathへ変更した実Hostで既存integration成功。worker／helper／tree-sitterの同梱・権限・内容一致を確認 |
| 4backendの追加Host検証 | 開発版とinstalled VSIXの双方で、各3ターン、Home／別チャット／復帰、クリップボード読戻し成功。Hostプロセス終了→同じprofile起動の2段階で、3ユーザー・3Turn・Usageの復元と4ターン目の実回答を確認 |

追加Host検証の再現方法（ライブ推論あり）:

```bash
AI_AGENTS_RELIABILITY=1 AI_AGENTS_RELIABILITY_EVIDENCE=/private/tmp/ai-agents-host-evidence.json npm run test:integration
```

VSIXでは`AI_AGENTS_TEST_EXTENSION_PATH`へ隔離インストール先を指定する。スクリプトは同じworkspace／profileでinitial→reloadの2プロセスを起動する。これはプロセス再起動の確認で、手操作によるReload Windowコマンド確認とは区別する。

証拠の要約は当時のローカル記録に残した。各backendの実Usage、3Turn時点の件数、再起動結果を記録した。最後のログ出力追記で推論経路は変更していない。その追記を含む最終VSIXを再インストールし、通常integrationも再実行して成功した。source／VSIX／installedのJS3成果物はバイト一致を再確認した。これらの JSON はテストの入力ではない。

### コピー・実画面の確認範囲（GUI再試行後）

最初のGUI接続はCodeへの承認拒否だったが、ユーザーの許可反映後の再試行で接続できた。以下はブラウザプレビューではなく、隔離profileとインストール済みVSIXを指定した **実Extension Development Host** のサイドバーで実施した。通常の空ウインドウと検証ホストが別プロセスだったため、空ウインドウを終了して検証ホストを選択した。

- **コピー実ボタン**: App Serverの復元済み会話で、コード、回答全文、ユーザーメッセージのCopyを押し、Composerへ通常のCmd+Vで貼り付けた。コードは`console.log("日本語 😀");`、回答全文は`**reliability**`と改行・fenceを含むMarkdown原文、ユーザー本文も完全一致。送信せず下書きを消した。
- **ツール結果コピー**: GUIからCursor SDKにprintfを実行させ、Worked for → shell詳細 → Copy → ComposerへのCmd+Vで、終了コード・複数行stdoutを含む元JSON文字列と一致を確認した。
- **Host単体の補助確認**: 回答Markdown、日本語・Unicode、空文字列、120,000文字はcopyハンドラーから`vscode.env.clipboard.readText`へ完全一致。コピー失敗応答はDOMテストであり、実OSの失敗注入ではない。
- **幅・テーマ**: サイドバー300px／390px相当（Retina 2倍画像の境界差600／780px、sashを除く）でDark 2026、Light Modern、Dark High Contrastを目視。回答・コード・折りたたみUsage・Composerが利用できることを確認し、6枚を保存した。非常に長い履歴の実機表示は今回の3ターン表示と区別する。
- **履歴・Usage**: Home → 同じ会話でApp Serverの3ターンとUsageを再表示。Cursor SDKの3ターン、入力26,535／出力117／cache read16,768／total43,420、reasoning92の内数表記を確認。App Serverは入力49,540／出力34／total49,574、cache read40,064、context17,253／258,400（6.7%）。ACPは0にせず非対応と表示した。
- **SDK実操作**: 新規チャットのHiに日本語の実回答、継続ターンのshell実行、sleep要求に対するStopでReadyへ復帰することを確認。AccessはSandboxのまま。実行中画面も保存した。
- **Plan → Build／Review**: GUIでPlanを選び、`gui-check.txt`作成を計画。Build前にファイル不存在、Buildクリック後に`GUI_BUILD_OK\n`を実ファイルで確認した。Build finished、File Changes +1 −0、Reviewのdiff editorが開くことを確認した。
- **診断・ログ**: Run Connection DiagnosticsからSettingsのDiagnosticsを表示し、Host Node・CLI・SDK auth・sandbox helperの検出を確認。LogsボタンでAI Agents Outputが開いた。診断にアカウント情報が含まれるため、その画面は保存画像に含めていない。

画像は Dark 300、Dark 390、Light 300、Light 390、High Contrast 300、High Contrast 390、SDK履歴、ACP履歴、SDK実行中、Plan、Build、Review をローカルに保存した。リポジトリには含めず、テストも参照しない。

追加GUI／再起動検証でも、同じprofileのプロセス再起動後、4backendの保存3TurnとUsageの復元・追加の実回答を確認した（終了コード0）。これは手操作のReload Windowとは別の検証である。製品コードとバージョンはこのGUI再試行では変更していない。要約JSONはローカル記録であり、テストの入力ではない。

### GUI追加検証で発見した未解決事項

- 今回のACPの3ターン会話では、2ターン目の「覚えた単語だけを返す」要求に対する最終Assistant回答が表示されなかった。保存snapshotにも該当ターンのユーザー本文と公開ThoughtはあるがAssistant itemがない。したがって今回の再表示だけの欠落とは判断できない。生のACP通知とprompt応答を採取して、CLIの返却不足かAdapterの取りこぼしかを確定する必要がある。Thoughtを最終回答へ転用していない。
- reliability Host harnessは3ユーザー／3Turnと、会話中のいずれかの回答に記憶単語があることを検証していたため、この欠落を合格として通過した。下記の再起動harness成功を「ACPの全3回答が正常」と解釈しない。各ターンの最終回答を要求する受入チェックの追加が必要。
- Copy成功ラベルは日英併記で、300pxのユーザーメッセージ横では一時的に縦へ長く折り返された。本文やコピー内容は正しいが、コンパクトなフィードバックへの調整が残る。

### 残る制限とv1.0.0前の作業

1. 上記ACPの最終回答欠落を再現・修正する。実ボタンからの失敗後Retry、手操作のReload Window、ネイティブIME変換、画像貼付、通常の選択コピー、長い履歴・全バックエンドでのUI操作は引き続き未検証。今回の成功を全UIシナリオ合格としない。
2. 本修復前に表示を保存していなかったCodex SDK会話の本文は取得できない。旧索引にbackend識別がない場合は選択を求める。
3. 同じbackendターンを他クライアントが同時変更した場合、完全な競合解決・全backendの外部変更検知は保証しない。保存された中断本文を消さず、未知／未取得を保持する。旧import履歴の全tool metadata／Plan版／時刻の完全性も、返却APIに依存する。
4. Stop／失敗時、backendが返さなかったUsageは未取得のまま。ACPのUsage、Cursor SDKのcontext window、価格推定は追加していない。
5. 4backendそれぞれについて、キャッシュwriteが非0のケース、複数ツールとUsageの対応、通信断・Reloadと副作用が重なるケース、失敗後Retryの全ライブ組合せは未網羅。既存自動回帰／部分ライブの成功を全組合せ成功としない。
6. Cursor SDK Taskは今回1子の実呼び出しを確認。子別モデル指定・全コンテキスト継承・Foreground／Backgroundの全組合せまでは合格扱いしない。App Serverでは親Stop後も子がrunningの場合があり、停止済みと偽らない。

主要チャット操作はコード・自動回帰・実バックエンド・installed VSIXと一部の実GUIで確認できた。ただしACPの最終回答欠落と未検証事項が残るため、総合判定は **実装済み／自動・ライブ・GUI検証済み部分あり、手動受入未完了** とする。


### 2026-10-17 モデル選択・送信・コピー配置と子実行の再確認

- WebviewとネイティブQuick Pickの合成Default項目を削除。未指定時は「モデルを選択」と表示する。実モデルの推奨属性とパラメーターの既定値は維持する。
- 送信ボタンをborderなしの中央揃えに変更。回答・ユーザー本文のコピー操作は本文下のアイコン行へ移動し、成功／失敗表示は表示言語に合わせる。
- terminalErrorがreplaceChildrenで消えていたため修正。ファイル変更なしでも取得エラーを表示する。
- 実推論テストのモデル指定をCodexはgpt-6-luna、Cursorはcomposer-2.5へ統一。ACPでoptions.modelをCLIへ渡していなかったため、--modelを追加した。
- `npm run check`、`npm test`（109件）、`npm run test:integration`成功。結合テストはDefault削除で最初の項目が変わるため、余分な下移動を削除した。GUIでの配置の目視受入は今回未完了。
- App Serverライブ: gpt-6-lunaの2子が約10秒ずつ実行され、開始／終了区間が重複し、親のrunが両者の終了後に戻ることを確認。Background Terminalはstdout／stderr、自然終了、別会話へ移動した後の元会話への更新、明示停止が成功した。
- Cursor SDKライブ: composer-2.5を指定し、実Taskのrunning→completedと子shell出力の最終回答への到達を確認した。
- ACPライブ: composer-2.5を--modelで指定しても、子イベントのモデルはcomposer-2.5-fastだった。Taskの完了と親への復帰は観測したが、指定モデルで子が動いたとの合格には含めない。再開／結果取得に同じagentIdで別toolCallIdが来るため、複数カードになるケースも観測した。バックグラウンド起動直後のTask応答時間を子の実作業時間と同一視しない。
- 子の表示は現在、名前・状態・タスク・結果プレビューまで。メインと同様の子専用トランスクリプト画面は未実装。バックグラウンドターミナル出力のDOM表示と実出力更新はそれぞれ自動／ライブで確認したが、今回実ターミナル表示の目視確認はしていない。
- 指定参考画像はDocumentsのmacOSアクセス制限で読めず、許可付きcpもOperation not permitted。画像との一致は未確認。


### 2026-10-17 参考画像の確認後

プロジェクト直下へ置かれた「スクリーンショット 2026-10-17 9.13.12.png」を読み取り、ユーザー本文下は右揃え、回答本文下は左揃えの操作行に合わせた。行の余白、角丸、28pxのアイコン領域を統一した。ユーザー側の編集アイコンは元の本文を入力欄へ戻してフォーカスする。送信や過去のメッセージの書き換えは行わない。画像にある共有・読み上げは既存機能にないため追加していない。画像が読めなかった前節の制約は解消したが、更新後の実GUI目視確認とは区別する。


### 2026-10-17 バックグラウンドターミナルのパネル表示

参考画像「スクリーンショット 2026-10-17 9.28.04.png」を確認。入力欄直上の折りたたみ一覧とチャットヘッダーのターミナルメニューから、VS Code下部のTerminal PanelにPseudoterminalを開く。同一セッション・同一processIdの再クリックは同じタブを再表示し、コマンドの再実行や追加推論はしない。出力は元セッションから購読し、累積snapshotの差分を表示する。タブを閉じる操作は表示の切り離しのみで、停止操作とは分けた。

- VS Code実Extension Hostでターミナル生成、同一タブの再表示、sendTextによるCtrl+C入力、閉じても停止APIを呼ばないことを確認した。
- App Serverの実gpt-6-lunaがtty付きで起動したPythonバックグラウンドプロセス（processId 77763）に接続し、ATTACH_READYの表示、Ctrl+C入力からランタイム停止、元プロセスの終了通知を確認した。
- OS PIDはプロトコル上nullableで、この実ランタイムでも公開されなかった。そのためSIGINT送信案は採用せず、Ctrl+Cは公開thread/backgroundTerminals/terminateへ接続している。これはSIGINTハンドラー実行の保証ではない。
- 現在ターミナル一覧・出力を提供しているのはCodex App Server経路。Cursor ACP／SDKとCodex SDKへの同等接続は未実装で、この機能のライブ検証成功に含めない。
- 任意の文字入力・PTYリサイズ・対話シェルへの完全なattachは公開APIにないため未対応。ターミナル内にも文字入力転送が未対応であることを表示する。別の無関係なシェルを開いて接続済みと見せることはしない。


### チャット内ターミナル表示の維持

パネル表示追加時に外してしまった入力欄直上の出力プレビューを復元。チャット欄でコマンド・状態・最新出力・取得エラーを確認でき、同じ行のクリックでTerminal Panelも開ける。パネルを開いた後もチャット内の出力表示を維持する。


### 0.9.1: 実画面で一覧が出なかった原因とCursor SDK修正

ユーザーの実VS Code画面をAXで確認した。インストール済み0.9.0のextension.js・main.js・CSSはソースからビルドしたものと一致していたが、会話はCursor SDKでありterminal一覧が空だった。App Serverだけに実装した一覧をCursor SDKにもあると誤認してはならない。

Cursor SDK 1.0.37の実記録では、背景sleep 120は開始約1.2秒後にstatus abortedとなっていた。モデルの「実行中」という回答やShellのsuccessだけをプロセス状態に転用しない。SDKはturn完了時にruntimeをdisposeし、背景shellも中断する挙動をライブで確認した。このライフサイクル自体は本変更では差し替えていない。

修正は以下の通り。

- SDKの実プロジェクトterminalログを100ms間隔で読み、実プロセスがこのワーカーの子孫である間にのみ所属を確定する。会話外のログ・古い記録・PIDだけの主張からは登録しない。
- 所属確定後はSDKのstatus、stdout/stderr、終了コードを元会話へ送る。親ターン後もworker IPCの背景通知を配送し、終了・中断の記録を一覧に残す。
- SDKはこの記録の保存先にCURSOR_DATA_DIRを使用しないことを同梱コードで確認した。環境変数で分離したつもりにせず、実際の保存先とプロセス系譜を使う。
- 現在は未公開のSDKファイル形式への依存がある。対応確認バージョンは1.0.37。形式不一致は表示不能として扱い、推測したプロセスを操作しない。
- SDKのCtrl+Cは所属を再確認したプロセスのSIGINT。文字入力転送は引き続き未対応。中断済みの行は停止ボタンを無効化する。
- Composer 2.5ライブで実Python背景実行の出力とcancelled状態が親ターン後も取得できることを確認した。自動回帰では入力欄直上とヘッダーに中断済み状態が残ることも確認した。


0.9.1の最終確認: 型チェックと自動テスト119件が成功。通常のExtension Host結合テストに加え、検証専用VS Code 1.142.0でComposer 2.5を実行し、AXとスクリーンショットで次を確認した。入力欄の直上に「1 Background terminals」、実Pythonコマンド、cancelled、TERMINAL_UI_READYと終了記録が表示される。ヘッダーにも「1 Background terminals」ボタンがある。一覧のコマンドをクリックすると下部のAI Agentsターミナルが開き、同じ出力とProcess exitedが表示された。長いコマンドで状態が省略されないよう、最終調整で状態ラベルを分離した（この調整はDOM回帰で確認）。モデル名の後ろに残っていた不要なDefault表示も削除した。


### 0.10.0: Cursor SDK背景プロセスの寿命修正

0.9.1で観測したターン終了時の中断を修正。SDKのnative背景executorを会話workerで保持し、自然終了・明示停止・会話dispose時に解放する。SDK 1.0.37の元ソースhashと置換数を検証する互換アダプターを同梱した。

- Composer 2.5の実背景Pythonで親の返答後もrunningを維持し、120秒後にDONE、exit_code 0、elapsed_ms 120226で自然終了した。
- 追加ターンを送っても同じ背景プロセスが生存。TerminalMonitorのCtrl+Cからnative managerで停止し、cancelledへ更新した。
- 会話disposeで実PIDが消えることと、二重disposeが成功することを実プロセスで確認。
- VS Code 1.142.0の実Extension Host結合テスト成功。実GUIのAXで、親がReadyになった後も入力欄直上の背景一覧にrunningとTERMINAL_UI_READYが表示されることを確認。行クリックで下部のAI Agentsターミナルが開いた。GUIの物理キー入力によるCtrl+Cは今回の追加検証に含めない。
- 任意の文字入力転送は引き続き未対応。通常のforeground shellを背景一覧へ登録しない。

最終確認: `npm run check`、`npm test`（122件）、`npm run package`が成功。0.10.0 VSIXに互換SDKランタイムとLICENSEを同梱。


<a id="final-audit"></a>
## 2026-10-17 最終再監査（現行未コミットツリー）

開始HEAD/変更/追加修正は[AUDIT.md](AUDIT.md)先頭を参照。過去ログを今回の合格として再利用していない。実行ログと受入要約はローカルの検証出力であり、クリーンなテスト実行には不要である。

- 型チェック成功、単体156/156成功（開始時144/144）。追加回帰は修正前の失敗を確認してから修正。DOMは30件を含む。
- build成功。通常Extension Development Host結合成功。Retry準備返信と自動実行なしのHost検査も追加した。
- protocol 2/2成功。コマンド名に反し実際にpong推論を含むため「推論なし」とは記録しない。
- live 6/6成功。4経路3ターン・Stop・再開、provider切替、ACP専用3ターンのBackend final/Controller本文一致。
- tools 5/5成功。4経路の隔離Git編集、対話Backendで承認拒否/許可、原文復元。追加App ServerのPlan→改訂→Buildで禁止ファイルなし、原文不変→実編集、同一session。
- reliability Host: 4経路すべて3ターン各final確認→別会話→履歴復帰→Hostプロセス終了→同profile再起動で全3finalとUsage復元→4ターン目成功。通常の手操作Reload Windowとは分ける。
- package成功。0.10.0 darwin-arm64、1658ファイル、137.6 MB。最新成果物の整合性を別途記録。

### 実GUI（Cuaによる実Extension Development Host）

インストール済みCodeと検証用Codeが同じbundle IDで曖昧だった。最初の通常アプリは空windowしか見えず、検証専用 `.vscode-test/.../Visual Studio Code.app` の絶対パスで対象を分離するとAX/画面/クリックを取得できた。GUI不可の前回制約は部分解消。

1. fixture SDKの実サイドバー: Assistant Copy→ComposerへCmd+V、Copiedと日本語原文一致を確認。Unicode複数行をsetValueで確認してからSendしUser/Assistant双方に表示。native typeTextではUnicodeが欠けたため、それをIME合格とは扱わない。
2. 300px/390px相当: Retina画像でActivity Bar後のサイドバー幅600px/780px（sash除く）を確認。Dark（Abyss）とLight Modern各幅でヘッダー、折返し、Copy、Usage、下部Composerを目視。モデル一覧・検索・現在選択を操作。
3. fixtureのCodex SDKモデル変更は新会話確認ダイアログをVS Codeのextension test modeが拒否した。UI値は旧モデルを保持しエラー表示。実モデル変更成功扱いには含めない。
4. test mode外の隔離profile/一時Git workspaceで実Codex App Server GPT-6-Lunaを使用。初回GUI_LIVE_ONE、継続GUI_LIVE_TWO、Running→Ready、モデル/モードの実行中無効化、Usage表示を確認。
5. 実Planメニュー→計画のみで停止、Ready to build、対象gui-check.txt不存在をfilesystemで確認。Buildモデル一覧はBackend実在モデルを表示、GPT-6-Lunaを選択しBuildクリック。Build finished、Agent(Default)復帰、Files +1 −0、実bytes `GUI_BUILD_OK\n`を確認。
6. 実背景PythonをGUI起動。親Ready後もrunning、同じprocess ID90028の行からTerminal Panelを開き、接続ヘッダー・未対応文字入力の案内を確認。初期stdoutがPanelへ出なかったため追加調査（成功扱いせず）。90秒後に保存toolはexit0・GUI_BG_READY/GUI_BG_DONE両方を保持。
7. 通常開発Hostを同profileで再起動、Back→履歴の同会話を選択し5turn・2回答・Plan/Build・Usageを実画面で再表示。

実GUIは全4経路の全項目完了ではない。Copy failureはDOM、auth failureは隔離fixture、モデル変更失敗はfixture/IPC、実ネットワーク断・実認証失効の4経路網羅は未実施。OS IME変換、実画像paste/画像Retry、全Plan経路の失敗/Stop、子専用詳細、背景中Reloadと副作用は未検証。代替自動試験と混同せず、現時点はv1.0.0 **No-Go**。

### Background Terminal追加検証

App Serverの「processIdなしstarted→outputDelta→listがitemId/processId広告」で既受信出力を捨てる順序バグを修正。修正前fixture失敗、修正後protocol/TerminalMonitor回帰成功。

ただしno-tty実CLIでは、初期printが公開outputDeltaにも一覧にも来ず、自然終了時のaggregatedOutputでREADY/DONE全文が初めて揃う挙動を確認した。修正後も初期stdout=false、最終全文=true、exit0=true。Backendが配信していない初期出力を推測生成・別process attach・自動write_stdinで補っていない。TTYありのライブattach成功と区別し、リアルタイム出力の制限として残す。合成イベントでこの欠落を埋めて成功扱いにしない。

### 実GUI追加範囲

- Cursor SDKへprovider切替、実カタログからComposer 2.5を選択。CURSOR_GUI_ONE/TWOの2回答、sleep要求中のStop→Ready→同会話へAFTER_STOP_GUIの実回答を確認。
- 実App Serverでalpha/betaの2子をGUI起動。running表示を確認後、完了した実ID・14s/13s・実結果（alpha/alpha、beta/beta）を保持。コマンドパレットのDeveloper: Reload Windowを実際に実行し、履歴から同会話を選択して2子のcompleted・Plan/Build・Usageを再表示。プロセス再起動harnessとは別の手操作検証。
- CodexのBackend設定をSDKへ変更し新会話、GPT-6-LunaでCODEX_SDK_GUI_ONEの実回答を確認。
- 全4経路の全GUI機能・OS IME・実画像Retryの合格を意味しない。

### ランタイム試験の失敗を合格に含めない

初回App ServerのPlanとparentStopは公開backend実行記録に`usage_limit_exceeded`、Assistant本文なし。途中中断した初回suiteを合格には含めない（安全な要約`runtime-quota.json`）。再試験でApp Server Plan/Build・parentStop成功を確認したが、ACPの並列2子は200秒run timeoutで失敗。通常チャット・ACP Plan/Buildの成功と、子並列試験の失敗を分ける。期待値の緩和/skip化はしていない。最終suite件数と原因はruntime-final.logへ残す。

最終 `npm run test:runtime`: **11 passed / 1 failed / 0 skipped**、538秒。失敗はACP実並列子のrun TimeoutError（200秒deadline、case全体208,542ms）。対応3経路Plan改訂/Build、App Server親Stop、Cursor SDK子/背景120秒自然終了/追加turn/Ctrl+C/disposeは成功。過去の12/12と区別し、今回を全成功にしない。実装側原因はこの時点で未確定で、未解決のライブ信頼性リスクとしてNo-Go理由に含める。

### ACP GUIのBackend原文照合

ACP Agentモードの実GUIでACP_GUI_ONEを確認。2ターン目のuser本文は`Reply exactly ACP_GUI_TWO. Do not use tools.`、画面のfinalは`ACP_GUI_THREE`だった。新しいStdioJsonRpcから当該session `84565aea-92d1-40f4-a65d-754ba119b806` の公開session/loadを直接実行し、raw user_message_chunk=要求TWO、agent_message_chunk=THREEと確認した（`acp-gui-replay.json`）。画面取り違え/Thought転用ではなくBackendが返した本文を表示している。要求語への意味的正解とは扱わず、出力を補正生成していない。

Codex SDKは実GUIでCODEX_SDK_GUI_ONE/TWOの両回答を確認。4経路とも実GUIで送信・非空finalに到達したが、モデル意味的誤答・ACP子timeoutと未実施の全機能操作を含めて無条件Goにはしない。

ACP GUIの3ターン目は実Askへ変更し、ACP_GUI_ASK_FINALの要求どおりのfinal、Ready、Ask表示を確認。2ターン目のBackend誤答の記録は残す。最終VSIXはextension/worker/webview JS・CSS・patched runtime・LICENSE・CHANGELOGのbuild/source一致、manifest0.10.0と固定SDKをzipから検査（vsceはchangelog.mdへ正規化）。SHA256はローカルの検証出力に残した。最終git diff --check成功、HEAD不変、変更は未コミット。


### 過去プロンプトの編集・巻き戻し・再実行

2026-10-17の未コミット作業ツリーで実装と検証。既存のRetryとは独立したターン巻き戻し操作として追加した。

- 送信済みUserメッセージをその位置で編集し、添付を保持したままキャンセル／再送できる。再送時は確認UIに元プロンプト・編集後プロンプト・削除される古い応答と後続ターン数・対象ターン以降のファイル変更を実行前の状態へRevertすること・復元対象ファイルを明示する。
- Codex App Serverで取得できた実Backend turn IDを使い、公開`thread/fork`の`beforeTurnId`と`excludeTurns`で対象Userターンより前の会話から分岐する。古いsession writerを別App Server processで開かないよう、同じconnection上で分岐IDへ切り替える。分岐後に旧sessionのイベント／子／terminal snapshotを引き継がない。
- 対象ターン前後の完全な小サイズテキストファイルcheckpointとモードを保存し、同じワークスペース実体・現在内容・既知のターン後状態を照合してから復元する。失敗時は一時journalとバックアップで戻す。1ファイル500,000 byte、1ターン2,000,000 byte、会話合計8,000,000 byteを上限とする。
- Cursor SDK、Cursor ACP、Codex SDKは公開APIで任意ターンの安全な履歴分岐を確認できず、ローカル表示履歴からモデルコンテキストを再構築しないため、この操作を無効にする。Codex App Serverでも履歴・Backend turn ID・完全checkpointが揃わなければ無効にする。

#### 検証結果

- `npm run check`: 成功。
- `npm test`: 161/161成功。既存テストに加え、中間ターンで同一ファイルの複数回変更と新規ファイルを巻き戻すケース、checkpoint不足と競合のfail-closed、複数ファイル復元途中の失敗後に既復元ファイルを戻すケース、inline editor／添付保持／キャンセル／Resendの分離を確認。
- `npm run test:protocol`: Cursor CLIとCodex App Serverのprotocol検査2/2成功。`npm run test:live`: 4経路の推論・ACP final表示検査6/6成功。これらは任意ターン巻き戻しのライブ対応を意味しない。
- 実Codex App Server GPT-6-Lunaを使った隔離Git workspaceの実GUI Test A: `touch a.txt`→`abcd`を書き込み→2番目のUserメッセージを`1234`へ編集。確認後にbranchへ切替、復元完了後の`a.txt`が空であることを実行中に確認し、新しい応答で`1234`になった。旧`abcd`のUser／Assistantは表示とbranchのローカル履歴から消えた。実Backend session IDも変わった。
- 実Extension Development Hostのmock App Server UI統合試験も成功。編集アイコン→inline editor→`write 1234 into a.txt`→再送確認→履歴分岐→Readyまで操作し、一時workspaceの`a.txt`が`1234`、旧turn IDが履歴にないことをassertした。VS Code test modeではnative warning dialog APIが使えないため、このハーネスに限り同じ警告本文を表示するQuickPickへ差し替えて確認操作を行った。productionの確認UIのOS描画はこのハーネス検査に含めない。
- Extension Development Hostで300px／390px相当、Light Modern／Darkテーマの組み合わせを画面で確認。inline編集とキャンセルで元本文が保たれることも実GUIで確認した。

#### 非対応・未検証範囲

- 実Backendのライブ検証はTest Aのみ。Test Bの後続複数ターンは単体試験、Test Cのユーザー未コミット変更保護とTest DのBackend文脈検査はライブでは未実施。4経路すべてでの編集動作を確認したとは扱わない。
- rename、binary、500,000 byte超、symlink経由、workspace外、ワークスペース移動、ファイルcheckpoint不足、手動編集／外部変更の競合、履歴保存無効、画像を再取得できない旧promptは巻き戻しを拒否する。空ディレクトリやファイル外への副作用は復元しない。
- 実行中turn、queue、保留中の承認／質問／plan、稼働中の子エージェントやBackground Terminalがある会話は巻き戻しを拒否する。既存の子・terminalを停止して巻き戻す処理は実装していない。
- Retryの意味は変更していない。Plan/Todo/Usage/turn/file-change/terminal/subagent状態はローカル履歴で対象境界へ切り詰める。外部side effect、旧Backend threadの物理削除、過去分岐の完全なGCは保証しない。
- `docs/AUDIT_0100.md`はローカルに存在しない。既存のNo-Go項目と区別してこの限定対応をFeature Matrixに記録する。Commit、Push、Releaseは実施していない。
