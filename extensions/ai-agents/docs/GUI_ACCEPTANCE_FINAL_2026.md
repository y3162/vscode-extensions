# AI Agents GUI Acceptance 最終報告

開始時 HEAD: `8797587827da63d10a29d6da524cb448c024e578`、branch `main`、作業ツリーはクリーン。

状態は NOT STARTED / RUNNING / PASS / FAIL / BLOCKED。実Hostの検証が未実施の項目を fixture のみで PASS としない。

## 受入マトリクス

| ID | 要件 | 実装状況 | 実Host検証状況 | テスト結果 | 証拠ファイル | 問題点 | 修正内容 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | Thinking開始・自動展開 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T01/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T02 | 手動閉鎖・更新後の保持 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T02/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T03 | Thinking項目完了 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T03/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T04 | 完了Thinkingと後続Tool | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T04/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T05 | ターン終了・Ready復帰 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T05/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T06 | Session切替と状態分離 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T06/` | T06 は Registry 切替。履歴 UI は T07 | 既存実装を再利用 |
| T07 | 履歴UIからのSession再選択 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T07/` | 履歴選択と Reload 後の既定状態を実 Host で確認 | mock resume と履歴リプレイ修正 |
| T08 | Reload後のThinking初期状態 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T08/` | 前回失敗を保存し修正後に再実行 | 条件待機と測定同期を改善 |
| T09 | Review Pending | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T09/` | 2ファイルの件数・Review・操作を実 Host で確認 | 各対象直前に再検証 |
| T10 | Keep All | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T10/` | Keep 前後の実ファイルと Reload、追加変更の再レビューを確認 | 各対象直前に再検証 |
| T11 | Undo All正常系 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T11/` | 複数ファイル復元・途中失敗・競合・拒否理由・二重クリックを確認 | 各対象直前に再検証 |
| T12 | Undo All競合・拒否 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T12/` | 複数ファイル復元・途中失敗・競合・拒否理由・二重クリックを確認 | 各対象直前に再検証 |
| T13 | Plan Ready | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T13/` | 入力・改訂・モデル・Build・Stop・失敗・Reload を確認 | 既存の Plan を使用 |
| T14 | View Plan / Build | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T14/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |
| T15 | Approval Pending / Resolve | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T15/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |
| T16 | Subagent実行・完了 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T16/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |
| T17 | 複数ターンの正常履歴復元 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T17/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |
| T18 | Reload後の正常履歴復元 | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T18/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |
| T19 | 幅・テーマのレイアウト | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T19/` | 前回失敗を保存し修正後に再実行 | 条件待機と測定同期を改善 |
| T20 | 統合回帰シナリオ | PASS | PASS | PASS | `/private/tmp/gui-acceptance-final-retry/T20/` | 実 Host の操作と状態を確認 | 既存実装と隔離 fixture を使用 |

## Phase

A–J: PASS。各項目の証拠と検証レイヤーは下記参照。

実行中 Reload の履歴だけが残る場合、未完了ターンと Tool が完了に見える不整合を修正。実 Host で同じ合成履歴を選択し Unknown 表示を確認（`/private/tmp/gui-restore-abnormal-fixed-final/`、既定 Home assertion は会話画面のため失敗。個別 DOM を確認）。

実行環境: macOS arm64、Node 26.7.0、隔離 VS Code 1.144.0 Development Host。証拠は合成 workspace を使用し、認証情報をコピーしていない。

実 Host の基本幅×テーマ検証は各 Webview の実幅 300 / 390 / 600 / 1000px を確認し、Dark Modern / Light Modern / Dark High Contrast の12条件で列幅・Composer・横はみ出しの基本 assertion が成功。全 UI 状態の確認ではない。

過去の終了済みプロセスの不明原因は現在の受入条件に含めない。Backend 実認証と mock は区別する。

## 最終判定

AI Agents GUI Acceptance: **GO**。最新の本番 Webview と隔離 Extension Host で T01〜T20 を再実行し、全必須シナリオが PASS。

Backend Capability Integration: **限定的に確認**。Mock CLI と Host fixture によるイベント・承認・復元を検証した。実認証済み CLI の reasoning 本文や対話承認の実動作は今回未確認であり、Mock の結果を実 CLI の対応として扱わない。

Cursor UI Fidelity: **参考評価**。実測済みの範囲のみを比較対象とし、Cursor の matched CSS 等の未実測部分について完全一致を主張しない。

## 回帰テスト（途中経過）

- `npm run check`: PASS。
- `npm test`: PASS、849 件（`/private/tmp/ai-agents-final-test2.log`）。狭幅の Plan 修正に伴う旧 CSS assertion を更新して再実行。
- `npm run test:coverage`: PASS、849 件（`/private/tmp/ai-agents-final-coverage.log`）。
- `npm run test:hygiene`: PASS。
- `npm run build`: PASS。
- `npm run test:ui`: PASS、撮影なしで396条件と22操作を検証（`/private/tmp/ai-agents-final-ui2.log`）。Chrome 起動待機を延長して再実行。
- `npm run test:integration`: PASS、隔離 VS Code Host（`/private/tmp/ai-agents-final-integration3.log`）。
- 当時の `npm run test:gui:acceptance` は実行中。最終再実行結果は下記を参照。

Undo の直前確認と書き込みの間に他プロセスが書き換える競合を完全に原子的には防げない。

## 作業上の記録

対象リポジトリへの Commit、Push、Release は実施していない。別担当が使い捨ての GUI 検証用 workspace 内で Git 基準を作るため fixture commit を一度作成した。これは対象リポジトリ外だが、Commit をしないという指示に反する操作だった。以後の fixture ではコミットを使わない。

## 2026-10-30 引き継ぎ後の再検証

引き継ぎ時の HEAD は `8797587827da63d10a29d6da524cb448c024e578`、branch は `main`。多数の未コミット変更と本報告書が既に存在し、保持して作業した。

- `npm run check`、`npm run test:hygiene`: PASS。
- `npm test`、`npm run test:coverage`: PASS、各 851 件。`/private/tmp/ai-agents-quiet-test.log`、`/private/tmp/ai-agents-quiet-coverage.log`。テスト同時起動による時間依存失敗を抑えるため実行並列数を 4 に制限した。テストや assertion は削除していない。
- `npm run build`: PASS。`/private/tmp/ai-agents-quiet-build.log`。
- `AI_AGENTS_GUI_NO_SCREENSHOTS=1 npm run test:ui`: PASS、396 条件・22 操作・撮影 0 件。`/private/tmp/ai-agents-quiet-ui.log`。
- `npm run test:integration`: PASS。隔離 VS Code 1.144.0 を使用。`/private/tmp/ai-agents-quiet-integration2.log`。先行実行は空き容量不足で展開に失敗したため、終了済みテストアプリのコピーを整理して再実行した。
- Undo の対象がシンボリックリンクの workspace root または途中パスを含む場合を拒否し、別名の親を通る未保存エディタも実パスで検出するよう修正。対象テスト PASS。
- 旧 GUI runner が Host のプロセスグループに SIGTERM を送った結果、VS Code に異常終了画面が表示されることがあった。中止し、隔離 CDP の Workbench から通常の Quit を要求する方式に変更した。通常の VS Code は対象にしない。停止できない場合は強制終了せず FAIL とする。ユーザーの意向により再検証時の撮影は無効。
- `/private/tmp/gui-graceful-t01-v5/results.json`: 最新の終了方式で T01 の ViewModel・Mock CLI を PASS。先行のタイムアウトは `/private/tmp/gui-graceful-t01-v4/` に保存し、原因未確定。
- `/private/tmp/ai-agents-acceptance-retry/`: 修正前の停止方式で T01〜T09 と T12 の部分証拠を取得。T10/T11 は Host の信頼画面待ちで失敗し、全体実行は警告を受け中止。結果を全件 PASS として扱わない。
- `/private/tmp/gui-safe-t10/results.json`: 正常終了方式で T10 PASS。

### 最終実行

- `AI_AGENTS_GUI_NO_SCREENSHOTS=1 npm run test:gui:acceptance`: **PASS、T01〜T20 全 20 件**。`/private/tmp/gui-acceptance-final-retry/results.json`、`/private/tmp/gui-acceptance-final-retry.log`。全 Host は通常 Quit で終了し、撮影は 0 件。各シナリオの DOM、時刻、幅、テーマ、本番バンドル情報は対応ディレクトリに保存。
- 直前の全件実行では T08 の Tool 表示待ちと T19 の 1px 幅差が FAIL。証拠 `/private/tmp/gui-acceptance-final-current/results.json` は保持。T08 は詳細を開く各段階を条件待機し本文の assertion を維持、T19 はレイアウト安定待ちを追加した。T08 の初回失敗時 DOM はなく、直接原因は未確定。修正後の単独実行と最終全件実行はいずれも PASS。
- 実 Host の基本レイアウトと Review 帯は 300 / 390 / 600 / 1000px × Dark Modern / Light Modern / Default High Contrast の各 12 条件が PASS。主要カードは 390 / 1000px Dark で確認。実際の Webview 幅を測定し、本番 `dist/webview/main.js` と `main.css` を使用。
- 最新コードで `npm run check`、`npm run test:hygiene`、`npm test`、`npm run test:coverage`、`npm run build`、`npm run test:ui`、`npm run test:integration` は PASS。Unit と coverage は各 852 件、UI は 396 条件・22 操作・撮影 0 件。ログは `/private/tmp/ai-agents-last-test.log`、`/private/tmp/ai-agents-last-coverage.log`、`/private/tmp/ai-agents-last-build.log`、`/private/tmp/ai-agents-last-ui.log`、`/private/tmp/ai-agents-last-integration.log`。
- 描画フレームが停止した Webview でも Host 状態を描画する fallback を追加し、回帰テストを追加。Undo は事前検証と各ファイルの実行直前再検証を行うが、その検証と書き込みの間の外部プロセスの競合は完全に原子的ではない。
- 単一コマンドは ViewModel fixture（T06、レイアウト）、Controller と Mock Backend を通る Host 操作、実ファイル検証を区別する。実 CLI の認証付き capability は別扱い。T20 は Thinking・履歴・Review・Plan・承認の統合経路であり、Subagent と幅・テーマはそれぞれ T16・T19 で検証した。
- 検証時はディスク空き不足が発生したため、終了済みの隔離 Host のアプリコピーのみを整理し、受入証拠と workspace は保持した。対象リポジトリへの Commit、Push、Release は行っていない。

最終本番バンドル SHA-256: `main.js` `2eaadd010748ff82fd1e0c76c5eb44a5b4aaeadb16641014a7b487ba743153d1`、`main.css` `9d32abcc7067adee2f1cd3bc51d02eaa14fdafc53750132a9b3fc091d0d4c68f`。
