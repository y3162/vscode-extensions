# UI / UX Gap Analysis

比較対象は `yutat23/cursor-agent-sidebar` v0.3.7（commit `63a1672`）のソースです。READMEの機能一覧だけで判断せず、ACPクライアント、Webview、権限、差分復元の実装を確認しました。ソースの丸ごと移植はしていません。

| Feature | Reference | Current before 0.4.0 | Needed change | Priority | Result in 0.4.0 |
| --- | --- | --- | --- | --- | --- |
| チャットUI | Secondary sidebar、Markdown、コードコピー、思考とツールの折りたたみ | Activity Bar、プレーンテキスト | 共通の読みやすいチャット。狭い幅でも操作できること | High | Secondary sidebar を追加し、Markdown と折りたたみを実装。Activity Bar は残した |
| モデル選択 | Webview内メニュー。設定 `cursorAgent.model` は未使用 | VS Code Quick Pick。再取得、保存、エイリアス、詳細設定がテスト済み | 既存UIを維持 | High | 変更なし |
| 動作モード | agent / plan / ask | なし | Capabilities に応じて表示 | High | SDKは agent/plan、ACPは ask も表示 |
| `@` 参照 | ファイルとフォルダ検索、プロンプトへ本文注入 | なし | ワークスペース内だけを読む | High | 実装。`..` とシンボリックリンクの脱出は拒否 |
| `/` コマンド | commands と skills。複数行の判定にずれがある | なし | 行頭のコマンドを展開。組み込みコマンドは先頭のみ | Medium | `/clear` `/compact` `/review` `/diagnostics` `/diff` `/terminal` と skills |
| セッション復元 | ACP replay と `store.db` の独自解析 | ホスト内の現在セッションのみ | 公式の list/load/resume。内部DBは解析しない | High | SDK / ACP / App Server の公式経路と、拡張機能が記録した索引 |
| Permission UI | Allow / Always / Deny、保存ルール、自動承認確認 | 承認UIなし。Codex は `never`、Cursor は sandbox 有効で拒否 | 対話承認は対応プロトコルだけ。自動承認は明示 | High | カードUI。セッション内許可はメモリのみ。自動承認は確認付き |
| Diff Review | 変更前テキスト、`vscode.diff`、復元 | パスをテキスト表示 | VS Code の Diff Editor と安全な復元 | High | baseline または diff があるファイルを表示・復元 |
| 入力キュー | 実行中の追加、Send now、Stop では残す | 実行中の送信はエラー | 同じ操作 | High | 実装。App Server では Steer も可能 |
| 画像添付 | 貼り付け、最大4枚5MB | なし | Cursor と Codex の入力形式へ変換 | Medium | 実装 |
| 接続診断 | 起動失敗時のみ | ログのみ | チャットからいつでも実行。秘密は出さない | Medium | `agent --version/status` と SDK のログイン状態、Codex のバージョン |
| 使用量 | OS Keychain からトークンを取り、私設APIを呼ぶ | なし | 公式イベントだけ | Low | SDK usage と App Server の rate limit。Keychain は使わない |
| Codex統合 | なし | SDK exec | App Server を追加し、SDKを既定のまま残す | High | バックエンド選択を追加 |

維持したもの:

- Quick Pick によるモデル選択と詳細設定。参考実装のドロップダウンより、検索・再取得・キャンセル時に会話を消さない点が優れています。
- SecretStorage への API キー保存と、Cursor SDK のブラウザログイン。
- ワークスペース信頼チェックと、Webview の CSP。
- 単一セッションの停止・破棄・プロバイダー切替。ここをマルチセッションへ作り替えていません。

採用しなかったもの:

- `~/.cursor/acp-sessions/*/store.db` の protobuf 解析。公式の `session/load` と SDK の `messages.list` で足りる範囲に限定しました。
- Keychain や `auth.json` からアクセストークンを読んで使用量APIを呼ぶ処理。
- `allow-always` を CLI の永続許可リストへ書くこと。セッション内の記憶と、明示的な自動承認だけにしました。
- 参考実装の画面全体のコピー。レイアウトの考え方だけを取り、既存のモデル操作は残しています。
