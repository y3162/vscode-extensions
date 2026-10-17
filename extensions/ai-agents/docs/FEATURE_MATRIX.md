# 0.10.0 再監査による更新（2026-10-17）

以下の表の旧版記述より、今回の [総合監査](AUDIT.md) と次の更新を優先する。

| Feature | 現行の対応と制限 |
| --- | --- |
| Cursor ACP最終回答 | 純粋deltaとして連結。正常prompt終了でfinalを明示し、復元時にも各ターンfinalを保持 |
| Cursor ACPモデル変更 | 起動`--model`とは別に、sessionが広告したcanonical variantへ`session/set_config_option`。応答currentValueを検証してからUI確定。未広告モデル/parametersは拒否。旧CLIは利用可否を実応答で検証 |
| Workerモデル変更 | client / worker / controllerがackを待つ。IPC失敗を握りつぶさず、UIだけ変更しない |
| Plan / Build | Cursor SDK / ACPとCodex App Serverで初回→改訂→同じ会話のBuildを今回ライブ再確認。Codex SDKには公開Plan modeなし |
| Debug / Multitask | 当該ACPで拒否。interactive CLI `/debug`の存在とACP/SDK API対応を混同しない。疑似ラベルなし |
| 子・Terminal | 実2子並列・親Stop後更新・実測model・自然終了/明示停止/別会話更新/SDK cleanupを今回ライブ確認。未公開値は補完しない |
| UI品質保証 | 今回実GUI 300/390px Dark/Light・Copy・複数経路送信・App Server Plan/Buildを確認。全GUI受入は未完了。中央Composer/editorは対象外 |

v1.0.0判定は **No-Go**。以下は過去の分類・検証記録。

---

# Feature Matrix

調査日: 2026-10-16。対象バージョンは `@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`、`@openai/codex@0.162.1`、参考実装 `yutat23/cursor-agent-sidebar` v0.3.7 です。

状態の意味: Implemented は完成済み、Partial は一部、Missing は未実装、SDK-native はランタイム側、VSCode-native は VS Code API、Unsupported は公式 API で利用不可、Defer は今回の範囲外です。

既定の通信は従来どおり SDK です。対話型の承認や Codex のレビューは、サイドバーのバックエンドで ACP または App Server を選んだときだけ有効になります。これは既存の SDK 経路とテストを壊さないためです。

| Feature | Category | Phase | Reference | Cursor | Codex | Runtime | SDK / Protocol | VS Code | Extension | Status | Decision | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| チャットUI | Common | 1 | Secondary sidebar、Markdown、ツール折りたたみ | 共通UI | 共通UI | なし | ストリーミングイベント | Webview | ヘッダー、下部 Composer、ターン描画 | Implemented | Implement | `src/webview`, `src/sidebar.ts` |
| プロバイダー切替 | Common | 1 | Cursor のみ | SDK / ACP | SDK / App Server | なし | セッション作成 | 設定 | 切替とセッション破棄 | Implemented | Implement | `ChatController.select` |
| モデル選択 | Common | 1 | Composer の階層メニュー | `Cursor.models.list` | App Server `model/list` | カタログ | 一覧API | Quick Pick はコマンドから残す | Webview で検索して選択。ACP はモデルを送らないため Composer には出さない | Implemented | Implement | `src/webview/composer.ts`, `src/sidebar.ts` |
| モデル詳細 | Common | 1 | Effort / Context / Fast を階層で表示 | parameters / variants。次の `send({ model })`。SDK カタログに `composer-2.5` はある。`composer-2.5-fast` は CLI 一覧にはあるが SDK 一覧には無い | reasoning effort。App Server は `turn/start` の model / effort。SDK はスレッド再開時 | 推論設定 | 作成時または次の送信 | Quick Pick はコマンドから残す | App Server は会話を閉じずに次の送信へ反映。ACP はモデルを送らない | Implemented | Implement | `src/model-settings.ts`, `src/providers/models.ts` |
| 動作モード | Common | 1 | agent / plan / ask | SDK は agent/plan、ACP は ask も可。`session/new` の mode は無視されることがあり、その後 `session/set_mode` が必要 | App Server は default/plan をターンごとに明示 | モードの実行 | `mode` / `collaborationMode` / `session/set_mode` | Plan View とモード | Plan は計画後に停止し、Build で Agent へ進む | Implemented | Implement | `src/plan-state.ts`, `src/providers/plan-policy.ts` |
| ストリーミング | Common | 1 | chunk 描画 | assistant / thinking / tool | item delta と item snapshot | 生成 | stream / JSON-RPC | Webview | 同一IDの置換 | Implemented | Implement | `ChatController.send`, `providers/events.ts` |
| Markdown | Common | 1 | 独自パーサとハイライト | テキスト | テキスト | なし | なし | なし | DOM生成。HTMLは解釈しない | Implemented | Implement | `src/webview/markdown.ts` |
| 入力キュー | Common | 1 | Queue / Send now / Stop保持 | 拡張機能側 | App Server は steer も可 | なし | `turn/steer` は App Server のみ | なし | Stop ではキューを残す | Implemented | Implement | `ChatController.enqueue`, `test/queue-and-review.test.ts` |
| セッション一覧・再開 | Common | 1 | ACP list/load と SQLite 解析 | SDK `Agent.list/resume`、ACP `session/list/load` | SDK `resumeThread`、App Server `thread/list/resume` | 永続化 | 各プロトコル | なし | 公式APIと拡張機能が作った索引。内部DBは読まない | Partial | Implement | `openSession`, `refreshSessions` |
| 日本語・英語 | Common | 1 | 独自 ja/en | 共通 | 共通 | なし | なし | `vscode.env.language`, `package.nls` | Webview と新規コマンド | Implemented | Implement | `package.nls.ja.json`, `src/webview/strings.ts` |
| テーマ追従 | Common | 1 | `--vscode-*` | 共通 | 共通 | なし | なし | CSS変数 | 既存方針を維持 | Implemented | Skip | `src/webview/styles.css` |
| `@file` / `@folder` | IDE | 2 | ワークスペース検索 | プロンプトへ展開 | 同左 | モデルが読む | なし | `findFiles` | ワークスペース外は拒否 | Implemented | Implement | `src/context-text.ts`, `src/vscode-context.ts` |
| 選択範囲・問題・Git差分 | IDE | 2 | なし、または限定的 | プロンプトへ添付 | 同左 | なし | なし | Diagnostics / git | 拡張機能がテキスト化 | Implemented | Implement | `vscode-context.ts` |
| ターミナル出力 | IDE | 2 | なし | 最近のコマンドのみ | 同左 | なし | なし | Shell integration | 画面バッファは API 非公開 | Partial | Integrate | `watchTerminals` |
| 画像 | IDE | 2 | 貼り付け | SDK は base64、ACP は image block | SDK / App Server は一時ファイル | 画像入力 | `images` / `local_image` / `localImage` | なし | 4枚・5MB・許可MIME | Implemented | Implement | `src/images.ts` |
| 差分表示 | IDE | 2 | `vscode.diff` と変更前テキスト | ツール開始時のbaseline、または diff | 変更イベントの path / diff | ファイル書き込み | tool / file_change | Diff Editor | 一時baselineを開く | Partial | Implement | `writeBaselineFile`, `reviewFile` |
| ファイル復元 | IDE | 2 | 変更前テキストの書き戻し | baseline があるとき | baseline または `git apply --reverse` | なし | Codex `thread/revert` は会話のみ | ファイルAPI | realpath でワークスペース外を拒否 | Partial | Implement | `src/change-review.ts` |
| サンドボックス設定 | Common | 3 | CLIフラグ | `sandboxOptions.enabled` または `--sandbox` | `read-only` / `workspace-write` / `danger-full-access` | OSサンドボックス | 作成時オプション | 設定UI | 変更すると新しい会話 | Implemented | Implement | `capabilitiesFor` |
| 承認ポリシー | Common | 3 | 3段階承認 | ACP は要求ごと。SDKは対話不可 | App Server は untrusted/on-request/never。SDKは never のみ | 判定 | permission RPC | カードUI | 未対応ポリシーは App Server へ案内 | Implemented | Implement | `requestPermission` |
| 自動承認 | Common | 3 | 設定と確認 | ACP / SDK 共通の拡張機能設定 | 同左 | なし | なし | 確認ダイアログ | 既定オフ。サンドボックスとは別 | Implemented | Implement | `ai-agents.autoApprove` |
| MCP / Skills / Rules | Common | 3 | スラッシュ展開 | SDK は `settingSources: project,user` | App Server は `skills/list` と `instructionSources` | 読み込みと注入 | 設定ソース / RPC | ファイル一覧 | 秘密情報は表示しない | Partial | Integrate | `instructionSummary` |
| TODO / 計画 | Common | 3 | plan card。update_todos は未接続 | `updateTodos` / ACP `cursor/create_plan` | `todo_list` / plan notifications | 計画生成 | イベント | カード | 承認は ACP / App Server | Partial | Implement | `cursor-acp.ts`, `codex-app-server.ts` |
| トークン使用量 | Common | 3 | 非公式ダッシュボードAPI | SDK `usage` イベント | SDK `turn.completed`、App Server token usage | 計測 | 公式イベント | 表示 | Keychain や私設APIは使わない | Partial | Implement | `providers/details.ts` |
| レート制限 | Codex | 5 | なし | SDKに課金APIはあるがクラウド中心 | App Server `account/rateLimits/read` | アカウント | RPC | 表示 | App Server 選択時 | Partial | Implement | `rateLimits()` |
| ターンチェックポイント | Common | 3 | ターン直前・直後のファイルsnapshot | baselineのみ | App Serverの完全なターン変更イベント | 保存済みテキスト / mode | App Serverのprefix fork + ローカル履歴snapshot | conflict検査とjournal rollback | 対応外ファイルや競合ではfail-closed | Partial | Implement | `turn-rewind.ts`, `chat-controller.ts` |
| Git worktree | Common | 3 | なし | `cwd` として利用 | 同左 | なし | `cwd` | フォルダ選択 | ワークスペースフォルダを選ぶ。worktree作成はしない | VSCode-native | Defer | ワークスペースAPIで足りる |
| 並列セッション | Common | 3 | SessionRegistry。実行中に別チャットを開ける | 同左。上限は busy な会話数 | 同左 | 複数エージェント | セッションAPI | Home の activity | 既定 3、親ターンのみを数える。子・ターミナル稼働中の会話を表示切替で破棄しない | Partial | Implement | `session-registry.ts` |
| コードレビュー | Codex | 5 | なし | 差分を添付して依頼 | App Server `review/start` | レビュー | RPC | なし | SDKでは差分添付にフォールバック | Partial | Implement | `ChatController.review` |
| ACP独自イベント | Cursor | 4 | permission / plan / question。task と generate_image は未接続 | ACPが配信 | なし | ツール | JSON-RPC | カード / 状態 | task は表示。画像生成はパス表示 | Partial | Implement | `src/providers/cursor-acp.ts` |
| Cursor SDK設定 | Cursor | 4 | なし | rules/skills/hooks/mcp を `settingSources` で有効化 | なし | 読み込み | SDK | なし | クラウド起動ボタンは置かない | Implemented | Implement | `providers/index.ts` |
| Cloud / Background | Cursor | 4 | なし | SDKは対応 | 別製品 | リモートVM | SDK cloud | なし | 課金が発生するためUIは未接続 | SDK-native | Defer | ユーザー確認が必要な課金操作 |
| Codex sandbox / network / search | Codex | 5 | なし | なし | SDKフラグと App Server config | 強制 | `sandboxMode`, `networkAccessEnabled`, `web_search` | 設定UI | オフはランタイム既定のまま | Implemented | Implement | `SessionOptions` |
| コンテキスト圧縮 / fork | Codex | 5 | なし | なし | App Server `thread/compact/start`, `thread/fork` | 圧縮 | RPC | コマンド `/compact` | SDKでは不可と表示 | Partial | Implement | `codex-app-server.ts` |
| 送信済みプロンプト編集 | Common | 3 | メッセージ上のinline editor | 非対応 | SDK非対応、App Server paginated historyのみ | 新規branch | `thread/fork`のbeforeTurnId | inline editorと再送確認 | Codex App Serverの完全なcheckpointのみ有効 | Partial | Implement | `transcript.ts`, `providers/codex-app-server.ts` |
| IDE補完 / 意味検索 | IDE | 6 | なし | 別API | 別API | 補完モデル | なし | Inline API | エージェント統合とは別 | Missing | Defer | 追加の推論基盤が必要 |

検証欄は `docs/VERIFICATION.md` にまとめます。

### 0.9.0 実機追記（2026-10-16）

| 対象 | 実機結果 | 制限 |
| --- | --- | --- |
| App Server 子エージェント | 実子ID 2 件・並列区間・成功結果を確認。親終了後は通知と公開 `thread/read` で状態を更新 | 親 Stop は子 Stop の保証ではない。未確定状態は unknown / running を維持 |
| Cursor ACP Task | ID 付き要求へ応答し、実 agentId・モデル・処理時間を保持。2 件の区間重複を確認 | モデル選択はランタイム既定のまま |
| Cursor SDK Task | 通常 Node / Extension Host とも sandbox 非対応で停止 | 並列、子別モデル、継承、Foreground / Background 結果返却は未検証 |
| App Server Background Terminal | 非空一覧、2 秒更新、自然終了・最終出力、terminate を実機確認 | `process/spawn` による代用なし。取得失敗は既存情報を保持 |
| Plan / Build | 対応 3 経路で初回・改訂・同一会話 Build・重複防止をライブ確認 | 失敗 / Stop の全 3 経路ライブ再現は未完了。状態回帰テストとは区別 |
| 差分 / 復元 | Codex の Git baseline、App Server 実 Rename と未コミット原文の復元を確認 | 不明な原文は復元不可。シェルの unstaged move は delete / add の場合あり |

移行判断は **Not Ready**。詳細・画面・残作業は [VERIFICATION.md](VERIFICATION.md) の今回追記を参照。

### 0.9.0 チャット信頼性修復（2026-10-17）

| 経路 | 新規・継続・Stop | 表示履歴 | Usage | 制限 |
| --- | --- | --- | --- | --- |
| Cursor SDK 1.0.37 | sandbox有効で専用プロセス経由 | ローカルsnapshot + 公開messages/run API | Run / 会話、cache別枠 | context windowは未取得 |
| Cursor ACP | 実CLIで確認 | snapshot + session/load再生 | 非対応 | 未広告のsession/resumeは呼ばない |
| Codex SDK 0.162.1 | 実CLIで確認 | snapshot | 累積snapshotと差分 | 保存前の旧会話本文は公開SDKから取得不可 |
| Codex App Server 0.162.1 | 実CLIで確認 | snapshot + 公開turnページング | total / last / cache / reasoning / context | lastは直近リクエスト。Turnは累積差分 |

Copy・表示履歴・可視Usageは実装済み。自動テスト・実Extension Hostのプログラム操作と、目視／手操作の完了は区別する。今回のGUIアクセス拒否により、テーマ別・幅別の実画面撮影は未検証。詳細はVERIFICATION.md。


## 最終再監査の対応表（2026-10-17）

| 経路 | 会話・履歴 | モード/Build | モデル設定 | Usage / 子 / 背景Terminal |
| --- | --- | --- | --- | --- |
| Cursor SDK 1.0.37 | 3turn/Stop/resume/Host再起動成功。ローカル表示＋公開API | Agent/Plan。同会話改訂/Build | ACK後に確定、次sendへ実設定 | Usage対応、Task実データ、hash固定executor。context未取得 |
| Cursor ACP | 3turn明示finalと表示本文一致、load/Host再起動成功 | Agent/Plan/Ask。再開Agentも明示set_mode | 広告されたvariantのみ変更、ACK検査 | Usage非対応、実子、Terminal一覧非対応 |
| Codex SDK 0.162.1 | 3turn/Stop/resume/Host再起動成功。本文はローカル表示保存 | Agentのみ、Plan非対応 | 変更時は確認後に新会話 | Usage対応、対話承認/子追跡/背景Terminal非対応 |
| Codex App Server 0.162.1 | 3turn/Stop/resume/公開履歴final/Host再起動成功 | Agent(Default)/Plan。read-onlyとBuild元権限復帰 | 次turnへmodel/effort | Usage/実子/背景Terminal対応。任意stdin/resize非対応 |

Debug/Multitaskは広告・実行対応がなく追加しない。未取得数値を0で埋めない。画像only送信・Queue・Retryは追加修正/Controller・DOM検証済み、実GUI画像試験は未完了。300/390px Dark/Light実画面と実App Server Plan/Buildは今回確認。全4経路のGUI受入が残るためNo-Go。中央Composer・新規Agent editorは依頼の対象外。

App Server no-tty背景コマンドでは公開通知/一覧が初期stdoutを配信せず、終了時aggregatedOutputで全文を取得する場合がある。リアルタイムの完全な初期出力を保証しない。既配信bufferのitemId結合は修正・回帰検証済み。この制限は合成イベントでは再現せず、Live Testの結果と分ける。
