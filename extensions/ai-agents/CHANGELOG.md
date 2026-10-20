# Changelog

## 1.0.0 — local release preparation (NO-GO)

- Add profile/workspace/conversation-scoped App Server execution ownership and reconnect without prompt replay.
- Keep Plan details in the sidebar, preserve drafts and explicit Build intent, and retain safe Unknown fallback.
- Preserve explicit Retry as Composer restoration followed by user Send.
- Package the managed worker and reuse the fixed workspace dependency lock.
- Keep parent App Server text and command-output deltas on their own transcript instead of assigning a nonexistent subagent.
- Complete installed-VSIX and live GUI acceptance before publishing.

### Included audit fixes

- Preserve repeated Cursor ACP deltas, final answers, and per-turn answers after session restore.
- Await model changes across worker IPC; apply advertised ACP model variants only after backend acknowledgment and reject uncertain connections.
- Keep Plan / Build model failures and Stop recoverable, and keep asynchronous settings, model selection, and context expansion attached to their originating conversation.
- Enforce read-only, non-escalating Codex App Server Plan turns and restore the exact configured sandbox and approval policy for Agent / Build.
- Correct request-only token totals and restored terminal states; make retained background executor cleanup idempotent and parse CRLF terminal completion.
- Persist cleared Composer drafts and invalidate prompt recall/model catalogs across conversation changes.
- Record current live provider/runtime verification separately from the still-unverified 300/390px Dark/Light GUI checks in `docs/AUDIT.md`.

## 0.10.0

- Keep Cursor SDK background processes alive after the parent response, releasing their native executors after completion or session disposal.
- Route terminal Ctrl+C through the retained native shell manager and make worker disposal idempotent.
- Guard the SDK compatibility adapter by the pinned version and source hash; verify 120-second completion, follow-up turns, interruption, and session cleanup against real processes.

## 0.9.1

- Register Cursor SDK background terminal states from the SDK terminal records, including output and cancellation after the parent turn.
- Forward background notifications and terminal controls through the SDK worker so the composer list and header are populated.
- Verify worker process ownership before reading a terminal into a conversation or sending an interrupt.

## 0.9.0

- Cursor SDKを拡張機能配下の専用プロセスで実行し、Extension Hostからsandbox helperを発見できない問題を修正。sandboxの既定は維持。
- 会話のローカル表示履歴とUsageを永続化し、Home往復・Host再起動後の復元に対応。Cursorの保存メッセージのprotobuf oneof形式を読み、ユーザー・公開Thought・ツール・回答を復元。
- CopyをExtension Hostのclipboard APIへ接続し、Markdown原文・コード・ユーザー本文・ツール結果と成功／失敗表示を追加。
- Usageを可視化し、Codex SDKの累積値とApp Serverのtotal／lastを区別。未取得と非対応を0で代用しない。
- Retry試行のユーザー表示重複、設定エラー後の自動送信、休止済み会話の設定変更、空の会話でのbackend設定伝搬を修正。
- 実画面の手操作・テーマ別スクリーンショットは未検証。検証範囲と残作業はdocs/VERIFICATION.mdに記録。

- 親ターン終了後も子・Background Terminal の状態と出力を元の会話へ届け、空一覧・自然終了・一覧取得失敗・terminate の結果を反映する。
- App Server の実際の子IDと ACP の ID 付き `cursor/task` 要求に対応し、起動や wait の終了を子の成功と混同しない。
- Build 済み Plan の改訂失敗・Stop で再 Build できる問題、複数の同時承認、古い画面から別会話への操作を修正した。
- Git の変更前全文、特殊文字を含むパス、Rename と復元時のユーザー変更保護を検証し、macOS のパス別名による変更一覧の重複を修正した。
- ハイコントラストの Build ボタンとファイルアイコンの文字化けを修正した。実機検証と残る制限は `docs/VERIFICATION.md` に追記した。

- Plan モードは計画ができたら止まり、Plan View で本文、To-do、Build 用モデル、Build を表示する。Build は同じ会話の新しいターンで Agent モードになり、計画を作り直さない。
- Plan のまま追加送信すると計画を更新して再び止まる。Build は準備完了のときだけ有効で、二重実行しない。
- Cursor SDK と Codex App Server はターンごとにモードとモデルを渡す。App Server のモデル変更は新しいセッションを作らない。Cursor ACP は `session/set_mode` を使い、モデルの途中変更はしない。
- 最終回答はツールより前の文章と分け、作業時間はターンの開始から完了まで（承認待ちを除く）で数える。
- ファイル変更は書き込みだけを数える。Cursor SDK は `result.value` の行数、Codex App Server は `fileChange.kind` と `turn/diff`、Codex SDK はターン開始時の Git 状態から正味の行数を出す。
- サブエージェントは識別子ごとに状態を出す。Background とは、結果にそう書かれているときだけ表示する。
- 実行中でも Home から別のセッションを開ける。同時実行数は `ai-agents.maxBackgroundSessions`（既定 3）。
- 変更ファイルは Review からまとめて開き、アイコンテーマが読めるときはそのアイコンを使う。

## 0.8.2

- AI出力のファイルリンクで絶対パスの先頭の `/` が失われ、作業フォルダが重複する問題を修正した。
- Markdownのローカルファイルリンク、`file://` URI、空白を含むパス、行・列番号に対応した。

## 0.8.1

- Enterは改行にし、依頼は送信ボタンのクリックで送るようにした。補完候補はTabまたはクリックで確定する。
- コマンド名の翻訳ファイルをVSIXに同梱するようにした。

## 0.8.0

- Composer のモデル名から、モデル・Effort・対応している Context と Fast を階層メニューで変更できるようにした。モードも同じメニューの操作に合わせた。
- 表示する項目は、Cursor SDK、Cursor ACP、Codex SDK、Codex App Server が実際に反映できるものだけにした。ACP のモデル変更、Codex の Context と Fast、Debug と Multitask は出さない。
- Cursor SDK のモデルとパラメータは次の送信で反映し、会話は閉じない。Codex は新しいセッションが必要なとき、会話がある場合は確認してから切り替える。
- コマンドパレットのモデル選択と詳細設定は、これまでどおり VS Code の選択画面で開ける。

## 0.7.0

- サイドバーを Home と Chat の2画面にした。Home でプロバイダーと過去の会話を選び、Chat で依頼する。戻っても実行中のエージェントは止まらない。
- 新規チャットと設定は各画面のヘッダーに置いた。ビュータイトルにあった同じ操作は外し、コマンドパレットからはこれまでどおり呼べる。
- 入力欄の下段はモード、モデル、添付、送信。モデル名には Effort を添え、詳細設定は同じボタンから開く。サンドボックスと承認は詳細設定に残した。

## 0.6.0

- 実在の Cursor CLI と、同梱の Codex 0.162.1 で接続、短い推論、ツール実行、承認と拒否を確認した。
- 終了した CLI プロセスを次の送信で再利用しない。再開できるセッションは、その ID で公式の resume を使う。
- Codex のターン完了は、インストール済み App Server の `turn.id` と `turn.status` に合わせた。失敗したターンはエラーとして表示する。
- ACP のセッション許可は、CLI が提示する `allow-always` を返す。
- App Server のスキル一覧は、作業ディレクトリごとの入れ子を読む。
- 診断は、実際に起動する CLI を見る。出力にはトークンや API キーを出さない。

## 0.5.0

- チャットを画面の中心にし、設定の一覧は詳細設定へ移した。
- 入力欄を画面下のカードに固定し、モード、権限、モデルと Effort、送信と停止をその中に置いた。モデルの選択と詳細設定は、これまでどおり VS Code の選択画面で行う。
- ユーザーの発言とエージェントの本文を分け、Markdown、コード、ツールの実行、ファイル変更を読みやすく表示する。完了した作業は1行に畳む。
- 承認、計画、質問を会話の中に表示する。回答には待ちごとのトークンを付け、別の待ちへは送らない。
- 履歴はメッセージ領域の一覧になり、空の画面には最近のチャットを出す。
- 新規チャットと履歴は、ビュータイトルのボタンにした。

## 0.4.0

- 共通チャットUIを拡張し、Markdown、折りたたみ可能なツール出力、入力キュー、承認・計画・質問カード、変更ファイル一覧に対応。
- アクティビティバーに加え、セカンダリサイドバーでも同じチャットを開けるようにした。
- `@` ファイル参照、`/` コマンド、画像添付、選択範囲・Problems・Git差分・最近のターミナルコマンドの添付に対応。
- Cursorは公式SDKに加え ACP、Codexは公式SDKに加え App Server を選べるようにした。既定は従来のSDK。
- サンドボックス、承認ポリシー、モデル詳細、セッション再開、差分表示、ワークスペース内に限ったファイル復元を追加。
- 自動承認は既定で無効。有効化時は確認ダイアログを表示し、サンドボックスの無効化とは区別する。

## 0.3.0

- モデル欄に詳細設定ボタンを追加し、対応するEffort・Context size・Fast等を選択式で変更可能に。
- 適用・キャンセル・既定値への復元と、詳細値の保存に対応。
- CodexのEffort設定をSDKとCLIに反映。

## 0.2.1

- Effort・Context size・Fast等の設定違いをモデルごとに集約し、1モデル1項目の一覧に変更。
- 詳細設定用のパラメーター・既定値・プリセットをモデル情報から分離して保持。
- 同じモデルの再選択時に詳細値と会話を維持し、旧版の設定付き表示名をモデル名に移行。

## 0.2.0

- モデル欄を、一覧を自動取得する検索・選択画面に変更。
- Codexの `model/list` とCursor SDKのモデル一覧取得に対応。
- 一覧の再取得、選択の保存・復元、Cursorのモデルバリエーションに対応。

## 0.1.0

- Cursor / Codex の公式SDKを利用するサイドバーを追加。
- 会話の継続、ツール実行状況、停止、新しい会話、モデルと作業フォルダの選択に対応。
- Cursor SDKのブラウザログインと、SecretStorageへのAPIキー保存に対応。
- npm workspacesの開発環境、単体・統合テスト、OS/CPU別のVSIX作成を追加。


### Background terminal panel

- Open a running Codex App Server terminal from the composer list or chat header in the VS Code Terminal Panel, with live output and tab reuse.
- Ctrl+C requests cancellation through the owning runtime. Closing the panel tab only detaches the display.
- Text stdin forwarding and PTY resizing are not exposed by the agent-owned terminal API; the panel explains this limitation.


### 0.10.0 最終監査の追加修正（未リリース）

- Reset/履歴復元の会話競合、画像のみ送信/Queue/明示Retryを修正。
- ACP再開時Agent適用、App Server履歴の明示finalを保持。
- 補完・添付削除のdraft保存、古い補完/モードメニュー残留を修正。
- 4経路3turn、ACP Backend finalと表示一致、Host再起動の各turn final検査を強化。
- App Serverのprocess ID判明前に受信した背景stdoutを一覧へ結合。no-ttyランタイム自体の初期出力未配信は制限として記録。
