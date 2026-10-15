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

`docs/screenshots/` の PNG は 0.5.0 の Webview プレビューである。Extension Development Host の撮影ではない。今回も実ウィンドウの撮影はしていない。`host-*.png` は無い。

統合テストは、実 VS Code の Extension Host でサイドバー Webview の起動、履歴、ターン数、Diff Editor、承認トークンを確認した。幅、テーマ、IME、画像の貼り付けは見ていない。

### 手動確認

Extension Development Host（`.vscode/launch.json` の Run AI Agents）で、次は未実施である。

- [ ] Primary Side Bar と Secondary Side Bar
- [ ] 幅 300px と 390px で、入力欄とツールカードがはみ出さない
- [ ] ダーク、ライト、ハイコントラスト
- [ ] 長い履歴、ストリーミング中、承認待ち、複数ツール、ファイル変更一覧
- [ ] セッション切替
- [ ] 日本語 IME、画像の貼り付け
- [ ] キーボード操作、スクロール、フォーカス、入力欄の高さ

## 残る課題

- `on-request` は、サンドボックスが許可するコマンドには承認を出さない。承認カードを必ず試すときは `untrusted` を選ぶ。
- Codex のライブ変更は、変更前テキストがイベントに無いとこの拡張機能からは復元できない。
- 上の手動画面確認と、Reload、ワークスペース変更、通信断は未実施。
- Cursor Cloud / Background は起動していない。
