# 2026-10-18 追補（CI・テスト構成・実Backend）

この追補は2026-10-18の現在の作業ツリーに対する結果です。下の2026-10-17再監査は過去の基準として保持します。現在のHEADは`f874bed99437f5035b43bb5b1cdd072844938038`、branchは`main`、開始時のgit statusはcleanでした。最終時点では今回の変更が未コミットです。versionは`0.10.0`のままで、Commit、Push、Releaseは行っていません。

## Codexモデルカタログの起動失敗

LinuxでCodexのモデル一覧取得テストが`write EPIPE`になるGitHub Actions失敗を調査しました。モデル取得プロセスは`spawn()`直後にinitialize RPCをstdinへ書き込んでおり、子がOS上で起動完了する前に終了すると、macOS/Linuxの終了イベント順序差によってstdin書き込みが先行していました。`src/providers/models.ts`でchildの`spawn`完了を待ってから書くようにし、起動失敗、stdin EPIPE、stdout/stderr終端、終了時にRPCをrejectしてpendingを消去します。実在しないプロセスを起動済みとして残さず、既に終了した子への誤ったkillも避けます。合成プロセス回帰ではOS固有エラー文言を期待せず、ユーザー通知、後始末、セッション状態を検証します。

Node 26.7.0 macOSで`check`, unit 812/812, coverage, hygiene, build, packageに成功。Node 22.23.3 macOSでも`check`, unit 812/812, coverageに成功しました。Host Integrationと実Backend各suiteも成功しています。Linux runnerは利用できず、Push禁止のため修正後のGitHub Actions runは存在しません。修正前のActions run 39081060726の失敗原因は特定しましたが、Actions本体の成功は未確認です。

## テスト整理

開発round/residual/coverage/gapsを含む命名を対象責務が分かるファイル名へ整理しました。Core、Provider、Sidebar、Webviewのテストは既存の大分類を維持し、広すぎたWebview 42件、Sidebar 29件、Provider index 24件を責務で分けました。再帰探索方式、npm scripts、coverage対象は維持しました。誤って重複した同一test body 44件を除去し、背景送信における同一仕様の1ケースをController identityの検証を含むケースへ統合しました。最終812件は全件通過しています。CoverageはLines/Statements 99.74%、Branches 98.97%、Functions 99.89%で、100%には届いていません。

## 実Backend・GUIの更新

今回の実測は[VERIFICATION.md](VERIFICATION.md)と[AUDIT_RUNTIME.md](AUDIT_RUNTIME.md)に記録しました。4経路の基本チャットとResume、対象3経路のPlan/改訂/Build、ファイルツールを実行しました。App Server子2件の重複区間と明示Wait、Cursor ACP子2件の一回の重複実行、背景Terminal出力・停止を確認しました。子専用Stopは停止完了が保証されないため非公開です。ACPの最終本文一致は今回のライブ検証で再確認しました。

実GUIではExtension Development HostのDark・約300px環境で、親WaitingとRunningの子2件、子Aの詳細・親へ戻る操作を確認しました。子Bの詳細結果、390pxやLight/High Contrast、IME、Clipboard画像、GUI Reloadなどは未確認です。DOM/Host/Liveテスト結果で実GUIの不足を補った扱いにはしません。

したがって今回のCI/コード/単体・Live検証は良好ですが、Linux/Actions本体と全GUI・全Prompt Rewind受入は未完了です。**今回の作業は部分完了**であり、v1.0.0移行可否を新たに判定する記録ではありません。

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

検証結果と残存リスクは[今回の検証記録](VERIFICATION.md#final-audit)を参照してください。主要経路すべてのGUI検証と、障害・副作用を組み合わせた受け入れが未完了のため、最終判断は**移行見送り（No-Go）**です。中央Composerやeditorタブがないことは理由に含めません。

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

## 5. GUI・未対応事項・移行可否

**v1.0.0への移行は見送り（No-Go）です。** 実行経路の修復とライブ回帰は進みましたが、以下が残っています。

- 操作ツールで検証用Extension Hostウィンドウを特定できず、300px / 390px・Dark / Lightの実画面とクリック操作による送信・コピー・モデル変更・復元は未検証。テスト用DOM・実Clipboard・Host結合の成功をGUI目視の代用にはしない。
- 動画そのものとのフレーム比較は未実施。中央Composer、New Agent editor surface、会話ごとのdraft/添付保存は追加変更へ分離。
- 全4経路で認証失効・ネットワーク断・実失敗後Retry・全Plan経路の失敗/Stopをライブ網羅したとは扱わない。これらは今回の単体・fixtureと実ライブを区別する。
- Backendが公開していないUsage、子ツール全文・モデル・寿命などを補完しない。取得できない値は未取得/非対応。親Stopは子の終了保証ではない。
- Cursor SDK 1.0.37互換パッチは将来版へ流用しない。バージョン・元ソースSHA256・置換箇所検査を維持する。

詳細: [Provider監査](AUDIT_PROVIDERS.md)、[Runtime監査](AUDIT_RUNTIME.md)、[UI監査](UI_AUDIT.md)。

成果物: `dist/ai-agents-darwin-arm64.vsix`。変更は未コミット。最終 `git diff --check` 成功。

最終再監査の結果確定: check/build/通常結合/package成功、単体156/156、protocol2/2、live6/6、tools5/5、4経路Host再起動成功。runtimeは11/12成功・ACP並列子1件timeout。実GUIは幅/テーマ・Copy・3経路2turn・CursorSDK Stop再送・AppServer Plan/Build/2子/背景接続/手動Reloadを確認。ACP GUIは追加調査を検証記録に記載。全条件Goにはしていない。
# 2026-10-18 追補（CI・テスト構成・実Backend）

この追補は2026-10-18の現在の作業ツリーに対する結果です。下の2026-10-17再監査は過去の基準として保持します。現在のHEADは`f874bed99437f5035b43bb5b1cdd072844938038`、branchは`main`、開始時のgit statusはcleanでした。最終時点では今回の変更が未コミットです。versionは`0.10.0`のままで、Commit、Push、Releaseは行っていません。

## Codexモデルカタログの起動失敗

LinuxでCodexのモデル一覧取得テストが`write EPIPE`になるGitHub Actions失敗を調査しました。モデル取得プロセスは`spawn()`直後にinitialize RPCをstdinへ書き込んでおり、子がOS上で起動完了する前に終了すると、macOS/Linuxの終了イベント順序差によってstdin書き込みが先行していました。`src/providers/models.ts`でchildの`spawn`完了を待ってから書くようにし、起動失敗、stdin EPIPE、stdout/stderr終端、終了時にRPCをrejectしてpendingを消去します。実在しないプロセスを起動済みとして残さず、既に終了した子への誤ったkillも避けます。合成プロセス回帰ではOS固有エラー文言を期待せず、ユーザー通知、後始末、セッション状態を検証します。

Node 26.7.0 macOSで`check`, unit 812/812, coverage, hygiene, build, packageに成功。Node 22.23.3 macOSでも`check`, unit 812/812, coverageに成功しました。Host Integrationと実Backend各suiteも成功しています。Linux runnerは利用できず、Push禁止のため修正後のGitHub Actions runは存在しません。修正前のActions run 39081060726の失敗原因は特定しましたが、Actions本体の成功は未確認です。

## テスト整理

開発round/residual/coverage/gapsを含む命名を対象責務が分かるファイル名へ整理しました。Core、Provider、Sidebar、Webviewのテストは既存の大分類を維持し、広すぎたWebview 42件、Sidebar 29件、Provider index 24件を責務で分けました。再帰探索方式、npm scripts、coverage対象は維持しました。誤って重複した同一test body 44件を除去し、背景送信における同一仕様の1ケースをController identityの検証を含むケースへ統合しました。最終812件は全件通過しています。CoverageはLines/Statements 99.74%、Branches 98.97%、Functions 99.89%で、100%には届いていません。

## 実Backend・GUIの更新

今回の実測は[VERIFICATION.md](VERIFICATION.md)と[AUDIT_RUNTIME.md](AUDIT_RUNTIME.md)に記録しました。4経路の基本チャットとResume、対象3経路のPlan/改訂/Build、ファイルツールを実行しました。App Server子2件の重複区間と明示Wait、Cursor ACP子2件の一回の重複実行、背景Terminal出力・停止を確認しました。子専用Stopは停止完了が保証されないため非公開です。ACPの最終本文一致は今回のライブ検証で再確認しました。

実GUIではExtension Development HostのDark・約300px環境で、親WaitingとRunningの子2件、子Aの詳細・親へ戻る操作を確認しました。子Bの詳細結果、390pxやLight/High Contrast、IME、Clipboard画像、GUI Reloadなどは未確認です。DOM/Host/Liveテスト結果で実GUIの不足を補った扱いにはしません。

したがって今回のCI/コード/単体・Live検証は良好ですが、Linux/Actions本体と全GUI・全Prompt Rewind受入は未完了です。**今回の作業は部分完了**であり、v1.0.0移行可否を新たに判定する記録ではありません。

# 最終再監査（2026-10-17、今回の依頼）
## Release-candidate retest audit — 2026-10-18

Target: macOS arm64 working tree at HEAD 188c892f39695be054b267d2b699453057ebfa64, extension version 0.10.0. The changes were uncommitted at the start and remain uncommitted. No commit, push, release, Linux run, or cleanup of isolated GUI sessions occurred.

### Current candidate changes

Tracked modified files:
- docs/AUDIT.md
- docs/MACOS_ACCEPTANCE_RUNBOOK.md
- docs/VERIFICATION.md
- package.json
- src/chat-controller.ts
- src/sidebar.ts
- test/sidebar/chat-controller-session-switch.test.ts
- test/sidebar/sidebar-retry-image-preservation.test.ts

Untracked file:
- scripts/gui-session.mjs

The code diff preserves saved terminal rows as Unknown after Reload until an exact backend process is reported again. Image Retry now carries the active SessionRegistry conversation key into retryPrepared, which lets the restored webview accept the image-bearing Retry payload. Deterministic regression coverage checks both behaviors. No new production defect was found during this retest.

The package.json change adds disposable GUI-session helper scripts. The helper file is excluded by .vscodeignore along with scripts and tests, so it is not present in the VSIX. package-lock.json is unchanged.

### Verification and package audit

The post-change macOS run passed check, 822 unit tests, coverage, hygiene, build, Host Integration, package, and git diff --check. Coverage was lines/statements 99.75%, branches 98.83%, functions 99.79%. Host Integration used the fixture backend and is not a live service or independent desktop GUI session.

Darwin arm64 package: dist/ai-agents-darwin-arm64.vsix; 1,514 files; 389,151,529 uncompressed bytes; SHA-256 1252a542604725eb8ce727210841730fe0d3f3e16ef518131eb29548e8ca7d89. Archive inspection found no test paths, source maps, auth.json, .env, credential-named files, or local session/workspace paths. One key-shaped string exists in the bundled upstream Codex Mach-O. The same bytes occur in the installed @openai/codex 0.162.1 Darwin arm64 dependency, with matching SHA-256 74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0. No user profile was read; the literal is treated as an upstream binary audit note, not a user credential finding.

### GUI evidence boundary

QVC6kt was not interacted with or cleaned up; its unsent FAIL_TURN and image-a.png remain. lZ1xAG is a separate disposable Mock GUI session with isolated profile, workspace, shared storage, and Codex Home. Its fixture backend is selected and credentialsCopied is false. The launcher receipt reports PID 28937; sandbox process probing is denied.

The lZ1xAG PAGED conversation displayed two fixture terminals as Running. The Terminate action could not be verified because the Computer Use target was stale. A draft entry and navigation to History were observed, but draft restoration after returning to that exact chat was not verified. Copy, long-code horizontal scrolling, Plan View operation, and Build action checks were not completed in the current GUI. An earlier Developer: Reload Window occurred while the chat was blank, so it is not evidence for in-progress work.

Prior QVC6kt evidence for queued content, an unsent draft, subagent Unknown recovery, and terminal Unknown recovery remains cited as prior acceptance only. The fresh retest did not change those historical outcomes.

### Release blockers and decision

- Real Codex App Server image-only and text-plus-image delivery: BLOCKED pending user login in the isolated CODEX_HOME.
- Actual backend Retry with an image and no duplicate remote turn: BLOCKED pending authentication and bounded test execution.
- Normal Turn, Plan-generation, and Build-execution Reload: BLOCKED; the current deterministic fixture does not hold these operations, and no authenticated backend is available.
- Residual GUI Copy/long-code/Plan/Build controls: NOT RUN in this retest.
- Post-change official macOS GitHub Actions: NOT RUN. The success at 188c892f predates these uncommitted changes.

Release decision: NO-GO. Keep the current changes for the next commit review, authenticate only in lZ1xAG after the user completes the handoff, finish the bounded live tests, then commit/push only with user authorization and rerun official macOS CI.
## Authenticated release-candidate retest — 2026-10-18

This is a later checkpoint than the authentication-pending audit above. Target: macOS arm64, HEAD `188c892f39695be054b267d2b699453057ebfa64`, dirty working tree. No Linux run, Commit, Push, Release, normal-profile access, QVC6kt interaction, or GUI-session cleanup occurred.

### Backend and Reload evidence

- Isolated ChatGPT login in lZ1xAG: **PASS**. Codex CLI 0.162.1 and `app-server` were selected only in that disposable profile; Extension Host used the same isolated CODEX_HOME. No authentication material was read or copied.
- PNG-only and text-plus-PNG App Server turns with one synthetic PNG each: **PASS — real Backend**. Request metadata confirmed one `localImage` in each `turn/start`, and UI answers matched Backend answers.
- Retry image restoration and conversation isolation: **PASS — real Backend UI**. The injected failure was at the RPC boundary, not local process launch. The one manual Send failed before `turn/start`; no Backend input or duplicate Turn occurred. Requested local-launch failure: **NOT RUN**; end-to-end Retry: **BLOCKED/FAIL**.
- Ordinary Turn, Plan generation, and Build execution each reloaded in the independent GUI and retained conversation/session/history. Unverifiable active results became Unknown. Plan/Build were not rerun. The disposable Build target retained its original bytes. Dedicated queued-text-plus-image state and Composer draft remained after Reload and did not auto-send: **PASS — real App Server GUI**.
- Existing Background Terminal evidence remains Mock-only. Copy success at 300px, long-code horizontal scroll, and draft persistence after conversation switch were **NOT RUN** in this retest. These are not inferred from Unit or Host Integration.

### Regression suite, package, and tracked tree

The final macOS regression results and current VSIX inventory are recorded in the same-date Verification and Runbook appendices after completion. The passing Host Integration run used official VS Code 1.142.0, a separate temporary app/profile/workspace, a fresh isolated CODEX_HOME, and Mock fixtures. It is not real Backend or active GUI Reload evidence. One earlier attempt hit a transient model-details QuickPick timeout; a fresh run completed all assertions. A separate app-reuse attempt aborted because VS Code's test runner modifies its downloaded app; each attempt thereafter used a fresh disposable app.

The authenticated lZ1xAG CODEX_HOME remains in place for the user's isolated session. No auth file was opened and no session data was deleted. QVC6kt's protected unsent prompt and image remain untouched. The post-`188c892f` working-tree changes still have no official GitHub Actions run. Future Commit/Push requires explicit authorization, and the official macOS Actions workflow must be rerun afterward.

### Release decision

**NO-GO for v1.0.0.** Real image delivery is PASS, and the real App Server Reload cases are PASS with uncertainty preserved as Unknown. Retry does not meet acceptance: the requested local process-launch failure was not reproduced, and the only authorized manual Send failed before Backend dispatch. Residual Copy/long-code/draft-switch GUI items are also not complete. No release action is authorized or performed.

### Final checks and VSIX inventory — 2026-10-18

The final Phase 1 run on macOS arm64 passed `check`, Unit 822/822, coverage (Lines/Statements 99.75%, Branches 98.83%, Functions 99.79%), hygiene (431 assets), build, Host Integration, package, and `git diff --check`. Host Integration used official VS Code 1.142.0 with temporary isolated app/profile/workspace and fixture backend. An initial DNS failure and one transient model-details QuickPick timeout were followed by a fresh successful run of all assertions.

The generated Darwin arm64 VSIX has 1,514 files, 389,151,529 uncompressed bytes, 144,110,947 compressed bytes, SHA-256 `2e699714e864c6cde09fb195f6cf226d2b5858166db27f82ab5c26e7f585d126`. Package scanning found no auth.json, .env, private-key header, test path, source map, or local session/workspace marker. Six files named `credential-store.d.ts` or `stored-credentials.d.ts` are dependency type declarations from Cursor SDK and contain no auth material. The only key-shaped scan match is in the bundled Codex Mach-O; its SHA-256 exactly matches the installed `@openai/codex-darwin-arm64` dependency (`74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0)). It is an upstream static literal, not a user credential.

Current modified files: `docs/AUDIT.md`, `docs/MACOS_ACCEPTANCE_RUNBOOK.md`, `docs/VERIFICATION.md`, `package.json`, `src/chat-controller.ts`, `src/sidebar.ts`, `test/sidebar/chat-controller-session-switch.test.ts`, and `test/sidebar/sidebar-retry-image-preservation.test.ts`; untracked: `scripts/gui-session.mjs`. No package-lock/auth files changed. The worktree remains uncommitted.

The Release decision remains **NO-GO** for the Retry local-launch acceptance blocker and unrun Copy/long-code/draft-switch GUI items. The official GitHub Actions success at `188c892f` predates this dirty tree. Rerun the official macOS workflow after any future authorized Commit/Push.

## Final audit update — Plan card and in-sidebar detail — 2026-10-18

Target remains HEAD `188c892f39695be054b267d2b699453057ebfa64`, extension `0.10.0`, macOS arm64, dirty worktree. Existing user changes and the supplied recording were kept. No commit, push, release, Linux run, normal-profile access, or auth-file inspection occurred.

The extension now renders a compact completed-Plan card with a source label, summary derived from the actual plan text, `View Plan`, and explicit `Build`. View Plan expands the document in the existing sidebar and preserves the Composer draft; it does not start implementation or open an editor tab. Expansion restoration is scoped by conversation/session and Plan ID. Restoring an unsettled legacy Plan maps it to `unknown` rather than Buildable `ready`. Unit/Webview coverage verifies those guards and interaction behavior.

### Evidence

- **PASS — Unit/Webview:** 823/823; `npm run check`, coverage, and hygiene (432 assets) passed.
- **PASS — Host Integration:** official VS Code 1.142.0 on macOS arm64, separate app/profile/workspace and fixture backend; all assertions passed.
- **PASS — Direct GUI/Mock:** isolated VS Code 1.142.0 session `/private/tmp/ai-agents-gui-acceptance-Lq8H0J` showed the compact card and same-sidebar Plan detail. Draft survived detail navigation and Reload. Checked at approximately 300 CSS px in Dark theme. This does not demonstrate live service rendering, history-selected resume, Copy, IME, Light/High Contrast, or 390px behavior.
- **PASS — Real Backend runtime integration:** Codex App Server Plan → revision 2 → one Build, same Session, exact model ID `gpt-6-luna`; no file edit occurred during Plan. This is a test runtime, not direct GUI evidence.
- **PASS — Packaging:** Darwin arm64 VSIX contains 1,514 files; 144,111,673 bytes; SHA-256 `caa6ac956ca44e19222e86b8c165e26617c62d89b156d237a0936e7b225ddc4f`.
- **PASS — whitespace:** `git diff --check` passed after implementation, package generation, and all documentation updates.

Codex model catalog confirmed `gpt-6-luna` and separate `gpt-5.6-luna`; Cursor's current account catalog was not queried. The current direct GUI session uses a deterministic Mock. The prior authenticated App Server image-only and text-plus-image PASS remains a same-day historical retest; the requested Retry local process-launch failure and successful Backend dispatch remain **NOT RUN / BLOCKED** after the single pre-dispatch failure. Live Subagent parallel execution and Background Terminal reconnection remain unverified. The 390px, Light, High Contrast, live IME, Clipboard, and long-output GUI acceptance matrix is incomplete.

The newest runbook and verification details are in `docs/MACOS_ACCEPTANCE_RUNBOOK.md` and `docs/VERIFICATION.md`. v1.0.0 remains **NO-GO**. The current tree has 17 modified tracked files plus pre-existing untracked `scripts/gui-session.mjs` and the supplied MOV. `package-lock.json` is unchanged. Official macOS GitHub Actions still needs a future authorized Commit/Push; no release action has been taken.

## 2026-10-19受入追記 — 実GUI＋実Backend

前節までの結果を消さず、今回の隔離macOS GUI再試験を追記する。開始・終了HEADは `188c892f39695be054b267d2b699453057ebfa64`、拡張版は `0.10.0`。開始時のdirty worktree（17 tracked filesと既存のGUI helper・録画）を保持し、Commit/Push/Release、Linux、通常profile、実研究workspaceは使用していない。認証済み隔離 `CODEX_HOME` と公式VS Code 1.142.0の隔離アプリ/profile/extensions/shared-dataだけを使い、認証内容は読まず複写していない。故障注入wrapperと待機fixtureは `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/acceptance-20261019` 内のtest-onlyファイルで、配布物・製品コードに追加していない。

- **PASS — 実GUI＋実Backendの画像Retry。** 前回の失敗注入はBackendプロセス起動後のRPC境界であり、`thread/resume no rollout found` のため `turn/start` 前に止まった。これは求めたローカル起動失敗を試せていなかった試験条件の不一致だった。今回は準備後にatomic one-shot gateをarmしたtest-only launcherで本物のCLI起動を1回だけexit 73にし、marker/count=1、初回Backend受理=0を確認。隔離GUIの画像Retryを押すと同じ会話の画像draftへ戻り、自動送信しなかったため、GUIのSendを1回実行した。実App Serverは同じ176-byte `image/png`、SHA-256 `c9a7c2bf14f6634983265524f47fcc9b94dc412491f4f4f9f19de66a4369f0f1` を1回だけ受理・完了し、最終回答も1件。初回Turn `15d1e927-3c66-4b6d-a0d8-e125502993b2` はBackend IDなし。retry会話 `4c80c939-461d-4a99-915a-d4c88933c698`、Backend Session `01a14f91-d110-73d2-b907-e4da129f7faa`、Turn `01a14f91-d180-7ed0-8790-c3b40e30cc9b`、モデル `gpt-6-luna`。別のtext+same PNGも1 Turn受理・完了。短い通常テキストGUI送信も先に成功させた。
- **PASS — 実GUIからPlan→View Plan→Build完了。** 会話 `c0e701cd-c82b-4dbb-8ef3-9d5a61aa394e`、Session `01a14f93-3626-76f3-8f93-50154608e408`、Plan `ab1283cf-97f1-4084-a675-05c6741c4a7a` revision 2。GUIで一度Plan改訂し、View Planを開閉、Build前に対象ファイルが無いことを確認。GUI Buildを1回押すと `Building` になり、同じSessionへ実Backend `gpt-6-luna` のBuild Turn `01a14f94-2052-7370-937b-e8e238e1c6fd` が1回dispatch・完了した。`gui-plan-build-result.txt` は `plan-to-build passed.`（21 bytes、SHA-256 `3dd40677e65807de6b4d821848eea8c731af73bc636749e981bf52f60e08ebe0`）、READMEは不変。完了後のHistory再表示でも実装済みBuildをreadyへ戻さず、再Buildは開始していない。
- **PASS — 3件とも実行中に実GUI Reload。実行継続は3件ともNOT CONFIRMED。** 詳細なSession/Turn/Workspace比較をRunbookに記録。Reload後に同一Sessionへ `thread/resume` したが、旧App Serverプロセスは終了し、同じTurnの完了イベント・待機コマンド継続・Finalは観測しなかった。履歴選択後のGUI表示はUnknown、再送なし。Planの生成途中、Buildのrevision 1と実行状態もUnknownで、Buildは無効。待機ゲート実行プロセスと成果物が無いこと、README/runnerの基準hash不変を照合。よって安全な状態復元はPASS、処理継続・完了・再接続はPASSではない。

実GUIのCodex UsageはPlan 47,863 tokens、Build 36,018 tokens、合計 83,881 tokens（内訳はRunbook記載）。実GUIのContext内訳と構造化To-do進捗は未報告であり、To-do完了は主張しない。今回production source/package変更は無く、Retry/Planの新規製品不具合も再現しなかった。

今回の3項目のうち画像Retryと実GUI Plan→BuildはPASS。3種の実行中Reloadは安全なUnknown復元のみPASSで、実行継続は未確認のため受入未完了として残す。Cursor Composer 2.5の現カタログ／経路、300/390 CSS px × Dark/Light/High Contrast全組合せ、実IME/Clipboard、長い出力、live Subagent並列、Background Terminalの実プロセス／再接続、live Context Usage／To-doは次バッチ。v1.0.0は引き続き**NO-GO**。

## 2026-10-19 v1.0.0ローカル候補監査

判定は**NO-GO**。必須受入の詳細は[V1_ACCEPTANCE.md](V1_ACCEPTANCE.md)、実行結果とGit手順違反は[VERIFICATION.md](VERIFICATION.md)の最新節を参照。

- 正式version1.0.0、publisher/name維持、target darwin-arm64、pre-release指定なし。manifest/src version/lock整合。既存UNLICENSEDを維持し、新たなライセンス許諾は追加していない。ビューアイコンSVG、翻訳JSON、repository、entry pointを確認した。API型定義は1.109.0、実Hostは1.142.0。minimum engine1.109.0の実機試験は未実施。
- packagingはworkspace lockのresolved/integrityを用いてstandalone lockを作り、`npm ci --omit=dev --ignore-scripts`する。新たな依存更新やpublish、Git hookは行わない。managed-worker.cjsとユーザー向け3資料を収録。
- VSIX bytes144,142,421、entries1,518、SHA-256 `9e96459d8b37d330b8d653c44252eedc82079f3b8f87ee01685928d151a1636c`。全entry実内容をbytesとして走査し、必要CLI/SDKと実行権限を確認。test/録画/helper/fault wrapper/gate/log/auth.json/.env/source mapの混入なし。
- 認識したZIP/gzip/tarはdepth3・member128MB上限で再帰検査するscannerを使用したが、この候補内に該当nested archiveは検出されなかった。暗号化/custom圧縮、難読化、未知形式の秘密値の不存在を保証する検査ではない。
- vendor native binary5 entriesにビルド元のhome path形文字列がある。ローカル固定依存と内容SHAが完全一致するvendor由来として記録し、必要なCLI/SDKを削除していない。今回の秘密値パターン一致はなし。matched valueや個人パス本体をscan logへ出力していない。
- Marketplace公開queryは0件、Open VSXの同版APIは404、GitHub releases APIは空配列。公開直前の再確認は公開担当者が行う。公開操作はしていない。
- 旧0.10.0実VSIXは144,111,673 bytes、SHA `caa6ac956ca44e19222e86b8c165e26617c62d89b156d237a0936e7b225ddc4f`で保持。実更新/復旧は未受入。

ソース入力manifest、lockfile hash、基準HEAD、開始/終了Git比較、ツール/OS、検証log、VSIX content auditは`dist/release-1.0.0-darwin-arm64/`に保存する。これは未コミットの成果物でありrelease commitは存在しない。初回suiteでの一時fixture内禁止Git操作を含むため、手順遵守の全体PASSは宣言しない。

接続仕様の一次資料は[Codex App Server公式文書](https://learn.chatgpt.com/docs/app-server)。使用版CLI0.162.1の`generate-ts`出力もローカルに保持した。WebSocket一般接続の実験的扱いやthread/resumeの履歴復元だけを、同一プロセス/Turn継続の根拠にはしていない。

追加live結果: Subagentはgpt-6-lunaの実A/B・親Waiting・Aだけ完了・両方完了・親Final1件をruntimeで照合。Background Terminalは同じprocessIdへの再接続・起動1回・追加stdout・Terminateを確認したが、初期stdoutは実stream/listに現れずFAIL。詳細はVerificationの最新節。これらをGUI受入へ昇格せずNO-GOを維持する。observer/待機script/ログはrepo/package外に置いた。


## 2026-10-19 JST 再開後の最終bytes受入（未コミット）

最終VSIXは`ai-agents-1.0.0-darwin-arm64.vsix`、144,142,863 bytes、1,518 entries、SHA-256 `4202d076c1c4b9851c5fa3d7c4b6067a6bf17eb504f6153be31b9645c6b72c90`。
**判定はNO-GO**。以下のPASSで、表の他の必須FAIL/NOT RUNを相殺しない。
資料更新前の候補`28ce83b9…`と、資料更新後のこのbytesを区別した。
資料更新後にインストールし直し、通常/Plan/Buildの実行中GUI Reloadをすべて再試験した。

| 実GUI＋実Backend＋最終VSIX | Session | Backend Turn | owner / App Server PID | Final |
|---|---|---|---|---|
| ordinary PASS | `01a15118-1347-7b71-bc7f-a80bd1543b0b` | `01a15118-1398-7233-af4c-b99a2764abda` | 22145 / 22149（前後同一） | 1 |
| plan PASS | `01a15118-bef9-7cc3-9783-5400ecb7bdb6` | `01a15118-bf36-73c0-a74e-bcf85e7e4f15` | 22476 / 22478（前後同一） | 1 |
| build PASS | `01a15119-d2f3-7602-ac3d-8c501fcbaaa9` | `01a1511a-3ffb-7c02-968e-5c903c39dc4d` | 22848 / 22850（前後同一） | 1 |

各ケースは別の合成workspace・会話。Backend受理と実Python待機プロセスを確認後、完了前にGUIのReload Windowを実行した。
Extension Host PIDは変化し、元のowner・App Server PID・local Turn ID・Backend Turn ID・Sessionを保持した。
復帰時もrunningかつ成果物なし。その後に外部ゲートを解放し、同じTurnがcompletedになった。
通常/Buildの成果物は`installed continuity passed.\n`の29 bytes（SHA-256 `2a94ec653437404acf0709996049833797df02d3e6d175de9f5dea173a00e6bd`）。
Planは成果物なしでready。Buildは同じPlan ID/版のままimplemented、GUIではBuild finished・Build無効。
各Queueは1件を保持し、別Turnの自動dispatchなし。各Composer draftもReload前後で一致した。
Usageの照合値、message ID、プロセス一覧、Plan全状態はreceiptを参照。実在しない子/Terminalの検証はこの3ケースへ含めない。

実装修正: 親のstream deltaに親threadIdをsubagentIdとして渡していた箇所を修正した。親本文とstdoutが存在しない子へ流れない回帰を追加。
Gitを変更していたUnit fixture setupは、実ファイル＋明示的なGit応答mockへ置換した。Git実行ファイルとの統合PASSを主張しない。

Keychain修正: 専用GUIランチャーとHost Integrationに`--use-inmemory-secretstorage`を追加。
古い設定の隔離アプリを終了し、以降の起動/ReloadでCode Keyダイアログなし。通常Keychainの削除・初期化・権限変更はしていない。
`--password-store`による平文保存への切替もしていない。試験用SecretStorageはメモリ内、許可済みCLI認証の内容は出力/複写していない。

最終bytesの0.10.0実VSIXからの更新はPASS。会話/Session、Plan ID/版/ready、完了Turn、Usage、日本語draftを保持。
更新前のUser/storageを13ファイルのhash付きでバックアップし、戻しての1.0.0再試行をPASS。
旧VSIX＋旧バックアップのダウングレードもPASS。1.0.0が新規保存した全状態を0.10.0が読めるという判定ではない。

実macOS Kotoeri日本語入力は、native keyの`nihongo`→未確定`にほんご`→Spaceで`日本語`→Return確定を確認した。
確定Enterで送信・Plan改訂・Usage増加はなし。Shift+Returnで改行、変換中のモデルメニュー、履歴へ戻ってのdraft保持も確認。
既存仕様は「本文draftはComposer全体で保持、画像draftは会話ごと」。新規会話への本文draft保持を仕様変更していない。
本文CopyはGUI Copy→native Command+VでComposerへ同じ本文を貼り付けてPASS。コードCopyと画像ClipboardはNOT RUN。
IME確定/改行/メニュー・本文Copyは資料更新後の最終bytesでも再確認した。

Cursorは隔離CLIのfile credential storeでログインし、現在のカタログID`composer-2.5`を確認。
ACPで2送信・同じSessionの履歴再開・Stop AbortErrorをruntime直接確認した。2送信目の文言は指定した単語だけにならず、応答内容の厳密一致PASSにはしない。
SDK 1.0.37の公開型`SdkLoginOptions`/`SdkLoginResult`/`StoredSdkCredentials`は標準loginがAPIキーを発行する経路である。
CLIログイン後もSDKカタログは未ログインで停止した。今回APIキー発行/課金への切替は実行していない。既定Cursor SDK主経路の必須受入はブロックしたまま。

App Server 0.162.1生成型では`ThreadTokenUsage`はtotal/last/modelContextWindow、内訳は入出力/cached/cache-write/reasoning/total。
Contextの占有量・system/tool等の内訳とは別物で、占有率を作らない。`TurnPlanUpdatedNotification`は存在するが、以前のlive要求では通知0件。
構造化To-doのlive GUI受入は未完了。Terminal初期stdoutも前回の実stream/listでは欠落、completed時にaggregatedOutputへ現れた。
これは未解消のFAILであり、Backend全般の能力欠如という結論へ広げない。

receipt: [../dist/release-1.0.0-darwin-arm64/20261019-final/](../dist/release-1.0.0-darwin-arm64/20261019-final/)。基準HEAD、source入力manifest、lockfile hash、Git差分・stage保持、ツール版、内容監査を同梱する。


### 最終Host検証と試験上の失敗の扱い

メモリ内SecretStorageフラグを加えた最終Host IntegrationはPASS（公式VS Code1.142.0、Host Node24.21.0、macOS arm64、Node22.23.3 launcher）。隔離app/profile/workspaceと全assertion完了のreceiptを取得した。
最初のフラグ追加後runはモデルQuickPick待ちでtimeoutした。同時に別の専用GUIを操作していたためフォーカス干渉が疑われ、GUI操作を重ねない独立runで通過した。確定した製品不具合という判定にはしていない。
最初のinstalled試験はtest runnerがReloadで終了したため、その実行の成功を最終bytesの受入へ流用していない。
資料更新後の最初の起動もVSIX再インストール完了前の試験準備として中止し、別workspaceのordinary-final-v2で再実施した。
採用した最終3ケースはordinary-final-v2 / plan-final / build-finalのみ。

最終check（Node22/26）、831件全suite（Node22/26）、coverage（831件、Statements/Lines99.26%、Branches98.18%、Functions98.06%）、hygiene443、build、packageはPASS。
Node22での再試験はCIのNode22系との整合のために実施。資料追記だけで同じ全suiteを繰り返していない。
今回のguardが拒否したGit fixture起動は、実行成功として数えていない。初回の拒否を確認した後、fixtureをMockへ置き換えて全suiteを完走した。
過去の禁止Git操作違反を記した節は歴史記録として保持する。今回のGit HEAD/branch/stage比較は最終receiptを参照。
