# 最終再監査（2026-10-17、今回の依頼）

この節の判定を優先する。下の「実装監査・改修」は開始前から存在した過去の作業記録であり、その「開始時clean」「今回ライブ成功」は本再監査の開始状態を意味しない。当時の実行ログはローカル保存であり、テストスイートの入力ではない。

開始HEAD: `b699abd3ad75f29e751276a170f2344ff339d980`。**開始時からtracked変更29ファイル、監査書4件・worker clientテスト・参考動画がuntracked**。開始差分を保持し、既修正を再実装していない。コミット・Push・Release・1.0.0への版変更は実施しない。Activity Bar / Secondary Sidebarを維持し、中央Composer・新規Agent editorは本依頼の対象外。

依存: Cursor SDK 1.0.37、Codex CLI / SDK 0.162.1、Cursor CLI 2026.06.26-7079533。package.jsonとlockを確認。実行Node 26.7.0、検証VS Code 1.142.0のHost Node 24.21.0。SDK背景互換パッチの元SHA256 `dfda676be168412734925d3803ce712a335a16109ba1e161f437584ab92b8906` は実インストールと一致し、version/hash/対象1箇所の全検査を維持。

参考動画「画面収録 2026-10-17 11.12.33.mov」（22.43秒）の15秒フレームを抽出し、Ask/Autoのモデル階層と説明tooltipを確認した。全フレームの一致比較ではない。中央入力欄の配置は本依頼で除外されている。

親が統合・ライブ/Host/実GUIを担当し、3子がProvider、状態管理、Webviewを分担。Composer 2.5はこのCodex子エージェントのモデル選択肢にないため使用していない。拡張機能のCursor推論テストはComposer 2.5、CodexはGPT-6-Luna。

## 追加で再現し修正した残存問題

| 再現条件と影響 | 原因・最小修正 | 変更ファイル・根拠 |
| --- | --- | --- |
| 全経路: 実行中Reset後、新規会話で旧会話を再開し得る | 旧ターンfinallyが消去済みretainedIdを書き戻す。active完了後にも消去 | `src/chat-controller.ts`, `test/sidebar/chat-controller.test.ts`。修正前失敗を確認 |
| 全経路: 履歴復元と送信・モデル変更・Resetが競合 | openSessionがactive/busyを確保していない。復元を排他操作にし、Stop後の遅延replayを無視。復元失敗はQueue自動実行を止める | 同上。修正前失敗、競合・Queue回帰 |
| 全経路: 画像だけの送信が無反応で入力から消える | Composerは許可するがControllerが空promptを破棄。画像有ならsend/enqueueを許可 | 同上。初回・Queue・明示Retryの回帰 |
| 全経路: 空本文画像turnのRetryが無反応 | Webviewのtruthy判定と画像復元返信なし。元画像を会話/turn/draft照合後に復元し、明示送信まで待つ | `src/protocol.ts`, `src/sidebar.ts`, `src/webview/{app,composer,transcript}.ts`, DOM/Host回帰。永続保存前の元画像は再添付案内 |
| Cursor ACP: 保存PlanをAgentで再開してもBackendはPlan | load後にAgentのset_modeを省略。再開時はAgentも明示適用 | `src/providers/cursor-acp.ts`, protocol fixture。修正前plan != agent |
| Codex App Server: 履歴の最終回答が未確定 | 公開履歴のfinal_answer phaseを破棄。明示されたphaseのみfinalとして保持 | `src/providers/codex-app-server.ts`, protocol fixture。推測生成なし |
| Codex App Server: process ID判明前に届いたstdoutが背景一覧から欠落 | itemId別bufferを一覧itemId/processIdと結合せず。初回一覧でbufferとmappingを保持 | `src/providers/codex-app-server.ts`, protocol fixture。修正前undefined、修正後成功 |
| 全経路UI: 補完/添付chip削除後の下書き保存漏れ | input以外で保存通知なし。変更通知を統一 | `src/webview/composer.ts`, DOM回帰 |
| 全経路UI: 古い補完/モードメニューが別会話へ残留 | token失効・identity変更・busy開始で遅延応答/メニューを閉じる | 同上。修正前3回帰失敗→成功 |

画像Retryでファイル副作用を巻き戻すことはしない。既存の注意表示と手動送信を維持。認証情報、承認既定、sandboxを緩和せず、Cloud Agentは起動していない。既存のACP delta、モデルACK、Plan失敗/Stop、Usage、背景cleanup等の144回帰を維持した。

## 受入試験の強化

`test/live/inference.test.ts` はThought/Toolからpongを拾わずAssistant本文だけを照合。4経路を3ターンに拡張し、ACPでは独立の3ターン試験でBackendの明示final本文とControllerのfinalMessageIdの本文を完全一致検査する。一時Git workspaceを使用。

`test/integration/reliability-host.ts` は従来の「会話中に1回答あれば成功」を廃し、全3ターンのcompleted・非空final Assistantを必須化。再起動後も全3回答を検査し4ターン目を送信する。Cursorモデルもautoからcomposer-2.5へ統一。

検証結果と残存リスクは [今回の検証記録](VERIFICATION.md#final-audit) を参照。最終判断は主要全経路GUIと障害・副作用の組合せ受入が未完了のため **No-Go**。中央Composer・editorタブの不在は理由に含めない。

---

# AI Agents 0.10.0 実装監査・改修

実施日: 2026-10-17。開始HEAD: `b699abd` (`main`, 0.10.0)。開始時の作業ツリーはclean。対象は `extensions/ai-agents/`。既存の検証記録は過去の証拠として扱い、以下は今回の再実行結果を記載する。未コミットの段階的改修で、バージョン番号は変更していない。

## 1. Cursor IDEとの比較

動画ファイル自体は今回の入力で参照できなかったため、ユーザー記載の操作仕様との比較。映像を再生して検証したとは扱わない。

- モデル階層・検索・説明・Fast / Effort / Contextの能力別表示、送信後の回答・進捗・下部Composerは既存実装あり。モデルの分類をBackendが返さない場合は推測で付け足さない。
- 新規チャットのComposerは下部固定。中央Composerと初回送信を境にした配置遷移は差分として残る。
- Debug / Multitaskはラベルを追加しなかった。実Cursor ACPの広告するモードはagent / plan / askで、debug / multitaskのset_modeは拒否された。CLI対話画面の `/debug` 対応と、拡張機能のACP・SDK API対応は別である。
- Askの進捗テキストをPlan完成とは扱わない。Plan文書はPlanターンの正常完了時だけ確定する。
- 中央エディタのNew Agent WebviewPanelは未実装。既存の共通SessionRegistryを使う追加surfaceとして別変更に分離する。

公式参照: [Cursor ACP](https://prod.cursor.com/docs/cli/acp)、[CLI slash commands](https://prod.cursor.com/docs/cli/reference/slash-commands)。実行可否の判断はインストール済みCLI・SDK・同梱App Serverスキーマと実応答を優先した。

## 2. 確認した不具合・改修

| 優先度 | 再現・根本原因 | 修正と主なファイル |
| --- | --- | --- |
| P0 | ACPの純粋なdeltaをSDKのsnapshot混在用mergeに通していた。末尾と同じdeltaが除去され、ツール前後で同じ回答を出すと後半segmentが空になる | ACPをstrict deltaへ変更。正常prompt終了で最終回答を明示し、復元でも各ターンの最後をfinalにする。`providers/cursor-acp.ts`, `providers/segments.ts` |
| P0 | Worker clientのsetModelがfire-and-forgetでrejectを握りつぶし、Worker側もawaitせず成功を返していた | IPC応答を待ち、失敗を伝播。Controllerはack後に選択を確定し、変更中の送信・競合を拒否。`cursor-worker-client.ts`, `cursor-worker.ts`, `types.ts`, `chat-controller.ts` |
| P1 | Buildのモデル変更をtry外で呼び、非同期失敗時にbuildingとUIモデルが先行した。別ターン実行中にもモードを変更できた | Buildのactive操作内でモデルackを待つ。失敗・Stopではreadyへ復帰。Stopがack後なら実際に適用されたモデルを保持し、実装は開始しない。モード変更もack後に確定。`chat-controller.ts` |
| P1 | 非同期設定・モデル一覧・送信コンテキスト展開中の会話切替で、処理完了先が新しいfront会話になり得た | 操作対象Controller・計画revisionを固定し、別会話のモード・選択を上書きしない。`sidebar.ts` |
| P1 | App ServerのPlanはcollaborationModeのみで、filesystemのread-onlyを明示していなかった | PlanターンはreadOnly / approval never、Agent / Buildでは開始応答のsandboxとapprovalを毎回明示復元。上書きの後続ターンへの残留を防止。`providers/codex-app-server.ts` |
| P0 | request-only Usageを集計したsession表示もBackend累積値とみなし、次のrequest通知を無視した | 同じsourceのネイティブ累積sampleがある場合だけrequestを抑制。後から初めて累積値が届いたターンはbaseline不明ならTurn値を捏造しない。`chat-controller.ts`, `test/integration/reliability.test.ts` |
| P2 | 保存履歴の終了済みTerminalまでunknownへ変えていた | 終了・cancelledなど確定した結果を保存。生存未確認のものだけunknown。`chat-controller.ts` |
| P2 | SDK executorの終了後cleanupを複数回呼ぶと同一executorを二重dispose | cleanupの対象を一度だけ保持し、自然終了・Worker終了・重複cleanupに耐える。`providers/cursor-background-runtime.ts` |
| P2 | SDK TerminalのCRLF footer、出力ゼロの先頭footerを解析できない | 明確な終了footerを正しく認識。`providers/cursor-terminals.ts` |
| P3 | 送信後にtextareaだけclearし、保存draftを更新しない。空会話のArrowUpが旧会話を復元する。モデル一覧cacheにBackend・会話identityが不足 | 保存clear、prompt recall reset、cache/遅延応答無効化。`webview/app.ts`, `webview/composer.ts` |

対応する単体回帰テストを追加。既存sandbox・承認・履歴形式を変更していない。クラウドVMやCloud Agentは起動していない。

## 3. バックエンドの対応

| 経路 | 会話・Stop・再開 | Plan / Build | モデル変更 | Usage / 子 / Terminal |
| --- | --- | --- | --- | --- |
| Cursor SDK 1.0.37 | 今回ライブ成功 | 初回・改訂・同一会話Buildをライブ成功 | IPCでack、次sendのモデル・parametersに反映 | Usageイベントあり。子は実取得データだけ。背景executorはhash固定互換パッチ |
| Cursor ACP 2026.06.26-7079533 | 今回ライブ成功。Ask 3ターンのfinalとsession/loadも別途確認 | `session/set_mode` plan→agent、ライブ成功 | 起動`--model`と実行時config変更を分離。詳細はProvider監査参照 | Usage未公開。Taskの実ID・実測model・duration。Terminal一覧非対応 |
| Codex SDK 0.162.1 | 今回ライブ成功 | 公開Plan modeなし、UIに表示しない | session設定変更時は新規会話を明示 | 累積Usage。対話承認・子tracking・背景Terminalは非対応 |
| Codex App Server 0.162.1 | 今回ライブ成功 | ターンごとcollaborationMode、ライブ成功 | 次turn/startのmodel / effort | Usage累積/直近。実子通知・公開thread/readと背景Terminal一覧 |

ACPが広告したComposer 2.5のモデルIDは `composer-2.5[fast=true]`。親モデル名から子のモデルを推測しない。今回ACP子が実際に返した `composer-2.5-fast` をそのまま保持した。公開APIのないDebug / Multitaskの疑似実装はしていない。

## 4. 今回のテスト

開始時の型チェック・122単体テスト・buildは成功。改修後の型チェック、単体 **144/144** が成功。ビルドとExtension Development Host結合も成功。

| 実行 | 今回の結果 | 証拠の意味 |
| --- | --- | --- |
| `npm run check` / `npm test` | 型チェック成功、144/144単体成功 | モデルIPC、delta、Plan失敗/Stop、Usage、履歴、Terminal、Webviewの回帰 |
| `npm run build` / `npm run test:integration` | 最終コードで成功 | 実Extension Development Hostのfixture検証。非同期context展開中の会話切替を含む |
| `npm run package` | 最終0.10.0 VSIX作成成功（137.6 MB） | patched SDK runtimeとLICENSE、worker、翻訳JSONを同梱。buildを直列実行して確認 |
| `npm run test:protocol` | 2/2成功 | 実ACPと同梱App Server。推論なしのプロトコル |
| `npm run test:live` | 5/5成功 | 4経路の短い回答・2ターン・Stop・dispose後resume、provider切替。Cursor Composer 2.5 / Codex GPT-6-Luna |
| `npm run test:tools` | 4/4成功 | 隔離Git内のファイル編集・実ファイル確認。ACP/App Serverは承認拒否・許可も確認。今回4経路すべてbaselineによる原文復元を確認 |
| 追加App Server Plan保護ライブ | 追加したライブ回帰テスト1/1成功。Plan→改訂→Buildが同一会話で成功 | 明示的な書込依頼でもPlan中は原文不変・禁止ファイルなし、Buildで実編集。モデルの拒否説明だけをsandbox阻止ログとは扱わない |
| ACP専用ライブ | 3ターン成功、再開後3回答保持 | Ask回答のfinal / load再生。raw event由来の反復delta欠落自体は決定的fixture回帰で再現 |
| `npm run test:runtime` | 12/12成功 | 実子並列、親Stop、Plan改訂、背景の自然終了・停止・別会話更新 |
| `npm run test:integration` | Extension Development Hostで成功 | fixture Backendで実Host/Webview/Clipboard/モデル/履歴/Terminal。ライブ推論と区別 |
| GUI mock hold | 実Clipboard Unicode往復成功 | 書込み前のClipboardを復元。画面クリックによる成功とは区別 |

## 変更ファイル一覧

実装: `src/chat-controller.ts`, `src/sidebar.ts`, `src/types.ts`, `src/capabilities.ts`, `src/providers/cursor-acp.ts`, `src/providers/segments.ts`, `src/providers/cursor-worker-client.ts`, `src/providers/cursor-worker.ts`, `src/providers/codex-app-server.ts`, `src/providers/cursor-background-runtime.ts`, `src/providers/cursor-terminals.ts`, `src/webview/app.ts`, `src/webview/composer.ts`。

検証: `test/sidebar/chat-controller.test.ts`, `test/core/plan-flow.test.ts`, `test/integration/reliability.test.ts`, `test/providers/shared/protocol.test.ts`, `test/core/model-settings.test.ts`, `test/providers/cursor/cursor-worker-client.test.ts`, `test/providers/cursor/cursor-background-runtime.test.ts`, `test/providers/cursor/cursor-terminals.test.ts`, `test/webview/ui.test.ts`, `test/integration/extension-host.ts`, `test/live/tools.test.ts`, `test/fixtures/mock-acp.cjs`, `test/fixtures/mock-app-server.cjs`, `scripts/test-integration.mjs`。

文書: `CHANGELOG.md`, `docs/VERIFICATION.md`, `docs/FEATURE_MATRIX.md`, 本書およびProvider / Runtime / UIの各監査書。

## 5. GUI・未対応・Go / No-Go

**v1.0.0はNo-Go。** 実行経路の修復とライブ回帰は進んだが、以下が残る。

- 操作ツールで検証用Extension Hostウィンドウを特定できず、300px / 390px・Dark / Lightの実画面とクリック操作による送信・コピー・モデル変更・復元は未検証。テスト用DOM・実Clipboard・Host結合の成功をGUI目視の代用にはしない。
- 動画そのものとのフレーム比較は未実施。中央Composer、New Agent editor surface、会話ごとのdraft/添付保存は追加変更へ分離。
- 全4経路で認証失効・ネットワーク断・実失敗後Retry・全Plan経路の失敗/Stopをライブ網羅したとは扱わない。これらは今回の単体・fixtureと実ライブを区別する。
- Backendが公開していないUsage、子ツール全文・モデル・寿命などを補完しない。取得できない値は未取得/非対応。親Stopは子の終了保証ではない。
- Cursor SDK 1.0.37互換パッチは将来版へ流用しない。バージョン・元ソースSHA256・置換箇所検査を維持する。

詳細: [Provider監査](AUDIT_PROVIDERS.md)、[Runtime監査](AUDIT_RUNTIME.md)、[UI監査](UI_AUDIT.md)。

成果物: `dist/ai-agents-darwin-arm64.vsix`。変更は未コミット。最終 `git diff --check` 成功。

最終再監査の結果確定: check/build/通常結合/package成功、単体156/156、protocol2/2、live6/6、tools5/5、4経路Host再起動成功。runtimeは11/12成功・ACP並列子1件timeout。実GUIは幅/テーマ・Copy・3経路2turn・CursorSDK Stop再送・AppServer Plan/Build/2子/背景接続/手動Reloadを確認。ACP GUIは追加調査を検証記録に記載。全条件Goにはしていない。
