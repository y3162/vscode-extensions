# GUI Acceptance T17/T20 Recovery — 2026-10-30

## 開始状態

`main`、HEAD `e5ed31473c14bddf39731cd9194b27f24c625daf`。開始時にAI Agentsの18ファイルが変更済み、`AI_AGENTS_FINAL_STABILITY_2026.md` と `AI_AGENTS_RELEASE_READINESS_2026.md` は未追跡であり、いずれも保持した。macOS arm64、隔離VS Code 1.144.0、Mock CLI、撮影なし。開始時空き約5.8 GiB。Commit、Push、Release、通常環境へのインストールは行っていない。

## T17 / T20 の原因と修正

元の一括実行では両方とも復元Groupの展開待ちでFAIL、T17単独再試行はPASS、T20単独はDetail待ちでFAIL。失敗時はsession `fixture-thread-1`、turn `fixture-thread-1-turn-2:user`、GroupとToolのID `fixture-thread-1-turn-2:item_0` が存在し、GroupとDetailは閉じていた。各失敗は `/private/tmp/ai-release-all-final/results.json`、`/private/tmp/ai-release-t17-retry/results.json`、`/private/tmp/ai-release-t20-retry/results.json`、各シナリオの `failure.json` を参照。元の記録にはクリック直後のイベントや置換の記録がなく、これらの失敗と以下の競合の因果関係は確定できない。

修正前の実HostでGroupのsummaryクリックとDetailクリックを同じイベント処理内で連続させたところ、Groupは開いたが非同期 `toggle` イベント前にDetailクリックによってログDOMが再生成され、Groupは閉じ、Detailは開いた。`/private/tmp/t17-race-before/T17/trace.json` と `results.json`。これは同様の状態遷移を再現したものであり、元の失敗の直接原因を断定するものではない。修正後はsummaryクリック時に状態とariaを同期更新し、後から届く `toggle` はariaの同期のみとした。`/private/tmp/t17-t20-recovery-T17-1/T17/trace.json` では置換後もGroupとDetailがともに開いている。UnitとChrome fixtureで再描画・閉鎖・会話分離を検証した。

一括再試行 `/private/tmp/t17-t20-recovery-all-1/results.json` は18/20。T17は追加診断が一時的に不在だったturnへObserverを登録しようとした例外、T20はDetail出力待ちで失敗。追加診断 `/private/tmp/t20-context-diagnostic/T20/history/trace.json` は `Cannot find context with specified id` による再接続を2回記録し、最終トレースが新しいコンテキストで消えていた。旧コンテキストでの操作と新コンテキストの待機が混ざり得る。runnerは明示的なコンテキスト消失時に限り新しいDOMで実クリックから検証をやり直し、同一コンテキストのタイムアウトは失敗とする。修正後 `/private/tmp/t20-context-fixed/results.json` はPASS。過去の最初の失敗にも同じ切替があったとは証明できない。

## DOM状態管理

`conversationId`、次に `sessionId`、最後にcwdを会話キーにし、会話変更時にturnノードとGroup/Detailの選択を消去する。turnはユーザーメッセージID、Groupは種別とsegment ID、DetailはTool IDで識別する。履歴リプレイでは上記の復元IDを用い、Window Reloadでは新しいWebviewの既定状態を用いる。`render` → `syncTurn` はログ内容やrunning状態の変更時に `fillLog` でDOMを置換する。Groupのsummaryは自分のクリックを処理し、Detailのbuttonはrootの委譲ハンドラが処理する。修正により置換前のGroup選択が同期的に保存され、遅延した旧DOMのtoggleが選択を書き戻さない。Thinkingは独立した会話・turn・segmentキーで手動選択を管理し、既定の自動展開は変更していない。

## 個別実行

| シナリオ | 1回目 | 2回目 | 3回目 |
| --- | --- | --- | --- |
| T17 | PASS | PASS | PASS |
| T20 | PASS | PASS | PASS |

証拠は `/private/tmp/t17-t20-final-T17-1/results.json` から `T17-3/results.json`、および `/private/tmp/t17-t20-final-T20-1/results.json` から `T20-3/results.json`。各ディレクトリの `stop-*.json` は通常Quitを記録する。

## GUI全件受入

| 実行 | T01〜T20 | 判定 | 証拠 |
| --- | --- | --- | --- |
| 1回目 | 20/20 | PASS | `/private/tmp/t17-t20-final-all-1/results.json` |
| 2回目 | 20/20 | PASS | `/private/tmp/t17-t20-final-all-2/results.json` |

両回とも同じ最終製品コードと受入runnerで実行し、それぞれ39件の通常Quit記録が成功、PNGは0件。最終コードのSHA-256: `transcript.ts` `352a2a6b67cdd7cada47c94590c6997dc9f30c127692df963c52a652b8ad8d96`、`gui-restore-acceptance.mjs` `f904a54453b3673c06462ca52b1acc33d5845ca2027d3918f77377487784791f`、本番 `main.js` `f243cc7ff3dafc8a5cb3b757fa24411b7dbb2f1b4e359bd43e4afc5851158545`。

## 最終回帰

| 検証 | 結果・証拠 |
| --- | --- |
| Check | PASS `/private/tmp/t17-final-check.log` |
| Unit | PASS 861/861 `/private/tmp/t17-recovery-unit.log` |
| Coverage | PASS 861/861、Lines 99.27%、Branches 98.57% `/private/tmp/t17-final-coverage.log`。前回比 Lines +0.02、Branches -0.01ポイント。transcriptのLines 100%、Branches 96.7%。 |
| Hygiene | PASS `/private/tmp/t17-final-hygiene.log` |
| Build | PASS `/private/tmp/t17-final-build.log` |
| UI | PASS 396シーン、25操作、撮影0 `/private/tmp/t17-recovery-ui.log` |
| Integration | PASS `/private/tmp/t17-final-integration.log`、隔離VS Code 1.144.0、終了コード0 |
| GUI Acceptance | PASS、独立一括2回とも20/20、上記JSON |

UnitとUIは同じ最終製品コードで実行し、その後の変更は受入runnerの診断・コンテキスト切替処理のみ。修正前の実Host最小競合はFAIL、修正後は独立T17/T20と全件で同じ連続操作を通過した。happy-domの最小テストは修正前もPASSであり、ブラウザーの非同期toggleを再現しなかった。

## 最終判定

**A. Tool Open/Close Regression: BLOCKED。** 再現したGroup選択の非同期イベント競合は修正し、関連テストはPASSした。別途、実Host runnerでコンテキスト消失後に旧操作と新DOM待機が混ざる現象を確認し、切替を記録して実操作をやり直すよう修正した。ただし、元のT17/T20失敗時にはクリック前後のトレースがなく、上記のどちらがその直接原因だったかは確定できない。

**B. GUI Acceptance: GO。** 最終コードの独立T17/T20が各3回PASSし、実Host一括が2回とも20/20 PASS。これは有限回のMock CLI受入の結果であり、元の失敗の原因を証明するものではない。
