# Cursor 参照調査（2026-10-28）

対象は公開リポジトリのソースと、Cursor 2.6.22 の workbench バンドルに含まれるクラス名。クローンはリポジトリ外の調査用ディレクトリに置き、第三者コードは取り込んでいない。ローカル Cursor の画面計測は、作業中の IDE を操作しないため未実施。CSS の px 値は実測していない。

証拠の段階:

- ソース: そのファイルに書いてある
- バンドル: `cursor_api_demo` の `reveng_2.6.22/beautified/workbench.desktop.main.js` に文字列がある。実行時の DOM ではない
- 文書: README や設計文書の記述。ソースの該当関数までは追っていない
- 未検証: この環境では確認していない

## リポジトリ

| リポジトリ | ライセンス | 何を見たか |
| --- | --- | --- |
| len5ky/CursorRemote | Source-available（MIT ではない） | DOM 抽出と独自 Web UI を分けて読んだ |
| eisbaw/cursor_api_demo | リポジトリ同梱の表記に従う。コードはコピーしない | 2.6.22 バンドルのクラス名の有無だけ |
| vaughanb/CursorJ | MIT | ACP の Plan、Edit and Resend、`cursor/task` |
| Callum-Ward/cursaves | AGPL-3.0 | 保存形式の文書。実装はコピーしない |
| 0xlane/reverse-cursor-agent | 文書中心 | Turn、Resume、Subagent のプロトコル文書 |
| jdconley/deadhand | MIT | Composer の内部コマンドと SQLite の読み方 |

非公開 API や難読バンドルへの実行時依存は採用しない。セレクタもクラス名も、この拡張の Webview には移植しない。

## Cursor IDE の DOM（CursorRemote の抽出側）

ソース: `CursorRemote/src/discovery/discover-dom.ts` は CDP で workbench を開き、class 名に composer / chat / agent を含む要素を探す発見ツール。決まったレイアウト値は持たない。

ソース: `CursorRemote/src/server/dom-extractor.ts` と `docs/architecture.md`。変更の検出は MutationObserver ではなく、抽出関数のポーリングと、前後状態の JSON 差分（`state-manager.ts`、文書では 300ms debounce）。

メッセージの分類（ソース）:

- ラッパーは `[data-flat-index]`、`[data-message-index]`、`.composer-rendered-message[data-message-role]`、`[data-message-role][data-message-id]`
- `data-message-role=human` かつ `data-message-kind=human` はユーザー
- `ai` / `assistant` はアシスタント本文。本文は `.markdown-root`
- `ai` / `tool` は計画、ターミナル、編集、コンパクトなツールのいずれかに優先して分類する

計画（ソース）: `.composer-create-plan-container`。タイトル、説明、todo、`.composer-create-plan-view-plan-button`、`.composer-create-plan-build-button`。Build はテキストに build を含むボタンを優先する。モデル表示は `.composer-unified-dropdown-model`。

ツール（ソース）: ターミナルは `.composer-terminal-tool-call-block-container`。編集の増減は `.ui-edit-tool-call__additions` / `__deletions`。無いときは `+N` / `-M` のテキスト。状態は `data-tool-status`。思考は `.ui-thinking-collapsible`。

承認（ソース）: `selectors.json` は Run / Allow / Skip 系のボタン。`command-executor.ts` の `clickApproval`、`approveAll`、`reject`、`click_action`。Build と View Plan も `click_action` の対象。

Composer（ソース）: 入力は contenteditable。送信は CDP の `Input.insertText` と Enter。モードは `.composer-unified-dropdown[data-mode]`。モデルは `.ui-model-picker__trigger` または `.composer-unified-dropdown-model`。

バンドル: 上のクラス名（`composer-create-plan-build-button`、`composer-create-plan-view-plan-button`、`ui-edit-tool-call__additions`、`composer-unified-dropdown`、`data-message-role`、`composer-tool-former-message`、`ui-model-picker__trigger`）は Cursor 2.6.22 の workbench に存在する。周辺に padding や font-size は無かった。Build ボタンのハンドラには cloud / background への分岐がある。この拡張の Build はローカルの Agent モードのままにする。

## CursorRemote 独自の Web UI

ソース: `src/client/index.html`、`styles.css`、`app.js`。これは Cursor 本体ではなく、中継サーバー向けの電話 UI。`#messages`、`.human-bubble`、`.assistant-bubble`、`.plan-card`、`#approval-bar` を持つ。色も余白も Cursor の CSS ではない。採用しない。

## CursorJ（ACP）

ソース: `ChatPanel.kt` の `resendEditedMessage`。コメントどおり、agent に `session/fork` は無く、編集再送は新しいセッションへ接頭辞を再投入する。ネイティブ Rewind ではない。

ソース: `AcpSession.kt`。ACP のモードは agent / plan / ask。Plan の本文は `cursor/create_plan` と `.cursor/plans` のパス。Debug は CursorJ が足したシミュレーションで、ACP のモードではない。

ソース: `SubagentTaskEvent.kt`。`cursor/task` の完了は `durationMs` があるときだけ。モデルが送っていない完了は補わない。

この拡張は Cursor を CLI で実行する。接頭辞の再投入はファイルを戻さず、ネイティブ分岐と見せない。今回は実装しない。Codex の `thread/fork` だけを分岐として残す。

## 履歴と checkpoint

文書: `cursaves/docs/how-cursor-stores-chats.md`。会話は UI 側の SQLite。`bubbleId` がメッセージ、`checkpointId` がターンのファイル差分。3.0 以降は一覧が global DB の `composer.composerHeaders` に寄る。checkpoint が無いと agent の継続が失敗することがある、と文書は書く。この環境では DB を開いていない（未検証）。

文書: `deadhand/docs/reverse-engineering/cursor-storage.md`。workspace DB はメタデータ、global DB の `bubbleId` が本文。`fullConversationHeadersOnly` の type 1 が user、2 が assistant、と文書は書く。

ソース: `deadhand/packages/extension/src/cursor-adapter.ts` と `adapters/official.ts`。`composer.getOrderedSelectedComposerIds` をポーリングし、SQLite を読む。このコマンドは Cursor 内部であり、VS Code 拡張の実行経路には使わない。

文書: `reverse-cursor-agent/docs/04-conversation-state.md`。`ConversationAction` に `ResumeAction`、`StartPlanAction`、`ExecutePlanAction`、`CancelSubagentAction` がある。`ConversationStateStructure` は turns、plan、file state、subagent state を持つ。これは CLI と api2 のプロトコル文書であり、サイドバーの実装契約にはしない。

文書: `docs/10-turn-lifecycle.md`。`TurnEnded` はサーバーが送り、ツールが未完了の間は終わらない、と書く。実験ログが根拠で、この環境では再実行していない。

文書: `docs/11-subagent-billing.md`。Task ツールの子は親ストリームの中で動き、子のツール実行は親の exec に混ざる、と書く。クライアントは出典を区別できない場合がある。子の状態を推測で埋めない、という現行方針と一致する。

## 採用した差分

| 機能 | 参照 | 現状 | 今回 | 優先度 |
| --- | --- | --- | --- | --- |
| Chat | CursorRemote の human / assistant 分離。独自 bubble CSS は不採用 | ユーザー面に枠があった | ユーザーは薄い面、回答は地の文。枠は High Contrast のみ | 高 |
| Tool | `data-tool-status` と増減チップ | アイコンのみ | 実行中 / 失敗 / 完了を文字でも出す | 高 |
| Plan | View Plan と Build が別ボタン。未完成の Build は押させない | `canBuild` は既存 | 押せない理由を title と accessible name に出す。クラウド Build は足さない | 高 |
| Approval | Run / Allow / Skip | 許可、セッション許可、拒否 | 選択肢は変えない。Capability が無い経路にはカードを出さない既存動作を維持 | 維持 |
| History | bubble と checkpoint は別。表示と継続も別 | 表示スナップショット未接続 | `history/v1/conversations` に表示専用 JSON。モデルには送らない。本文が取れた再開ではバックエンド本文を優先。実行中ターンは unknown のまま | 高 |
| Rewind | CursorJ は fork が無く再投入。Codex は `thread/fork` | 不能時もボタンが Resend | 不能時は「入力に戻す」で composer へ戻すだけ。分岐は Codex の checkpoint があるときだけ | 高 |
| Image | Composer は contenteditable。Cursor CLI は画像不可 | 添付メニューが常に有効に見えた | `images: false` のとき画像項目を無効にし、理由を出す。ファイル添付は残す | 高 |
| Subagent | 完了は duration があるときだけ | ドックは実行中だけ | ドックのフィルタは維持。完了した子はターン内に残すことをテストで固定 | 中 |
| 幅 | 実測なし。既存仕様の 300 / 390 / 600 | コンテナクエリが 340 / 480 | 300 で折り返し、600 で余白を広げる | 中 |

## 採用しないもの

- CDP、`composer.*` コマンド、SQLite、難読バンドルへの実行時依存
- CursorRemote の HTML / CSS の移植
- Cloud / background Build
- Cursor 向けの偽の fork。ファイルを戻す代替も、ユーザーの変更を壊しうるため今回は足さない
- SDK セッションの復活。`createSession` は `sdk` を拒否する。ACP と App Server のアダプタは削除しない
