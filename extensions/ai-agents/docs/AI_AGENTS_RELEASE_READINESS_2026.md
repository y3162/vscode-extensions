# AI Agents v1.0.0 リリース準備監査 — 2026-10-30

## 実施概要

開始は `main`、HEAD `e5ed31473c14bddf39731cd9194b27f24c625daf`。開始時点の18件の変更と未追跡の `AI_AGENTS_FINAL_STABILITY_2026.md` を保持した。今回の変更は `scripts/gui-session.mjs`（隔離Hostの通常抑制条件の選択）、`src/model-selection.ts` と `test/core/model-selection.test.ts`（未検証パラメータからの復帰案内）、本報告書。製品の幅補正は加えていない。macOS arm64、隔離VS Code 1.144.0、スクリーンショット・録画なし。Commit、Push、公開はしていない。

## 残存3項目

| 項目 | 開始時 | 今回の検証・変更 | 判定 |
| --- | --- | --- | --- |
| Webview幅同期 | 内部原因未確定 | テスト起動引数のみの3フラグを監査し、隔離Host限定のオプトアウトを追加。通常抑制条件の初回は幅行列12条件とPlan/Approval/Subagentの幅計測がPASS、Review測定中のCDP context消失でT19全体はFAIL。再試験は幅行列で3条件が収束せずFAIL。iframe・外側document・active frameの同期待ちを維持。 | BLOCKED：通常条件で安定せず、内部原因は未証明 |
| Plan連続操作 | 別fixture | 既存T13の生成・revision・Build失敗・Stopと、別fixtureの保存Plan Build・Reloadを確認する構成を監査。生成からReloadまで同一セッションでの実Host連続検証は未実施。 | BLOCKED |
| Cursorパラメータ | 定義不足を拒否 | 未検証を保持し送信停止、同モデル再選択・確認後に既定値へ戻す手順をエラーに追記。定義に存在する値だけ検証済み、不正値・モデル不在・取得失敗を区別。 | BLOCKED：正しい保存値をCLI一覧だけで検証する手段なし |

Cursor CLI `2026.10.22-27dcf5f` のヘルプは `--model 'id[context=1m,effort=high,fast=false]'` の形式を例示するが、例は全モデルの有効値の定義ではない。Composer 2.5の無パラメータ実CLI成功は前回報告に基づき、今回新規ライブ実行はしていない。[Cursor CLI公式](https://cursor.com/docs/cli/overview) はモード・モデル指定・セッション再開を説明する。

## UI Fidelity

Cursor 3.26.13の保存済み400px Dark実測と、今回の390px Dark Modern fixtureを比較。異なる幅のため幅そのものを一致とみなさない。Light/HCのCursor実測はない。色と合成条件が未解明のためCSS/DOMの変更は行っていない。

| コンポーネント | Cursor基準 | AI Agents | 差分・根拠 |
| --- | --- | --- | --- |
| Composer | 入力14px/22px、操作行28px | 同寸法 | 0px（寸法、既存実測とCSS）；色はテーマ依存 |
| Model Selector | Modeの後、ラベルとchevron | 同順、intrinsic幅 | 幅別Cursor実測なし、完全一致未確認 |
| User Message | 13px/18.2px、白12%枠 | 13px/18.2px、前景12%枠 | 寸法0px。Dark前景204の枠は合成前RGB 204、Cursor白255との差51；合成後は背景に依存 |
| Activity | 14px/22px、rgba(240,240,240,.74) | 14px/22px、descriptionForeground | 寸法0px；色はテーマ依存で最終RGB未計測 |
| Review | 20px、Composer直上 | 20px、直上 | 寸法0px、色差未計測 |

Cursor Darkの背景 #181818 に白3.5%を合成すると概算 #202020、保存実測の灰 `srgb(.303)` を13.5%合成すると概算 #1f1f1f。単一背景への合成を仮定した値である。VS Code 1.144 Dark Modernのテーマ定義ではinput背景 #313131 なのでAI AgentsのComposerは各RGB +17、Userは各+18。ActivityのCursor文字を同じ背景で合成すると概算 #b8b8b8、AI AgentsのdescriptionForeground #9d9d9dは各−27。ReviewボタンのCursor実測 #626262 に対し、AI Agentsのsecondary背景は透明で背後が #181818 なら各−74。これらはテーマ定義と静的CSSに基づく推定であり、全状態のcomputed style実測ではない。Dark/Light/HCのレイアウトfixtureを用いるが、Cursorとのテーマ別色一致は未検証。Planカード等の意図的な差異は既存仕様書を参照。

## Backend Capability

現在の製品経路はCodex `exec --json` とCursor `agent --print --output-format stream-json`。App ServerはCodexのモデル・履歴等に使用。以下の「Mock」は実CLI確認を意味しない。

| 機能 | Codex CLI | Cursor CLI |
| --- | --- | --- |
| 基本会話・再開 | Mock、過去のライブ証拠あり | Mock、過去のComposer 2.5短文ライブ成功 |
| Reasoning本文 | イベント処理はMock、実本文は未確認 | 実本文未確認 |
| 対話承認 | 非対応（CLI経路） | 非対応として無効化（print経路） |
| Subagentイベント | CLI経路では追跡非対応。App ServerのMockあり | CLI経路では追跡非対応 |
| 実行中Reload継続 | 実CLI未確認 | 実CLI未確認 |
| Plan/Build | CLI経路ではPlan非対応。App ServerのMockあり | Planイベント対応、Mock；実モデル未確認 |
| 画像・Usage | Codexは画像対応、Usageはイベント依存 | print経路では画像とUsage非対応 |

[Codex App Server公式](https://developers.openai.com/blog/codex-as-a-platform) の承認サポートは、本製品の `exec` 経路における対話承認の証明ではない。

## リリース監査

Manifestは1.0.0、VS Code `^1.109.0`、workspace拡張、untrusted/virtual workspace非対応。activation、commands、configurationはmanifestに定義。macOS arm64のVSIX生成を確認、64ファイル、126.37 MB。配布対象にはproduction Webview、Codex実行物、README、CHANGELOGが含まれ、ファイル名検査ではsrc/test/docs・map・auth.json・.envは含まれない。これは内容全体の秘密情報スキャンではない。manifestは `UNLICENSED`、パッケージは `skipLicense` を使用し拡張本体のLICENSEを同梱しないため、公開権限とライセンスは要確認。再現ビルドのバイト一致は未検証。

Undo/Keepは保存されたbefore/after、dirty editor、workspace境界、realpath・symlink・外部変更を検査し、不明時は拒否する。複数ファイル処理には部分失敗があり、検査から書込みまでの外部変更とのTOCTOUを完全に防ぐ原子性はない。Session Restore、二重操作、Stop、PermissionのMockテストは実Backendを保証しない。秘密情報やローカルパスの網羅的監査は未完了。

macOS arm64は今回ローカル検証。Linux x64/arm64、Windows、VS Code最低対応版の実機は未試験。CIの成功を今回のdirty treeの実機PASSとは扱わない。ローカルCodex CLIは0.163.0、同梱依存は0.162.1。Cursor CLIは上記バージョン。

## 回帰テスト

| コマンド | 結果・証拠 |
| --- | --- |
| `npm run check` | PASS `/private/tmp/ai-release-check.log` |
| `npm test` | PASS 860/860 `/private/tmp/ai-release-unit.log` |
| `npm run test:coverage` | 3回目PASS 860/860、Lines 99.25%、Branches 98.58%（前回比0、+0.01ポイント）。初回FAIL：子プロセス終了時間のAssertion、2回目FAIL：Git fixture開始待ち。 `/private/tmp/ai-release-coverage-final.log`、`/private/tmp/ai-release-coverage.log`、`/private/tmp/ai-release-coverage-retry.log` |
| `npm run test:hygiene` | PASS `/private/tmp/ai-release-hygiene.log` |
| `npm run build` | PASS `/private/tmp/ai-release-build.log` |
| `AI_AGENTS_GUI_NO_SCREENSHOTS=1 npm run test:ui` | PASS 396シーン・22操作・画像0 `/private/tmp/ai-release-ui.log` |
| `npm run test:integration` | PASS `/private/tmp/ai-release-integration.log` |
| `npm run package` | PASS `/private/tmp/ai-release-package.log` |
| 通常抑制条件 T19 | 2回ともFAIL：初回Review CDP context消失、再試験は幅収束しない3条件。 `/private/tmp/ai-release-normal-t19/results.json`、`/private/tmp/ai-release-normal-t19-retry/results.json` |

| `AI_AGENTS_GUI_NO_SCREENSHOTS=1 npm run test:gui:acceptance` | 一括18/20 PASS。T17とT20は復元ツールgroupが開くのを待ってFAIL。T17単独再実行PASS、T20単独再実行はtool detailが開くのを待ってFAIL。 `/private/tmp/ai-release-all-final/results.json`、`/private/tmp/ai-release-t17-retry/results.json`、`/private/tmp/ai-release-t20-retry/results.json` |

一括受入の最初の2回の起動は、隔離VS Codeコピーが削除済みまたは不完全だったため全件BLOCKED。完全な別コピーで上記一括を再実行した。T17/T20の失敗時DOMでは復元済みツール行が存在したが、開閉操作後の状態が維持されなかった。描画・再描画との競合の可能性はあるが、原因未確定。Assertionを削除・緩和していない。各隔離Hostは通常Quitで終了した。

## 最終判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| GUI Acceptance | **NO-GO** | 今回の一括18/20、T20単独再試験もFAIL。開始時の過去GOを今回の証拠で維持できなかった。 |
| Cursor UI Fidelity | 部分確認 | 寸法の一部とDarkの推定色差を記録。全状態・Light/HCのCursor実測なし、CSS改善未実施。 |
| Backend Integration | **LIMITED** | Mockと過去の限定的なライブ証拠のみ。実CLIのReasoning、実行中Reload、実モデルPlan/Build等は未確認。 |
| v1.0.0 Release Readiness | **NO-GO** | GUI受入失敗、Plan生成からReloadの連続検証未実施、通常条件の幅不安定、CLIパラメータ定義不足、公開ライセンス等が未解決。 |

必要な次作業は、復元時ツール開閉が閉じ直る原因の再現・修正とT01〜T20の再実行、Plan生成イベントからBuild・Reloadまでの同一CLIセッションfixture構築、実Backendの限定的な検証、ライセンスと対象環境の確認である。今回これらは完了していない。
