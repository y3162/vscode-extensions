# AI Agents 最終安定性検証 — 2026-10-30

開始時 `main`、HEAD `e5ed31473c14bddf39731cd9194b27f24c625daf`、作業ツリーはクリーン。対象リポジトリへのCommit・Push・Releaseは行っていない。スクリーンショット・録画なし。隔離Hostは通常Quitを使用した。

## A. Webview幅

修正前の独立T19で、Workbench iframe 600px、外側Webview documentとactive frame 390pxを観測した。前回は574px対298pxも記録されている。幅伝播はAI Agents documentより外側で止まり、CSS Container Queryの不一致ではない。正確なChromium/VS Code内部の原因は未特定。隔離Hostの起動時にChromiumの背景・タイマー抑制を無効にする設定を追加し、外側iframe、外側document、active documentの幅が一致するまで待機してから補正する。幅Assertionは変更していない。相関は確認したが、特定のフラグが内部遅延の直接原因を除去したと断定しない。

独立T19は `/private/tmp/final-stability-t19-3/` と `/private/tmp/final-stability-t19-repeat/` で2回PASS。300 / 390 / 600 / 1000px × 3テーマ、各階層の実測と操作・Review幅を検証した。T13は `/private/tmp/final-stability-t13-remap/` でPASS。個別の過去FAILは `/private/tmp/final-stability-t19-2/` と `/private/tmp/final-stability-t13-build/` に保持。

## B. GUI Acceptance

隔離VS Code 1.144.0で撮影なしの一括実行が全20件PASS。結果とJSON証拠: `/private/tmp/final-stability-all/results.json`。Hostは通常Quitで終了。

| ID | 結果 | 検証範囲 |
| --- | --- | --- |
| T01 | PASS | Production Webview and mock CLI lifecycle verified |
| T02 | PASS | Production Webview and mock CLI lifecycle verified |
| T03 | PASS | Production Webview and mock CLI lifecycle verified |
| T04 | PASS | Production Webview and mock CLI lifecycle verified |
| T05 | PASS | Production Webview and mock CLI lifecycle verified |
| T06 | PASS | Separate conversation state verified in isolated Host |
| T07 | PASS | History selection and Reload verified through GUI and mock CLI |
| T08 | PASS | History selection and Reload verified through GUI and mock CLI |
| T09 | PASS | Real files, GUI, controller state and applicable safety checks verified |
| T10 | PASS | Real files, GUI, controller state and applicable safety checks verified |
| T11 | PASS | Real files, GUI, controller state and applicable safety checks verified |
| T12 | PASS | Real files, GUI, controller state and applicable safety checks verified |
| T13 | PASS | Plan input, revision, Build, Stop, failure, model and reload verified |
| T14 | PASS | Plan input, revision, Build, Stop, failure, model and reload verified |
| T15 | PASS | Permission decisions, duplicate prevention and session isolation verified through GUI and controller |
| T16 | PASS | Parent, child transitions, detail, isolation and reload verified through controller and GUI |
| T17 | PASS | History selection and Reload verified through GUI and mock CLI |
| T18 | PASS | History selection and Reload verified through GUI and mock CLI |
| T19 | PASS | 12 actual-width/theme measurements and 390/1000 component layouts verified |
| T20 | PASS | Thinking, history/reload, file review, Plan and permission exercised in isolated Hosts |


## C. Plan Reload

CLI履歴再生でユーザーターンIDが変化し、保存Planの旧IDが一致せず後続Buildターンの末尾に表示されることを、2ターンの実Hostテストで再現した。保存履歴と再生履歴で作成ユーザーメッセージが双方に一意なときのみアンカーを再対応付けする。曖昧な場合は推測しない。独立Hostで保存Planをステージし、Build後の2ターンのDOM順序、Reload・Session復元後の順序を確認した。作成ターンIDは `3611e541-c00d-4c29-9d74-d46964370676`、復元後は `fixture-thread-1-turn-1:user` に対応し、次のBuildターン `fixture-thread-1-turn-2:user` より前にPlanを確認した。Plan自体はfixtureでステージされ、BuildはMock CLI経由である。証拠 `/private/tmp/final-stability-t13-remap/T13/restore/`。

## D. Cursorモデル

Cursor CLIで保存パラメータを使うターンは、送信前に現行Catalogを取得し、モデル・パラメータ・値を照合する。取得失敗や定義不足は未検証として実行を止め、保存値を保持する。現行CLIの一覧はパラメータ定義を提供しないため、保存パラメータがある場合は検証不能となる。同じモデルの再選択時に消去の影響を示して確認し、同意された場合のみパラメータを消去できる。Codexはこの検証対象ではない。不正な構文・重複パラメータも拒否する。

`Cannot use this model: ... Available models: ...` は要求IDと先頭理由をチャットへ要約し、機密情報をマスクした詳細を出力ログに残す。標準エラーは先頭64KiBを保持するため、これを超える場合は切り詰められる。未知の形式は従来どおり表示する。実CLIへの追加リクエストは行っていない。

## E. 回帰・判定

型チェック、Unit 860/860、Coverage 860/860、Hygiene、Build、UI fixture 396シーン・22操作・撮影0、IntegrationはPASS。Coverage全体の行率は前回99.28%から99.25%、分岐率は98.63%から98.57%に低下。新しい診断・検証分岐の未到達箇所を含むが、必須の閾値は通過した。最終GUI一括はT01〜T20 PASS。


## F. 最終判定

| 項目 | 判定 | 範囲・制約 |
| --- | --- | --- |
| Webview幅同期 | BLOCKED | 隔離Hostでは3回の幅行列（独立2回・一括1回）をPASS。背景抑制フラグと改善は相関するが、VS Code/Chromium内部の根本原因と通常Hostでの解消は未確定。 |
| GUI Acceptance | PASS | 最終コードの一括T01〜T20が実HostでPASS。Mock CLIと実認証CLIは区別する。 |
| Plan Reload | BLOCKED | Plan作成操作はPlan fixture、Build後Reloadは保存PlanをステージしたMock CLI fixtureで検証。Plan生成からBuild・Reloadまでを単一セッションで連続して確認していない。 |
| Cursorモデル選択 | BLOCKED | 不正値は確認できる定義に照らして拒否し、定義不明も実行を止めて設定を保持。現行CLI一覧にはパラメータ定義がないため、正しい保存パラメータを検証して使用することはできない。ユーザー確認後に消去可能。CLIエラー要約・詳細ログは実装済み。 |
