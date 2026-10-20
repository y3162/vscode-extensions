# v1.0.0 最終bytes受入表 — 2026-10-19 Candidate 4

この節が現在の唯一の判定表です。対象はmacOS arm64用、非prereleaseのv1.0.0候補です。Candidate 1〜3の証拠はCandidate 4へ転記していません。

- Source: `HEAD 188c892f39695be054b267d2b699453057ebfa64`、branch `main`。作業開始前からworktreeはdirty、indexは空。既存変更を保持し、Git状態変更を行っていません。
- 最終候補: `dist/ai-agents-1.0.0-darwin-arm64.vsix`、144,147,050 bytes、SHA-256 `cd661494fbddfda99887cfa8f0b6d12b1ac0c92dad205bf4bc530bf1a6cd6a2a`。
- **判定: NO-GO。** このSHAでUnit/Mock、Host Integration、インストール、native GUIの一部を観測しました。実Backend認証、6セルGUI、0.10.0実VSIX更新などの必須受入が残っています。
- Receipt: `dist/release-1.0.0-darwin-arm64/20261019-final-v4/receipt.json`。SHA一覧: `dist/release-1.0.0-darwin-arm64/20261019-final-v4/SHA256SUMS`。

| 要求 | Backend | 検証階層 / 対象SHA | 判定 | 実測・再開条件 |
|---|---|---|---|---|
| Terminal初期出力の回復・欠落の明示 | Codex App Server | Unit/Mock、Source runtime + Mock、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | Source側のsnapshot照合・警告・UTF-8分割テストPASS。Installed VSIXのMock fixtureでは起動直後の`EARLY_READY`が画面に表示されたが、同時に完全性警告も表示。実Backendの初期bytesはこのSHAで未受入。旧SHA `4202d076…72c90` のlive FAILは履歴として残す。 |
| Terminal自然終了・末尾出力・Stop・Terminate・Reload・同一process再接続 | Codex App Server | Unit/Mock、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | Source Mockでは履歴snapshot、同一thread再接続、再dispatchなしを検証。候補VSIXではMock Terminal表示後にTerminateを操作し、行が消えることを確認。実PID/bytes、自然終了、親Stop、Reload中の実process維持は未受入。 |
| Codex App Server実Backend最終候補受入 | Codex App Server | Source runtime + live Backend / Installed VSIX + live Backend。`cd661494…6a2a` | **BLOCKED** | 隔離`CODEX_HOME`は未ログイン。machine-scope設定をworkspaceへ置いた初回GUI試験では bundled App Server が誤選択されたためsynthetic Turnを停止し、managed ownerの`dispose`で終了。認証済み実Backendとしては数えない。通常profileや資格情報は使っていない。正規の隔離認証後に実Backend受入を再開する。 |
| Cursor SDK既定経路・Composer 2.5 SDK ID・会話・履歴・Stop・Retry・画像・Usage | Cursor SDK | Source runtime + live Backend / Installed VSIX + live Backend。`cd661494…6a2a` | **BLOCKED** | 隔離`CURSOR_HOME`は未ログイン。通常Cursor資格情報を複写せず、SDKからACP/APIキー経路へ切替えていない。正規SDK認証後に再開する。CLIで以前観測した`composer-2.5`はSDK受入に使わない。 |
| Plan改訂・Turn所有・部分失敗・Build再開と二重dispatch防止 | Codex App Server / Cursor SDK | Unit/Mock、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | 古いTurnの遅延Plan/To-do通知を新しい改訂から隔離する回帰テスト、成功改訂のrevision更新、失敗改訂で既存Plan保持、Build失敗後の明示再試行テストがPASS。GUIではPlanを選択してMockを送ったがView Plan本文/Build操作を確証できず、live GUI受入なし。 |
| Subagent A/B、親Waiting、詳細、draft、Reload、遅延通知 | live対応Backend | Unit/Mock履歴あり。最終候補のlive/native GUI。`cd661494…6a2a` | **BLOCKED** | Candidate 4で子A/Bのlive通知やGUI詳細は再受入していない。隔離実Backend認証後、最終VSIXで実通知を確認する。過去source runtimeの結果は歴史に限定する。 |
| 300/390 CSS px × Dark/Light/High Contrastの6セル | Webview | Installed VSIX + native GUI。`cd661494…6a2a` | **PARTIAL** | Dark themeのnative画面で会話・Composer・Terminalを観察したが、CSS幅は固定計測していない。6条件それぞれの指定コンテンツ、overflow、focus、contrastを確認していないためPASSセルは0。残り5条件と厳密計測を行う。 |
| Composer IME、本文/コードClipboard、画像、Queue、Retry | Webview / Codex App Server / Cursor SDK | Unit/Mock、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | 候補VSIXで通常ComposerからMockを送信し応答を表示。日本語IME、native Clipboard、画像、Queue/Retry、失敗後の明示Sendはこのbytesで未確認。実Backend受入後に継続する。 |
| Usage / Context / 構造化To-do | Codex App Server / Cursor SDK | Schema / Unit、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | backend値がないMock GUIでは`未取得 / Not reported`を表示し、0として捏造しないことを確認。Token usageとContext占有量の型を分けるsourceテストPASS。live To-do通知、Context使用量/内訳の表示は未観測。 |
| Backend/Session/Plan/Retry/Stop/再接続の総合失敗・回復経路 | Codex App Server / Cursor SDK | Unit/Mock、Source Host、Installed VSIX + native GUI + Mock。`cd661494…6a2a` | **PARTIAL** | 836件のMock/unitとHost Integration、managed ownerの1回Reload継続を検証。全てのlive failure/recovery組合せ、Cursor SDK、画像失敗等は未受入。 |
| 最終VSIXの有効化、Webview ready、基本Mock送信 | VS Code Host / Mock App Server | Installed VSIX + native GUI、`cd661494…6a2a` | **PASS** | 通常の隔離extensions dirへCLI installし、VS Code 1.142.0でCandidate 4をGUI起動。Activity view、Webview ready、Composer、Mock応答を観測。実Backend機能や6-cell受入のPASSではない。runbookに起動条件と結果を記録。 |
| 0.10.0実VSIXからの更新・復旧・旧版戻し | VS Code隔離profile | Installed VSIX。`cd661494…6a2a` | **BLOCKED** | exactな`ai-agents-0.10.0-darwin-arm64.vsix`を作業対象と一時領域で発見できず、代替物は作成していない。実VSIXと対応backupが揃った後に再開する。 |
| check / tests / coverage / hygiene / build / Host Integration | Node 22/26、VS Code 1.142.0 | Unit/Mock + Source Host、候補SHAに対応するsource | **PASS** | Node 22.23.1 / 26.7.0で`check` PASS、各836/836 PASS。Coverage: statements/lines 99.27%、branches 98.09%、functions 98.06%。Hygiene 443 files、build、package、Candidate 4 payload Host Integration PASS。各ログはreceipt参照。 |
| VSIX version/platform/archive/vendor/secretとクリーンインストール | darwin-arm64 / VS Code CLI | Installed VSIX、`cd661494…6a2a` | **PASS** | 1.0.0、prereleaseなし、`darwin-arm64`、1,518 archive entries / 1,516 payload files。archive integrity、必要vendor、test/fixture pathなし、653 text filesのsecret/local-path scan 0件。隔離install後1,515 files byte一致、metadata除外後`package.json`一致、manifest一致。 |
| Marketplace / Open VSX / GitHub Releasesの版衝突読取 | 公開API（read-only） | 2026-10-19 08:31 JST、Candidate 4 version | **PASS** | Marketplace HTTP 200・一致0件、Open VSX HTTP 404・未登録、GitHub Releases HTTP 200・0件。API応答hashはreceipt参照。読み取りのみで公開操作なし。 |
| Git・ユーザー環境・公開禁止 | 該当なし | 読取専用Git確認 / isolated temp profile | **PASS** | HEAD `188c892…`、branch `main`、index空を保持。通常Code/Cursor profile、通常Keychain、研究workspaceを変更せず、公開も未実施。過去のfixture Git操作違反記録は削除していない。 |

## Candidate 4: Plan通知のTurn所有修正

App Serverの`turn/plan/updated`通知に含まれるbackend `turnId`をproviderが落としており、Controllerも通知callbackの現在Turnを優先していました。そのため遅れて届いた旧TurnのPlan/To-do通知が、現在のPlan draftや進捗として扱われ得る経路がありました。Candidate 4ではproviderがPlan、item、usage、diff更新にbackend turn IDを維持し、ControllerがbackendTurnIdから元のlocal Turnを解決して、現Turn以外から届いたPlan/To-do更新を破棄します。

`test/sidebar/chat-controller-plan-state.test.ts`は旧Turnから遅延したlive/background Plan/To-doが改訂へ混入しないこと、成功した改訂だけrevisionを進めること、失敗改訂が最後に確定したPlanを保持することを検証します。Build失敗後の状態と、明示操作による再試行も別テストで確認します。Candidate 4対象のNode 22/26全suiteは各836/836 PASS。providerの`turn/plan/updated` normalization testもbackend turn ID保持を検証します。

## Candidate 4: Terminal証拠範囲

Candidate 1 (`4202d076…72c90`)では実Backendで初期stdout欠落を確認しました。候補2以降のsource修正は同一threadの`thread/items/list`からitem ID→turn ID→`aggregatedOutput`を照合し、回収不能時は完全性警告を表示します。履歴探索を最大20ページ×100 items、最大10秒に制限し、Reload時にcommandを再実行しません。Candidate 4では追加のlive Backend認証がなく、source Mock回帰とInstalled VSIX Mock GUIで観察した範囲に留めています。GUI fixtureでは`EARLY_READY`を表示できましたが、fixture固有の警告も表示したため実Backendの初期stdout PASSではありません。

## Candidate 4: 集計

現候補で確認済みFAILは0件。必須未完了11グループの内訳は**PARTIAL 7 / NOT RUN 0 / BLOCKED 4**です。過去の初期stdout live FAILは旧SHAに固定して保持し、新候補のPASSまたはFAILへ転記していません。すべての必須項目が完了するまでNO-GOです。

1. 正規の隔離Codex App Server / Cursor SDK認証が可能になったら、実Backendの通常Turn、Plan、Build、Terminal、Subagent、Usage/To-do、失敗/復帰試験をCandidate 4で再開する。
2. exactな0.10.0 VSIXと対応profile backupを用意し、更新・失敗復旧・旧版戻しを隔離環境で実施する。
3. Candidate 4を隔離GUIで300/390 CSS px × Dark/Light/High Contrastへ固定し、6セルの全指定コンテンツ・overflow・focus・操作領域・contrastを撮影/計測する。IME/Clipboard/画像/Queue/Retryも分けて受入する。
4. 結果が変わるsource修正をした場合は新VSIXを生成し、SHAを更新して同一bytesで必要な最終受入を再実施する。


---

## Previous acceptance history (superseded; retained)

## Candidate 2 acceptance table (historical; superseded by Candidate 4)

以下はCandidate 2当時の判定表です。現在の判定は冒頭のCandidate 4表を参照してください。

- Source: `HEAD 188c892f39695be054b267d2b699453057ebfa64`、branch `main`。開始時からworktreeはdirty、indexは空でした。既存変更を保持し、stage/commit/pushは行っていません。
- 最終候補: `dist/ai-agents-1.0.0-darwin-arm64.vsix`、144,146,761 bytes、SHA-256 `27f1a452cfbde272f9683aa1f9832fef55834401b4b6ef047a56171ab3fed46f`。
- **判定: NO-GO。** このSHAでPASSしたテスト・パッケージ・隔離CLIインストール・VSIX payloadのHost activationは記録します。別SHAの過去GUI/Backend PASSは引き継ぎません。
- Receipt: `dist/release-1.0.0-darwin-arm64/20261019-final-v2/receipt.json`。SHA一覧: `dist/release-1.0.0-darwin-arm64/20261019-final-v2/SHA256SUMS`。

| 要求 | Backend | 検証階層 / SHA | 判定 | 実測・再開条件 |
|---|---|---|---|---|
| Terminal初期出力の回復・欠落の明示 | Codex App Server | Unit/Mock、Source runtime + Mock。最終候補source | **PARTIAL** | Terminal回帰4件、UTF-8分割JSON-RPC、DOM警告表示がPASS。実Backendが稼働中に完全snapshotを返すか、このSHAで未検証。最終VSIX + live Backendで再受入する。旧SHA `4202d076…72c90` の実Failは履歴に残す。 |
| Terminal自然終了・末尾出力・Stop・Terminate・Reload・同一process再接続 | Codex App Server | Source runtime + live Backend / Installed VSIX + live Backend、SHA `27f1…fed46f` | **NOT RUN** | Mockで同一thread/process再接続、履歴snapshot回収、`turn/start`なしを確認。今回の候補で実processの終了競合・PID・bytesは未受入。 |
| Codex App Server実Backend最終候補受入 | Codex App Server | Source runtime + live Backend / Installed VSIX + live Backend | **BLOCKED** | 隔離`CODEX_HOME`の`codex login status`は`Not logged in`。ログイン要求や通常profileのcredential利用はしていない。正規の隔離認証後に通常Turn、Plan、Build、Terminal、To-doを再実行する。 |
| Cursor SDK既定経路・Composer 2.5 SDK ID・会話・Stop・Retry・画像・Usage | Cursor SDK | Source runtime + live Backend / Installed VSIX + live Backend | **BLOCKED** | 隔離`CURSOR_HOME`の`cursor-agent status`は`Not logged in`。過去CLIの`composer-2.5`結果はSDK結果へ転記しない。正規SDKログイン後に再開する。 |
| Plan改訂・部分失敗・Build再開と二重dispatch防止 | Codex App Server / Cursor SDK | Unit/Mock・Source Hostあり。最終VSIX + live Backend | **NOT RUN** | Plan/Build状態テストとHost IntegrationはPASS。改訂中Reload、旧Plan保持、失敗後Build、live GUIをこの候補で受入していない。 |
| Subagent A/B、親Waiting、詳細、draft、Reload、遅延通知 | live対応Backend | Unit/Mockあり。最終VSIX + live Backend + native GUI | **BLOCKED** | 過去source runtimeでのA/B並列と親復帰は履歴に残す。今回の最終bytes GUIは未観測。隔離GUI復旧後に再受入する。 |
| 300/390 CSS px × Dark/Light/High Contrastの6セル | Webview | DOM/Unitあり。最終VSIX + native GUI | **BLOCKED** | 6セルの指定コンテンツを今回確認していない。スクリーンショット、実CSS幅、overflow、focus、操作領域の確認が必要。 |
| Composer IME、本文/コードClipboard、画像、Queue、Retry | Webview / Codex App Server / Cursor SDK | DOM/Hostあり。最終VSIX + live Backend + native GUI | **BLOCKED** | 既存sourceテストはPASS。候補bytesで実Clipboard・IME・画像Retry・Queue Reloadは未受入。隔離GUIとBackend認証後に確認する。 |
| UsageとContext占有量・構造化To-do | Codex App Server / Cursor SDK | parser/schema/Unit。最終VSIX + live Backend + GUI | **PARTIAL** | App Server tokenUsageの`last`をContext占有量として使わない修正を維持。schema/mockは検証したが、この候補でlive To-do通知・Context表示を観測していない。 |
| Backend/Session/Plan/Retry/Stop/再接続の総合失敗・回復経路 | Codex App Server / Cursor SDK | Unit/Mock、Source Host。最終VSIX + live Backend | **NOT RUN** | 834件suiteのPASSは全live failure/recovery組合せの受入ではない。外部依存経路をこのSHAで再確認する。 |
| 最終VSIXの有効化とWebview ready | VS Code Host | VSIX payload + isolated Host、SHA `27f1…fed46f` | **PARTIAL** | 2026-10-19の隔離VS Code 1.142.0 Host Integrationで、`/private/tmp/ai-agents-vsix-final-20261019/extensions/y3162.ai-agents-1.0.0`を`--extensionDevelopmentPath`から読み込み、Extension Host Node 24.21.0、activation、sidebar Webview ready handshake、統合assertion全件PASS。ログ: `/private/tmp/ai-agents-installed-vsix-host-final.log`。通常のextensions directoryからの自動検出起動、native GUI、6 layout、実Backendは未受入。 |
| 0.10.0実VSIXからの更新・復旧・旧版戻し | VS Code隔離profile | Installed VSIX | **BLOCKED** | 実物`ai-agents-0.10.0-darwin-arm64.vsix`はrepositoryと既存temporary rootsに見つからなかった。代替物は再構築せず、更新PASSを主張しない。 |
| check / tests / coverage / hygiene / build / Host Integration | Node 22/26、VS Code 1.142.0 | Unit/Mock + Source runtime + Mock + Extension Host | **PASS** | Node 22.23.1 / 26.7.0: check PASS、各834/834。Coverage 99.27% statements/lines、98.09% branches、98.06% functions。Hygiene 443 files。Source Host Integrationとready handshake PASS、Host Node 24.21.0。 |
| VSIX version/platform/archive/vendor/secretとクリーンインストール | darwin-arm64 / VS Code CLI | Installed VSIX、SHA `27f1…fed46f` | **PASS** | 1.0.0、非prerelease、darwin-arm64、1518 archive entries。integrity PASS、test/fixture paths 0、required vendor filesあり。652 text filesのsecret/local path scan 0件。隔離CLI install後1515 payload files一致し、package.jsonはinstaller metadataを除き一致、manifest一致。Host検証は展開payloadのdevelopment-path起動まで。通常のinstalled extension discoveryとnative GUIは未受入。 |
| Marketplace / Open VSX / GitHub Releasesの1.0.0衝突読取 | 公開API（read-only） | 2026-10-19 08:13 JST | **PASS** | Marketplace query HTTP 200・該当extension 0件、Open VSX HTTP 404・Extension not found、GitHub Releases API HTTP 200・release 0件。読取のみ、公開操作なし。response hashesはreceipt参照。 |
| Git・ユーザー環境・公開禁止 | 該当なし | 読取専用Git確認 / temporary profile | **PASS** | HEAD/branch/index保持。fixtureはFake Git、hygieneはread-only `git ls-files`のみ。通常Code/Cursor/Keychainは未変更。公開操作なし。過去のfixture違反は履歴から削除していない。 |

## Terminal修正と証拠範囲

App Serverの`item/commandExecution/outputDelta`はprocess IDの対応通知より先に到着し得ます。旧実装は差分をitem ID単位で蓄積しましたが、Extension Host再起動後や差分が届かなかった場合に、稼働中Terminalの完全出力を再取得する経路がありませんでした。`thread/backgroundTerminals/list`にも出力本文がないため、表示できない初期bytesはメモリ上に残らず、部分出力だけが表示され得ました。

現在のsourceは同じCodex App Server threadの`thread/items/list`からitem ID→turn ID→`aggregatedOutput`を復元し、検索を最大20ページ×100 items、全照合時間を最大10秒に制限します。完全snapshotがない間はTerminalをrunningのままにして出力完全性の警告を表示し、snapshot回復後に警告を解除します。再接続でTurnやcommandを再実行しません。実Backendが初期出力を送らなかった理由と、稼働中に完全snapshotを返すかは、隔離認証がないため未確定です。

`test/providers/codex/codex-app-server-terminal-output.test.ts`の4件は早着delta、snapshotのみの出力、照合失敗警告、部分snapshotからの回復、Reload後のページ検索、Turn再実行0回を検証します。`test/providers/shared/stdio-rpc.test.ts`ではUTF-8コードポイント途中にJSON-RPC bytesを分割し、`test/webview/terminal-and-subagent-rendering.test.ts`では完全性警告のDOM表示を確認します。いずれも実Backend live PASSではありません。

### Candidate 2残数と再開条件（当時の記録）

今回の表では現候補の確認済みFAILは0件です。過去の実live FAILは旧SHAに結び付けて保存しています。必須未完了12グループの内訳は**PARTIAL 3 / NOT RUN 3 / BLOCKED 6**です。すべて解消するまでNO-GOです。

1. 通常profileのcredentialをコピーせず、本人が隔離Cursor/Codex profileへ正規認証する。認証後に`npm run test:runtime:terminal`とCursor SDK既定経路を再開する。
2. 候補VSIXの隔離profile `/private/tmp/ai-agents-vsix-final-20261019` を開けるComputer Use経路を復旧する。通常Code/Cursor profileは使わない。ready後にTerminal、Plan、Subagent、6 layout、IME、Clipboard、画像/Queue/Retryを同じSHAで受入する。
3. 実物の0.10.0 VSIXと対応バックアップを用意し、候補SHAへの更新・失敗復旧・旧版戻しを行う。
4. 新しいlive/native GUI証拠が揃った後、SHAを固定した受入表を更新して再判定する。

---

# v1.0.0 最終bytes受入表 — 2026-10-19 JST

対象はmacOS arm64のみ。基準HEAD `188c892f39695be054b267d2b699453057ebfa64`、未コミット。判定 **NO-GO**。
最終VSIX SHA-256 `4202d076c1c4b9851c5fa3d7c4b6067a6bf17eb504f6153be31b9645c6b72c90`。下の過去記録と対象bytesを混同しない。

| 要求 | Backend/方法 | 判定 | 根拠 / 残件 / 再開条件 |
|---|---|---|---|
| 通常Turn実行中Reload継続 | 最終VSIX＋実App Server＋native GUI | PASS | 同一PID/Session/Turn、Final1、成果物hash一致。final receipt |
| Plan生成実行中Reload継続 | 同上 | PASS | 同一Turn完了、ready、成果物なし。改訂Turnの独立Reloadはこの試験外 |
| Build実行中Reload継続 | 同上 | PASS | GUI Build1回、同じPlan ID/版、implemented、再Build無効 |
| 新規/2Turn/履歴/Stop/各失敗 | Cursor既定SDK / Codex App Server | NOT RUN（一部） | Codex Plan→Build2Turn、履歴、ACP runtime Stop等は確認。既定Cursor SDKは認証経路でブロック。最終VSIXの全失敗受入は残る |
| Composer 2.5実ID | Cursor CLI catalog | PASS（CLI限定） | `composer-2.5`。SDK catalogはNOT RUN/未ログイン。APIキー発行へ変更しない |
| Plan/View Plan/モデル/明示Build/改訂・部分失敗 | 最終VSIX＋実App Server | NOT RUN（一部） | GUI View Plan・GPT-6-Luna/Effort確認・Build1回はPASS。改訂/部分失敗の最終VSIX再受入は残る |
| Subagent A/B・親Waiting・詳細/draft | 対応live Backend | NOT RUN（GUI） | 前回source runtime A/B並列はPASS。最終VSIX詳細GUIを受入する |
| Terminal stdout/exit/Terminate/Stop/Reload | 対応live Backend | FAIL / NOT RUN | 初期stdout欠落FAIL、追加出力/Terminate/runtime再接続は旧source証拠。最終VSIXの自然終了・親Stop・GUI Reloadは残る |
| 300/390 CSS px × Dark/Light/HCの6セル | 最終VSIX Webview | NOT RUN | 各セルの全指定コンテンツ確認が必要。今回の短い暗色Plan表示を全セルPASSへ広げない |
| macOS実日本語IME・改行・メニュー/draft | 最終VSIX native GUI | PASS（観測ケース） | native keysで変換・確定Enter非送信、Shift+Enter、メニュー、履歴、新規会話の既存draft仕様を確認 |
| 本文/コードCopy・画像/Queue/Retry | 最終VSIX GUI/Backend | NOT RUN（一部） | 本文Copy/実ClipboardはPASS。Queue/draftは3ReloadでPASS。コード/画像Clipboard、変更した管理経路の画像Retryは再試験が必要 |
| UsageとContext占有/内訳の分離 | 実schema＋実App Server | NOT RUN（一部） | accountingは実測、占有量等の型なしを確認。未知値の捏造なし。Context GUI受入と能力表の全Backend照合は残る |
| 構造化To-do進捗 | 実App Server通知 | NOT RUN（live GUI） | schemaは提供、過去の要求は通知0件。非対応と断定せず再試験する |
| check/全suite/coverage/hygiene/build | macOS、既存npm scripts | PASS | Node26:831/831、coverage99.26/98.18/98.06。Node22:831/831。hygiene443。Git応答fixtureはMock |
| Host Integration | macOS公式VS Code1.142.0 / Node22 launcher | PASS | メモリ内SecretStorageで全assertion PASS、Host Node24.21.0。途中のQuickPick timeoutは履歴に残す |
| 1.0.0正式形式VSIX/内容監査 | darwin-arm64 | PASS | 非prerelease、144,142,863 bytes、1518 entries、全entry内容走査。vendor一致5分類、未処置0 |
| クリーンinstall / 実0.10.0更新・復旧 | 隔離VS Code＋実VSIX | PASS（観測状態） | ID/version/path、installed1516内容一致。Plan/draft/Usage保持、旧backup復元再試行、旧VSIX＋旧backup downgrade。全旧schema互換性は別 |
| 公開済み版衝突確認 | 公開API読取 | PASS（前回の同日読取範囲） | Marketplace0件、OpenVSX404、GitHub releases空。公開直前の再確認が必要 |
| Git境界・source入力manifest | 読取Git / SHA-256 | 最終receipt参照 | 今回HEAD/branch/stage保持。過去に記録したfixture Git操作違反は消去していない |

必須FAIL/NOT RUNは残っている。既定SDK認証を無言でACP/APIキーへ置換せず、制限記録だけで要件を削除しない。

---

## 以下は再開前の履歴（最新判定は上表）

# v1.0.0 固定受入表

対象: macOS arm64のみ。version 1.0.0、正式版パッケージ。作業ツリーは未コミット。
基準HEAD: `188c892f39695be054b267d2b699453057ebfa64`。判定は **NO-GO**。
過去の0.10.0 GUI結果と現在のソース・VSIXの結果は同一視しない。

| 必須要求 | Backend経路 | 現状 / 結果 | 根拠と不足 | 修正箇所 / 検証方法 |
|---|---|---|---|---|
| 通常Turn実行中Reloadから同一実行完了 | Codex App Server | NOT RUN (実GUI/VSIX) | 新規Mock subprocess deathテストPASS。live GUI未受入 | managed-session / managed-worker、controller。受理後Reload・同一PID/Turn・完了1回 |
| Plan生成/改訂実行中Reload | Codex App Server | NOT RUN (実GUI/VSIX) | Mock process death PASS。Plan版/ID・GUI未受入 | 同上。成果物なし・旧有効版保持・明示Buildのみ |
| Build実行中Reload | Codex App Server | NOT RUN | 実装経路共通。独立したlive受入が必要 | 同上。元Buildの完了・成果物hash・dispatch1回 |
| 主経路送信/2ターン/履歴/Stop/各種失敗 | Cursor SDK / Codex App Server | NOT RUN (最終VSIX) | 旧版証拠はRunbook。管理経路は再検証が必要 | provider / sidebar。隔離認証・合成workspace |
| Composer 2.5現カタログ実ID | Cursor SDK | NOT RUN | 旧IDを現カタログ証明に流用しない | models。隔離Cursor認証でlist |
| Plan→View Plan→モデル→Build、改訂/部分失敗 | Codex App Server / Cursor | NOT RUN (最終VSIX) | 0.10.0実GUI PASSは履歴証拠 | plan-state / controller / webview、独立実GUI |
| Subagent A/B・親Waiting・詳細/draft | 対応live Backend | NOT RUN | Mockと実並列を区別 | providers / subagents。実通知だけを表示 |
| Background Terminal stdout/exit/Terminate/Stop/Reload | 対応live Backend | NOT RUN | 管理プロセスで所有保持、実再接続未受入 | terminal monitor / provider。command再実行禁止 |
| 300/390 CSS px × Dark/Light/HCの6セル | Webview | NOT RUN | 各セルの長会話/Plan/menu/tool/子/Terminal/errorを確認 | styles / GUI。部分PASSをセルPASSにしない |
| 実macOS日本語IME、Enter/Shift+Enter、draft | Webview / OS | NOT RUN | DOMイベントと実IMEを区別 | composer / 直接GUI |
| 本文/コードClipboard、画像/Queue/draft/Retry | Host + live Backend | NOT RUN (最終VSIX) | 旧実GUI Retryは復元→明示Send仕様でPASS。自動送信しない | sidebar / composer / provider。変更経路の再試験 |
| UsageとContext内訳/上限/占有率の分離 | Backend schema/events | NOT RUN (live現行) | tokenUsageとTo-do通知の既存parserあり。提供可否の実スキーマ確認が必要 | usage / details / capabilities。未知値を0にしない |
| 構造化To-do進捗 | Backend schema/events | NOT RUN (live現行) | App Server turn/plan/updated parserあり。チェックボックスを完了証拠にしない | 実通知・実スキーマ照合 |
| 静的/回帰/全suite/coverage/hygiene/build/Host | macOS | FAIL (全suite) / PASS (Host等) | Node 22.23.1/26.7.0、830件中817成功・13件Git guard拒否。詳細はVerification | 既存npm scripts、ローカルCI相当のみ |
| v1.0.0メタデータ・非prerelease VSIX・内容監査 | darwin-arm64 | PASS (生成/内容監査) | 1,518 entries、144,142,421 bytes。正式1.0.0 / darwin-arm64、SHAはreceipt参照 | package.mjs、展開内容・バイナリ・入れ子archive監査 |
| クリーンインストール/0.10.0実VSIX更新/復旧 | 隔離VS Code | NOT RUN | 旧VSIX有無を確認。fixtureを実更新PASSにしない | 同一最終bytesをインストールしロードパスを確認 |
| 公開済み版の衝突確認 | Marketplace/Open VSX/GitHub読取 | PASS (現在の読取範囲) | Marketplace query 0件、Open VSX 404、GitHub releases空。公開直前に再確認 | 読み取りのみ |
| Git HEAD/branch/stage保持・入力manifest | Git読取/内容hash | PASS (製品repo保持) / FAIL (手順遵守) | main / 空stage保持。初回suiteが一時fixtureで禁止Git操作を実行した事実を記録 | 外部receiptに相対パス+SHA-256 |

FAIL/NOT RUNの必須セルがあればGOにしない。Backend制約の説明で要求を削除しない。

## 管理プロセスの設計と現在の適用範囲

macOSのCodex App Serverに適用する。Cursor SDK/ACP、Codex SDKは従来経路であり、
これらのReload継続を管理経路の成功から推定しない。
profileのglobalStorage、canonical workspace、local conversationから所有者の識別子を作る。
UID所有・0700ディレクトリ、0600ランダムtoken・Unix socketを使い、単一接続所有者だけを認証する。
オプション/認証/prompt/event本文は管理用ファイルへ永続化しない。元のstdio接続・Session・Turnは管理側が保持する。
UIのdetachは中断ではない。Stopは元runのAbortSignalを中断する。session disposeは明示終了。
接続不在が10分続けば管理側が中断・dispose・ディレクトリ削除する。再接続で猶予を更新する。
16 MBを超える保持出力は黙って欠落させず実行失敗へ移す。
終了プロセスが残したlockはPIDの不存在を確認した場合だけ回収し、その試行では再送せずエラーにする。
管理側そのものが失われた場合の元実行継続は保証せずUnknownとBuild無効を維持する。
branch activation・reviewをproxyし、初回起動失敗の後も同じownerを再初期化できる。
出力超過・transport切断・孤児回収には追加受入が必要。

## 2026-10-19 最終候補の実測

- Source runtimeの通常/Plan/Buildで、`gpt-6-luna`実Backend受理・shell開始後、接続側detach→元Session/Turnへ再接続→完了を確認した。Buildは先にPlanを完成させた同じSessionを使用。通常/Build成果物の正確なbytesを確認した。これは実GUI/インストール済みVSIXのReload受入ではない。
- 7件の管理経路回帰はPASS。別プロセスの強制終了、Plan/通常実行、Controllerの通常/Plan/Build復元、Usage二重計上防止、異なるSessionの拒否、未存在runの非dispatch、初回起動失敗からの再初期化を含む。
- インストール済みVSIXの`y3162.ai-agents` / `1.0.0` / 実パス / activeをHostで確認し、1,516個のインストール内容をVSIXと照合して不一致なし。ただしWebview readyはfalseで、専用GUI操作はtimeout。インストール済み実Backend/Reload/Plan/Build/画像の受入は未完了。
- Cursor SDKのカタログ取得は隔離認証が`未ログイン`で停止。CLI statusもNot logged in。SDK認証後に現カタログと既定Cursor経路を再開する。APIキーへの代替はしていない。
- 同梱CLI生成スキーマにTo-doの`turn/plan/updated`とtokenUsageのtotal/last/modelContextWindowがある。liveのTo-do要求ではTo-doイベントを観測できず、一般的な非対応とは判定しない。Context内訳/占有量を示すフィールドはこのtokenUsage型にはなく、last requestの合計を占有量へ転用しないよう修正した。上限258,400とtoken会計は実測したが、Context内訳・構造化To-doのGUI受入は未完了。
- 0.10.0の実VSIXを保持している（旧SHA `caa6ac956ca44e19222e86b8c165e26617c62d89b156d237a0936e7b225ddc4f`）。実更新・バックアップ復旧の受入はNOT RUN。

## 再開条件

1. 隔離アプリのUI接続を復旧し、インストール済み候補のWebview readyを確認する。普通のprofile/研究workspaceへ切り替えない。
2. 同じ候補bytesで通常/Plan/Buildの実行中GUI Reload、直接GUI Build、画像、6レイアウト、実IME/Clipboard、live子/Terminalを受入する。
3. 隔離Cursor SDKの認証を完了してComposer 2.5のカタログIDと既定経路を確認する。
4. 禁止Git操作を伴わないfixture方式で13件の試験前提を解決し、全suite/coverageを完了する。13件を黙ってskipしてGOにしない。
5. 0.10.0実VSIX→1.0.0更新と復旧を確認する。必須セルがすべてPASSとなるまでNO-GO。

追加実測: live SubagentのA/B・親Waiting・Aのみ完了・B後の復帰と親Final1件はruntime PASS（両子モデル実通知gpt-6-luna）。詳細GUIはNOT RUN。Terminalの同一processへの接続復帰・起動1回・追加stdout・Terminateはruntime PASS、初期stdoutは観測した実通知/listで欠落してFAIL。自然終了/親Stop/GUI ReloadはNOT RUN。これらも必須未達としてNO-GOへ含める。
