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

実イベントの抜粋は [runtime fixture](../test/fixtures/real/runtime-090.json)、正規化したライブ結果は [runtime evidence](evidence/runtime-090.json) に保存した。テストプロンプトと必要イベントだけを残し、個人の一時パスは `/verification` へ置換した。認証情報は含めていない。

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

保存先と各条件: [screen manifest](screenshots/0.9.0-host/README.md)。ブラウザの UI mock ではない。

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
