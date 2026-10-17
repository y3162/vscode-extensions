# Architecture

拡張機能はエージェントの推論、サンドボックスの強制、ツール実行を再実装しません。役割は次の4層です。

```text
Webview
  チャット、入力、承認カード、キュー、変更一覧
Extension host
  セッション制御、コンテキスト組み立て、差分の表示と復元、Capabilities
SDK / Protocol
  @cursor/sdk、Cursor CLI ACP、@openai/codex-sdk、Codex App Server
Agent runtime
  推論、ツール、OSサンドボックス、Rules、Skills、MCP、セッション永続化
```

## 通信の選び方

| プロバイダー | 既定 | 追加 | 理由 |
| --- | --- | --- | --- |
| Cursor | `@cursor/sdk` 1.0.37 | `agent acp` | SDKはローカル実行、モデル、画像、使用量、resume を公式に提供する。対話承認、Ask、`cursor/ask_question`、`cursor/create_plan` は ACP の JSON-RPC でしか受け取れない |
| Codex | `@openai/codex-sdk` 0.162.1 | `codex app-server` | SDKは `codex exec` をターンごとに起動し、stdin を閉じる。承認、質問、steer、レビュー、スレッド一覧は App Server の双方向 JSON-RPC が必要 |

既定を SDK のままにしたのは、0.3.0 までの動作と統合テストを維持するためです。サイドバーの「バックエンド」で ACP または App Server に切り替えます。

SDK で `on-request` のような対話承認を選ぶと、プロセスが入力を待ったまま止まるため、その場合はエラーにして App Server への切り替えを案内します。

## サンドボックスと承認

サンドボックスの強制はランタイムです。

- Cursor SDK: `local.sandboxOptions.enabled`。有効時、範囲外の操作は対話なしで拒否されます。無効時は確認なしで実行されます。
- Cursor ACP: 起動引数 `--sandbox enabled|disabled`。ツールごとの判断は `session/request_permission` です。
- Codex: `read-only`、`workspace-write`、`danger-full-access`。ネットワークは `networkAccessEnabled` または App Server の config です。オフを選んでも「拡張機能がネットワークを遮断した」とは表示しません。未指定のときはランタイムの既定です。

自動承認はサンドボックスではありません。`ai-agents.autoApprove` は既定で false で、有効化には確認ダイアログが必要です。セッション中の「このセッションでは許可」はプロセス内のメモリだけで、新しい会話では消えます。

## セッション

`SessionRegistry` は会話ごとに `ChatController` を持つ。画面に出るのは前面の1つで、実行中に Home から別の会話を開いても前面の実行は止めない。同時実行の上限は `ai-agents.maxBackgroundSessions`。アイドルの背面プロセスはセッション ID を残して終了し、次の送信で再開する。

Plan の状態は `PlanState` が持つ。Plan モードの送信は計画を作って `ready` で止まる。Build はその計画の版とセッションが一致するときだけ Agent モードの新しいターンを始める。Cursor ACP の `cursor/create_plan` は計画を記録したあと `cancelled` を返し、実装は Build のターンまで始めない。

`ChatController` は1つの実行だけを持ちます。Webview を閉じても実行は止めません。停止、前面の新しい会話、プロバイダー変更、サンドボックス変更で前面を破棄します。モード変更は、接続中のセッションが `setMode` を実装していれば会話を維持します。

復元は `Agent.resume`、`resumeThread`、ACP `session/load`、App Server `thread/resume` を使います。`HistoryStore`は既存ChatControllerの表示snapshotをworkspace storageの`history/v1`へ直列・atomic保存し、接続より先に復元します。保存済みbackend/cwdを採用し、backend turn IDで再生と照合します。表示用データをモデルへ再送しません。保存済みターンはローカルの本文・時刻・metadataを優先し、未知のbackendターンを追加します。既存ターンへ外部から加筆された未対応itemの完全な競合解決は保証しません。

Cursor SDKは`dist/cursor-worker.cjs`をNodeモードでforkし、IPCで既存AgentSessionを提供します。SDK 1.0.37がargv[1]からplatform helperを探索するためです。SDKは外部依存のままとし、プロセス全体のargv変更やsandbox解除は行いません。認証はIPC内で渡し、引数・Webview・ログへ公開しません。

UsageはRunごとの記録／セッション累積snapshotを区別し、再通知を置換します。Codex SDKのturn.completedが実際には累積値を返すため、保存した基準との差分をTurnへ割り当てます。基準不明ではTurn値を捏造しません。コピーはWebviewの原文データをrequest ID付きでHostへ送り、vscode.env.clipboard.writeTextの結果を返します。

## ファイル変更

エージェントが書く前にパスが分かれば、その時点の内容を baseline として保持します。既に書かれた後で diff だけが来る場合は、ワークスペース内のパスに限って `git apply --reverse` を試みます。Codex の `thread/revert` は会話履歴だけを戻すため、ファイル復元には使いません。

復元前に、字句上のパスと `realpath` の両方がワークスペース配下であることを確認します。

## 送信済みプロンプトの編集とターン巻き戻し

送信済みUserメッセージの編集は、通常のRetryと別の操作です。編集欄はそのメッセージ上に開き、Resendを選ぶまで履歴・ファイルを変更しません。再送時は確認画面のあとに安全性を再検証し、対応Backendで新しい分岐を作り、ファイルを復元してからローカル履歴を切り詰め、編集後の本文を送ります。

任意のターン境界で履歴を作り直せるのは、履歴をページ取得できるCodex App Serverだけです。対象Backend turn IDより前を指定する `thread/fork` を使い、分岐後のturn一覧が既存のprefixと一致することを確かめます。Cursor SDK、Cursor ACP、Codex SDKには公開APIで任意ターン以前へ分岐する機能がなく、ローカル表示履歴からモデル用コンテキストを捏造しないため非対応です。

巻き戻し可能なターンには、ターン直前・直後の小さなテキストファイル内容とモード、ワークスペース実体パス、Plan / Todo状態を履歴snapshotへ保存します。1ファイル500 KB、1ターン2 MB、会話合計8 MBを上限とし、リネーム、バイナリ、symlink経由、ワークスペース外、baseline不足、途中の手動編集や競合がある場合は無効化します。Git全体のresetや外部副作用の巻き戻しは行いません。

復元前に変更予定のファイルを照合し、0600のジャーナルにファイルバックアップをatomic保存します。書き込み途中の失敗では、変更したファイルをバックアップへ戻します。Extension Host再起動時は保存済み会話が分岐IDを採用済みかを見て、未確定ジャーナルを完了またはロールバックします。会話snapshot自体も再送前に同期保存します。ローカル履歴保存を無効にした場合、または既存ターンに完全なチェックポイントがない場合は編集・巻き戻しを実行できません。

稼働中・不明状態の子エージェント、Background Terminal、保留操作、キューがある会話は止めずに拒否します。外部APIやエージェントの非ファイル副作用は戻せません。過去分岐後も旧Backend thread自体は保持されますが、新しい会話は分岐session IDだけを使います。

## コンテキスト

`@file` と `@folder` はワークスペース内のテキストだけをプロンプトへ足します。選択範囲、Problems、`git diff`、シェル統合で観測できた最近のコマンドも拡張機能が組み立てます。VS Code はターミナルの画面バッファを拡張機能へ渡さないため、スクロールバック全文は取得しません。

Rules、Skills、MCP の実行はランタイムです。Cursor SDK では `settingSources: ['project', 'user']` を渡して読み込ませます。拡張機能はファイル名とサーバー名だけを表示し、`mcp.json` の環境変数は出しません。

## Webview

Cursor SDKの背景shellは、専用worker内で会話の寿命まで保持する。SDK 1.0.37はターン終了時に背景executorもdisposeするため、ビルド時にCJSランタイムをコピーし、その呼び出し1箇所をleaseへ置換する。バージョン・元ファイルSHA-256・置換数を検証し、不一致ならビルドを失敗させる。実行・sandbox・権限判定はSDKのまま。全shell終了時または会話dispose時に元executorを解放する。Ctrl+Cはshell IDとPIDの一致を確認して保持中のnative managerへ渡す。

スクリプトは nonce 付きで、CSP は `default-src 'none'` です。画像プレビューだけ `img-src data:` を許可します。エージェント出力は `textContent` か、エスケープしたテキストから作る DOM で描画し、HTMLとして解釈しません。Webview からのメッセージは種別とフィールドを確認してから使います。APIキーは Webview へ送りません。

## 今回やらなかったこと

- Cursor Cloud / Background の起動。課金とリモート実行を伴うため、確認用のUIを別に設計してからにします。
- 1つのサイドバーでの同時実行。キューとセッション一覧で足りる範囲に留めました。
- IDEのinline completionと意味検索。エージェントのツール実行とは別のAPIが必要です。


## 最終監査で保護した境界（2026-10-17）

履歴復元もControllerのactive操作とし、送信・設定変更と排他、Stop/Reset後の遅延本文を取り込まない。Resetはactive完了後にretained session IDを再消去する。画像only送信はimages有なら空promptを許可。Retryは元入力と画像をHostからsource Webviewへ返し、会話・turn・draftが一致する場合のみ復元し、明示送信まで推論しない。画像の永続化方式は変更せず、元画像を再取得できない保存会話では再添付を要求する。

## テスト

認証不要の回帰は、合成したプロトコルイベントと一時ディレクトリだけで実行する。採取したセッション記録、スクリーンショット、実行ログは入力にしない。実CLIを使うテストは `AI_AGENTS_LIVE_*` または `AI_AGENTS_REAL_PROTOCOL` が明示されたときだけ動く。ACPの並列子タイムアウトと、非TTYコマンドが初期stdoutを配信しない制限は、モックの成功で解消済みにしない。
