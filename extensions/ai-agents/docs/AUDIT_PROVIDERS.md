# プロバイダー監査 — 0.10.0、2026-10-17

## 再現した不具合と修正

Cursor ACPは`agent_message_chunk`を純粋なテキスト差分として送ります。インストール済みCLIのACPアダプターは`textDelta`イベントをこの通知へそのまま対応付けています。セッションの再生でも、保存済みAssistant応答全体を同じ通知で送ります。以前の拡張機能には、差分とスナップショットを曖昧に扱う判定がありました。累積済みテキストの末尾が受信文字列と一致すると、その文字列を破棄していました。そのため、ツール実行前の本文と同じ最終回答が消え、正当な同一トークンの連続通知も失われました。この不具合は推論を行わず、現在のHEAD上で再現できます。

回帰fixtureは`done`、ツール境界、`done`、` done`、` done`を送ります。修正前はAssistantメッセージが`done`と` done`に分かれ、修正後は3ターンすべてで`done`と`done done done`になります。ACPは純粋な連結処理を使い、SDKは従来の差分・スナップショット混在処理を維持します。`session/prompt`の正常終了時に最後のAssistantセグメントを最終回答としてマークします。再生時も各ターンの最後のAssistantを最終回答とし、ツール境界や復元後のターンをまたいでIDを分けて保持します。ACPの思考チャンクも同じく連結します。

以前はターンごとのモード変更が`try/finally`の外で拒否されると、ライブ更新コールバックが残っていました。現在は拒否時にコールバックを解除します。回帰テストでは、失敗後にアイドル通知を送り、失敗したターンではなく再生履歴へ振り分けられることを確認します。

以前のCursor workerのモデル変更はすぐに戻り、IPCエラーを破棄していました。現在はクライアントとworkerの両方がモデル操作の完了を待ちます。fake workerを使うテストでは、確認応答を保留してPromiseが未完了であることを確認し、Providerエラーを返して拒否されることを検証した後、正常な確認応答で復旧することを確認します。Controller状態のロールバックは別のテストで扱います。

## Cursor ACPの実機能確認

実行ファイル: `/Users/sekiyuuta/.local/bin/agent`。解決されたCLIのバージョンは`2026.06.26-7079533`です。

ローカルで実際のstdio JSON-RPCプロセスを初期化し、認証しました。機能確認ではモデル推論を行っていません。

- `session/new`が`modes.availableModes`に広告したのは`agent`、`plan`、`ask`の3つだけでした。3つとも`session/set_mode`で設定できました。
- ACPで`debug`と`multitask`へのモード変更を要求するとエラーが返りました。この結果はこのACPインターフェースに限ったものです。Cursor IDEや対話型CLIのスラッシュコマンドにDebug機能がないという意味ではありません。
- 起動時に`--model composer-2.5`を指定すると、広告されたモデルIDは`composer-2.5[fast=true]`、モデル名は`composer-2.5`になりました。
- モデルIDに`composer-2.5`だけを指定した`session/set_model`は`Invalid params`を返しました。正規形式の`default[]`と`composer-2.5[fast=true]`は成功し、`composer-2.5[fast=false]`は`Invalid params`を返しました。
- `configId: model`を指定した`session/set_config_option`でAutoからComposerへ切り替わりました。返された`configOptions`は、`currentValue: default[]`、続いて`currentValue: composer-2.5[fast=true]`を示しました。Fastを無効にする設定は拒否されました。

ACPの実行中モデル変更では、対象セッションが広告したID・名前だけを使います。明示的に要求された各パラメーターが、広告された正規variantと一致することを求め、`session/set_config_option`の完了を待ち、応答の現在値も照合します。未知のモデル、広告されていないパラメーターの組み合わせ、Backendエラー、確認応答の欠落があれば操作を拒否します。別のモデルvariantへのフォールバックは行いません。初回のモデルパラメーターも検証して適用し、再開後には要求モデルを実際に広告された状態と照合します。Backendから拒否された場合や確認応答が欠落・不一致の場合は、次のターンを送る前に接続を閉じます。再試行では新しい接続で同じセッションを再開します。静的なCapabilitiesは操作の対応状況を表し、利用可能かどうかはセッションごとに検証します。モデルvariantを広告しない旧CLIでは、UIだけ成功扱いにせず実行中の変更を拒否します。起動時の`--model`指定と、確認応答を得た実行中の変更は別に扱います。

## ライブ推論の証拠

別のライブテストではComposer 2.5とACP Askモードを使い、一時的な隔離workspaceで、すべての権限要求を拒否しました。セッションを1つ作成して短いプロンプトを3件送り、セッションを破棄した後、同じsession IDを読み込み、再生内容を確認しました。

| 確認項目 | 結果 |
| --- | --- |
| 1ターン目の回答 | `AUDIT_TURN_1`, `final: true` |
| 2ターン目の回答 | `AUDIT_TURN_2`, `final: true` |
| 3ターン目の回答 | `AUDIT_TURN_3`, `final: true` |
| 復元した回答 | 3件すべてが`final: true`で存在 |
| 復元したターンID | Backend turn IDは3件とも異なる |

この実行で得た拡張機能の生更新データは`/private/tmp/ai-agents-acp-live-evidence.json`にあります。これはProvider実行の証拠であり、人がGUIを操作した証拠ではありません。問題となった最終回答の重複シーケンスは決定的なプロトコル再生で証明しており、ライブモデルで発生させたとは主張していません。

## テストと制限

- Cursor SDK、stream-text、Providerプロトコルに絞ったテストが成功しました（最終回帰テストを加える前は21件）。
- worker-client、プロトコル、モデル設定を拡張したテスト群が成功しました（コールバック解除の回帰テストを加える前は23件）。
- ACPに絞った最終回帰テスト7件が成功しました。対象はライブ差分の重複、再生時の最終回答、正規モデルの確認応答、モード変更拒否後のコールバック解除、Provider拒否後の接続終了、確認応答欠落後の接続終了、再開後の要求モデル検証です。
- Cursor SDK、worker-client、プロトコル、モデル設定、stream-textを含む広いテスト群が成功しました（最後の安全性テスト3件を加える前は30件）。
- 最終Provider変更後の型チェックが成功しました。
- 既存のCursor SDKスナップショット重複除去の回帰テストも引き続き成功しています。

このProvider検証だけでは、GUIのクリップボード操作、4種類すべてのBackendにおけるStop/Retry、Plan中のファイル書き込み隔離、子やターミナルの実行時動作は確認できません。これらは総合監査の対象です。ACPのトークン使用量は推定せず、取得不可のままです。実行中のモデル検証にはインストール済みCLIが広告するvariant一覧を使います。SDKのモデルカタログにFastパラメーターがあるという理由だけで、未対応のFast variantを利用可能にはしません。


## App ServerのPlanにおけるサンドボックス保証

最終レビューで重要な抜けが見つかりました。Plan時の協働指示だけでは、Build前の書き込みを禁止する拡張機能のルールを強制できていませんでした。同梱版0.162.1の生成済み`v2/TurnStartParams.json`には、`sandboxPolicy`と`approvalPolicy`の両方が今回のターン**および後続ターン**を上書きすると明記されています。現在はPlanターンごとに`sandboxPolicy: { type: readOnly, networkAccess: false }`と`approvalPolicy: never`を明示して送ります。Agent/Buildターンごとに、threadの開始・再開時に返されたサンドボックスポリシーと承認ポリシーを、書き込み可能なroot、ネットワークアクセス、一時ディレクトリの除外設定を含めて正確に復元します。これにより、読み取り専用のPlan設定がBuildまで残ることを防ぎます。ポリシーを含まない古い応答では、既存の設定済みサンドボックスとrootを代わりに使います。

決定的なテスト3件で、workspace-write、read-only、full-accessの各設定についてPlan → Agent → Plan → Agentを実行します。Plan中の制限と設定済みポリシーの正確な復元を検証し、応答にのみ含まれる一時ディレクトリ除外も確認します。Providerプロトコルテスト24件と型チェックが成功しました。

実GPT-6-Lunaに絞ったテストでは、App Serverセッション1つ（`01a147b8-9098-7f62-94c4-2c7a597ed373`）と隔離した一時workspaceを使いました。

1. Plan prompt explicitly requested `printf forbidden > forbidden.txt` before planning an edit. `forbidden.txt` remained absent and `note.txt` stayed `alpha\n`.
2. A second Plan prompt revised the target to `gamma`. The original file remained unchanged and a plan event was returned.
3. Agent/Build in the same session changed `note.txt` to exactly `gamma\n`; the forbidden file remained absent.

拡張機能が受信した生の更新は`/private/tmp/ai-agents-codex-plan-sandbox-evidence.json`に保存されています。Backendとモデルは書き込みが拒否されたと報告し、独立したファイルシステム確認でもファイルが作成されていないことを確認しました。モデルの説明を生のツール実行証拠として扱ってはいません。同じ内容を繰り返し検証する任意実行の回帰テストを、`test/live/tools.test.ts`に`codex-app-server: Plan denies requested writes and Build restores workspace access in the same session`という名前で追加しました。

最終的なリポジトリ検証でも、追加した任意実行のライブテスト`Plan denies requested writes and Build restores workspace access in the same session`が成功しました（2026-10-17、1/1）。2回のPlanターンでは`alpha\n`が保たれ、禁止対象のファイルは存在せず、同じセッションのAgent/Buildが`gamma\n`を書き込みました。最終単体テスト144/144件とExtension Host統合テストも成功しました。


## 最終再監査の追加

ACP再開時のAgent mode再適用、App Server公開履歴final_answer保持、背景process ID判明前のbuffer/itemId結合を追加修正。いずれも修正前にfixture失敗を確認。no-tty初期stdout未配信は実ライブでも残り、終了時全文を取得。合成fixtureの成功は、この実CLI制限の解消ではない。判定は総合監査の本文を優先する。
