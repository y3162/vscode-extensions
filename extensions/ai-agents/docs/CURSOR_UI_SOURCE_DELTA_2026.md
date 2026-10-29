# Source analysis に基づく差分

## 実装

`transcript.ts` の状態をターン全体ではなく各ツールの running 状態と最後の未完了 thinking に対応させた。以前は実行中ターンの完了したグループも Running / Thinking となり、最終状態への切替だけでは同じ log の再描画が起きなかった。終了時の再描画も追加した。メッセージに開始・終了の情報が無い場合は、最後の thinking であることを代理条件とする。該当回帰テストは `test/webview/cursor-ui-spec.test.ts`。

作業開始時に存在した Review、Composer、資料等の未コミット差分は引き継いだ。今回それらを一から置換していない。Cursor の loading thinking の初期展開・完了時の独立した開閉状態は、セッション切替と再描画時の状態保持を含む検証が必要なため未変更。Cursor の完全な mixed-tool grouping、Build 条件、Review 内部履歴、matched CSS cascade は未確定。

## 採用しない / 制約

- Glass の半透明背景、Dark固有の Build 色、別 Plan エディタは VS Code テーマとサイドバー操作を優先して採用しない。
- Cursor の非公開APIや bundle 実装は組み込まない。Keep は Git stage / commit でない。
- Undo は内容変更・境界・未保存等で安全性を確認できないときは実行できない。外部の同時書き換えとの競合を完全に排除する仕組みはない。
- Cursor のライブ画面に現在接続できない。未取得の matched rules と展開状態をライブ確認済みとみなさない。

## 検証結果と残作業

- `npm run check`、`npm test`（840件）、`npm run test:coverage`、`npm run test:hygiene` は成功。
- Chrome の production Webview bundle fixture で chat / running / changes / plan / terminal、300 / 390 / 600 / 1000px、Dark / Light / High Contrast の60画面を生成し、22操作チェックが成功。出力は `/tmp/ai-agents-source-after/`（Git 管理外）。Dark の390pxと1000pxでは Composer行28px、padding 8/10/6px、radius 12px、Activity 14px/22px、ユーザー13px/18.2pxを計測。これは fixture であり Cursor や VS Code Host の実測ではない。
- 隔離された VS Code 1.144.0 Development Host は起動し、テスト用 workspace の信頼状態を確認した。macOS の画面取得エラー（`SCStreamErrorDomain -3812` / `noWindowsAvailable`）により AI Agents の本番 Webview の状態別操作まで確認できなかった。隔離プロセスは停止を要求した。変更前後の同条件の実Host比較も未取得。
- 完了判定は **未達 / No GO**。Cursor matched CSS と展開状態、実Hostの全幅・テーマ・Review・キーボード・セッションを検証する必要がある。
- `npm run test:integration` は隔離 VS Code 1.144.0 の Extension Host で成功。ただし、これは前述の画面別手動受入の代替ではない。

## 2026-10-29 Development Host CDP 追試

- 判定 **AI Agents GUI Acceptance: NO-GO**。Home、Mock CLI の1ターン、ActivityとTerminal詳細を実Hostで確認できたが、全状態・幅・テーマ・Review安全性のGUI受入は未完了。Cursor UI Fidelityも部分確認のまま（matched CSS、展開Thinking / Terminal、Plan / Reviewの内部条件は未測定）。過去のChrome fixtureの成功を実Hostの受入と扱わない。
- HEAD `4742842e193544426dda53d1959c3e2692c933f1`、`main`、既存の多数の未コミット差分を保持。`npm run build` は成功し `dist/webview/main.js` / `main.css` を生成。隔離済みVS Code 1.144.0、開発拡張 `y3162.ai-agents` 1.0.0、専用workspace/profile/extensions/shared-data、Mock CLIで実施。通常のVS Code / Cursorには接続していない。
- 独立した段階: 起動 **成功**、拡張 **成功**（最初はRestricted Modeで無効、使い捨てworkspaceを信頼後に有効化）、サイドバー **成功**、本番Webview **成功**、DOM **成功**、CDP画面取得 **成功**、Home・送信・Activity/Terminal展開 **成功**。過去のScreenCaptureKit `-3812 / noWindowsAvailable` の根本原因は特定できていない。今回CDP成功は画面取得経路と描画を区別できることを示す。
- `Target.getTargets` でWorkbenchとは別の `iframe`（URLに `extensionId=y3162.ai-agents`）を発見。その子 `active-frame` に isolated world を作成し `Runtime.evaluate`、`Page.getFrameTree`、`DOM.getDocument`、`DOMSnapshot.captureSnapshot`、Workbenchの `Page.captureScreenshot` を実行。script / stylesheet URIはこのcheckoutの `dist/webview/main.js`、`main.css`、`codicon.css`。ターゲットをWorkbenchだけとみなすと本番DOMに到達しない。
- `AI_AGENTS_GUI_CDP=1 npm run gui:start` は隔離プロファイルのDevToolsActivePortにランダムポートを出す。`node scripts/gui-cdp-capture.mjs <session-root> <output-directory>` はその隔離セッションを確認し、DOM・computed style・bounds・ターゲット・フレーム・snapshot・Workbench画像を保存する。デバッグポートは一時的なローカル操作用で、セッションの停止後に閉じる。
- 証拠はGit管理外 `/private/tmp/ai-agents-gui-evidence/` の `home`、`chat-activity`、`terminal-expanded`、`reload`。スクリーンショットは実VS CodeのWorkbench全体。画面内に拡張無効の通知が残るが、対象の開発拡張は有効で、CLI送信・応答が確認できた。既存 `/tmp/ai-agents-source-after/` はChrome fixtureであり同条件Beforeではない。
- Dark、現行サイドバー約300px: Activityの表示矩形233×22px、14px / 22px、Composerの角丸12px、操作行28pxをcomputed styleと矩形で確認。390 / 600 / 1000px、Light / HCの実Host計測は未実施。Composerがフォーカス中の枠色は青であり通常状態の20%枠の検証には使えない。
- Mockは `Hello fixture` にコマンド実行中・完了と応答を送信。実Hostで完了後 `Ran read fixture`、詳細 `read fixture` / `fixture content` を確認。Homeから同一セッションの再選択は成功。Workbench reload後のセッション選択はMockの `thread/resume` が意図的に `fixture history unavailable` を返し、エラー表示を確認したのみで、正常復元の証拠にはならない。
- Thinking自動展開・ユーザーによる閉鎖保持・完了折畳みは未修正・未受入。現在 `openThoughts` は初期空であり、実行中の自動展開規則を実装していない。Review / Undoは実GUI未検証。既存実装は未保存、digest、実パス、通常ファイルを事前確認し、renameは一括Undoを拒否、部分失敗を報告するが、外部プロセスの並行書換えとの完全な原子性は保証しない。Plan / Build / Approval / Subagent、複数ターン、各ツール状態、実Hostの再ロード成功例は未検証。
- テスト結果: `npm run check` 成功、`npm test` 840/840、`npm run test:coverage` 成功（65実行可能モジュール）、`npm run test:hygiene` 成功、`npm run build` 成功、`npm run test:ui` 396 fixture画像・22 browser操作成功、`npm run test:integration` 成功。Integrationは初回のダウンロードを中断し、既存の `/private/tmp` 内の使い捨てVS Code 1.144.0 を `VSCODE_EXECUTABLE_PATH` に指定して再実行。ready handshake、Mock CLI往復、停止、切替、モデル、差分などのExtension Host assertion成功であり、全画面の視覚受入を保証しない。test:uiはChrome fixtureであり実Hostではない。

## 2026-10-29 最終受入の追加作業（未完了）

- **AI Agents GUI Acceptance: NO-GO**。Cursor UI Fidelity は別判定で部分確認のまま。開始時 HEAD は `4742842e193544426dda53d1959c3e2692c933f1`、既存の未コミット変更を保持した。
- Thinking は会話・ターン・セグメントを組み合わせて手動開閉を記録し、未操作時は実行中に開き完了時に閉じる。セッション切替ではターンDOMと Activity 状態を破棄し、別会話の同じIDに流用しない。同一セッションの再描画では明示操作を保持する。リロードでは Thinking の手動状態を保存せず既定に戻る。親Activityを手動で閉じると子Thinkingも閉じる。これは実装上の規則であり、Cursorの追加実測ではない。
- 隔離 VS Code 1.144.0、専用 profile / workspace、Mock CLI で本番 `dist/webview/main.js` を読み込んだ。CDPでHomeと新規Chatを操作し、表示中のComposer操作行28px、角丸12pxをアサートした。証拠はGit管理外の `/private/tmp/ai-agents-gui-evidence-final/home/` と `chat/`。撮影時のサイドバー幅は約300pxであり、他の幅やテーマは測定していない。
- `GUI_THINKING_GATE` は合成reasoningイベントを送り、workspace内の `gui-release-thinking` を作るまで待機する。実HostではCodex CLIの `codexUpdate` がreasoningを投影しないため Thinking要素が表示されず、`thinking/capture.json` のアサーションは **失敗**。当該CLI経路にThinking capabilityを偽装していない。このフィクスチャの再実行には同名releaseファイルを隔離workspaceから取り除く必要がある。実行中の開閉・ストリーミング保持・完了時折畳みの実Host受入は未達。
- S01のみHome / Chatの基本表示を確認。S02–S20の受入、正常 `thread/resume` Mock、Review / Undoの実ファイル操作、Plan / Approval / Subagent、Reload正常復元、幅・テーマの全マトリクスは未完了。安全性については既存テストの成功だけでは実GUI受入を意味しない。外部プロセスとの完全な原子性も保証されていない。Beforeは同条件で取得していない。
- 回帰確認: `npm run check`、`npm test` 841/841、`npm run test:coverage`、`npm run test:hygiene`、`npm run build`、`npm run test:ui`（Chrome fixture 396画面・22操作）、`npm run test:integration` は成功。テスト成功は未実行GUIシナリオのPASSを意味しない。CDPの新規Chatアサーションは成功、Thinkingアサーションは失敗。

## 2026-10-29 CLI reasoning 経路の追試

- 開始時は `main` / `4742842e193544426dda53d1959c3e2692c933f1`。作業前から存在する未コミット差分は保持した。
- Codex の公開 `exec` イベント定義は `reasoning` を reasoning summary として定義する（[公式実装](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)、[イベント定義](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)）。`item.started/updated/completed` → `threadItem` は文字列 `text` を受理するが、従来 `codexUpdate` が破棄していた。修正後は空白以外の `text` だけ `assistant` / `meta.type=thinking` に変換する。使用量だけや未知形式から本文を生成しない。Controller はターンと項目IDで既存メッセージを置換し、ViewModelを経て `turns.ts` がthinking segmentへ、`transcript.ts` が `details.thinking` へ描画する。イベント完了単独でThinkingを終了する表現はこの変更には追加していない。
- 公式形式の合成CLIイベントについて、空、更新スナップショット、同じIDの完了、未知形式、使用量、最終回答を単体テストした。実際の認証済みCLIによる本文の有無は今回未観測であり、モデルや実行に常に本文があるとは主張しない。reasoningを含む正常復元の新規テストも未実施。
- 隔離Development Host 1.144.0 / 本番Webview / Mock CLIで、実行中Thinkingの本文、`details.open=true`、表示領域233×52.48px、font 13px / line-height 19.5pxを確認。手動閉鎖で `open=false`、`aria-expanded=false`、再展開で双方trueを確認。最初の取得は非同期起動前で失敗し、再試行で成功した。証拠は `/private/tmp/ai-agents-gui-evidence-reasoning/`（`thinking/capture.json` は失敗、`thinking-retry/capture.json` と `workbench.png` は成功）。この経路はMock Backend経由であり、独立したHost ViewModel Fixtureは未構築。ゲート解除後もRunning表示が残り、完了・再描画・復元は未確認。手動操作はCDP評価で確認したが、その2操作の独立した保存済みDOM証拠はない。
- Review / Keep / Undoの使い捨て実ファイルによるGUI操作、Plan / Build / Approval / Subagent、正常履歴復元Mock、Reload正常系、4幅×3テーマの実Host検証は未実施。実Hostで指定幅を測る仕組みと状態別独立シナリオも未完成。Chrome fixtureと混同しない。
- 今回のチェック: `npm run check`、`npm test` 842/842、`npm run test:coverage` 842/842（65実行可能モジュール）、`npm run test:hygiene`、`npm run build` 成功。`npm run test:ui` はChrome fixture 396画面・22操作成功。`npm run test:integration` は隔離VS Code 1.144.0で成功。これらは未実行のGUI受入を意味しない。
- 判定: **A Webview GUI Acceptance NO-GO**（大部分未実行）、**B Backend Capability Integration 未完了**（Mock経路は部分成功、実CLI未観測・復元未検証）、**C Cursor UI Fidelity 部分確認**（追加実測なし）。隔離Hostには停止を要求した。

## 2026-10-29 Thinking の項目完了と隔離 Host fixture

- 前回 Running が残った**個別の根本原因は未確定**。旧 Mock は解除検出や終了を記録しておらず、当時のプロセスも残っていないため、解除ファイルの誤配置やプロセス停止を事後に断定できない。旧セッションの workspace に解除ファイルは存在するが、それが当時の待機プロセスに見えた証拠ではない。別に、コード上の確定した欠陥として、旧 Mock は reasoning の `item.completed` を送らず、実装も項目完了を表現できなかった。このため後続イベントを待たずに Thinking を完了することはできなかった。前回の残存現象と同一原因と断定しない。
- `item.started/updated` は同じ項目 ID の表示可能な本文を投影し、`item.completed` は `thinkingCompleted` を付ける。空の完了本文は Controller が既存本文を保持する。重複完了や遅延更新で完了を取り消さない。個別項目を連結せず、完了した Thinking はターンが busy または後続 Tool が running でも完了表示。`turn.completed` は使用量を処理し、プロセス終了とストリーム読取後に Controller がターンを完了する。追加フィールドは任意で旧履歴と互換、隔離保存履歴でも保持を確認。Thinking のみを最終回答に指定しない。
- Mock CLI 実 Host の再試験: 新規 workspace の release/update ファイルを送信前に削除。`/private/tmp/ai-agents-gui-acceptance-0KRnKk/workspace/gui-thinking-trace.jsonl` の2回目では JST 08:59:07.131 gate-start、07.137 `item.started` / `item.updated`、12.645 追加更新、13.476 release 検出 / `item.completed` / `turn.completed`、13.477 process exit 0。ID は `fixture_thinking`、cwd は同 session の workspace。stdout の本文更新と回答が実 Webview に到達し、終了イベントが処理されたことを確認。隔離履歴の turn `fd224ca3-ae98-48a1-88d6-837c70ed3027` は completed、endedAt 08:59:13.616、busy=false、Thinking 本文と完了フラグを保持。これは `finishTurn()` と最終 publish の結果に対応するが、当該メソッド内部の独立したタイムスタンプ記録ではない。CDP の `run2`、`close2`、`update2`、`done2` には各 DOM / snapshot / Workbench screenshot があり、自動展開、手動閉鎖、更新後の閉鎖保持、回答と Ready、Running 消失を確認。証拠は `/private/tmp/ai-agents-thinking-20261029/`。固定 sleep による成功判定を使わず条件と期限で待機。
- CLI とは独立した fixture は `test/fixtures/host-viewmodel.cjs`。`AI_AGENTS_GUI_VIEWMODEL_FIXTURE=1 AI_AGENTS_GUI_CDP=1 node scripts/gui-session.mjs start` で隔離 Extension Development Host の extensionTestsPath としてのみロードし、通常ビルドに組み込まず `.vscodeignore` で VSIX から除外する。固定シナリオのみ選択でき、CLI を呼ばず、Controller snapshot をテスト Host 内で差し替え、通常の `buildShell` / `toViewMessage` / diff / `postMessage` と本番 `dist/webview/main.js` / `main.css` を使う。要求/応答は session root 内のファイル、ready と期限で同期する。将来の状態追加は fixture の許可リストに追加する。`gui-cdp-capture.mjs <root> <output> --scenario=T01` のように選択し `--session-b` を指定できる。
- Fixture 実 Host 結果: T01 自動展開、T02 手動閉鎖後の更新保持、T03 完了時の未操作自動折畳みと手動開放保持、T04 完了 Thinking と実行中 Tool の共存、T05 busy=false 相当・回答・Running 消失、T06 A→B→A の開閉状態分離を CDP で確認。`fixture-t01-verified`、`fixture-t02`、`fixture-t03-untouched`、`fixture-manual-complete`、`fixture-t04`、`fixture-t05`、`fixture-t06-*` の `capture.json` と `workbench.png` を保存。対象は Workbench と別の extension iframe の active-frame、`details.thinking` の open / aria-expanded / text。T06 は初回 fixture では会話 ID の投影を切り替えた。改良版では実 `SessionRegistry` に別 Controller を登録して `focus()` で A→B→A を切り替え、同じ開閉分離を `registry-t06-*` に再記録した。ただし履歴画面からの選択や CLI 履歴復元の受入ではない。Fixture の busy は注入された snapshot であり実 Controller の実行完了の証拠ではない。
- **Thinking Lifecycle Acceptance: NO-GO**。Mock 実 Host の開始→更新→解除→ターン完了、fixture の T01〜T05 と会話 ID 分離は確認したが、前回 Running 残存の原因確定、履歴画面からのセッション選択は未完了。Mock 経路の項目完了と後続 Tool の独立観測は下記の追加追試で確認した。Reload 初期状態の実 Host 受入も未実施。**AI Agents GUI Acceptance: NO-GO**（Review / Plan / Approval / Subagent / Reload / 幅 / テーマ未実施）。**Backend Capability Integration: Mock のみ確認**、実認証済み CLI の reasoning 本文は未観測。
- 追加 Mock 実 Host 追試 (`mock3-*`): JST 09:04:58.492 項目開始・更新、58.899 追加更新、59.205 `fixture_thinking` 完了（空本文）、59.461 `fixture_tool` 開始、59.716 ターン完了出力、59.717 プロセス正常終了。項目完了直後はターンが Running のまま Thinking が Thought、Tool 実行中も Thought を維持し、release 後は Ready。各段階を別々の DOM / screenshot に保存した。トレースの旧 `tool.started` 行の id は固定値 `fixture_thinking` と誤記されているが、送出イベントと DOM の Tool は `fixture_tool`。トレースを項目別 ID に修正した。
- 結果の補足: 実 `SessionRegistry.focus()` を通る fixture の T01〜T06 は成功。履歴画面からの選択・バックエンド復元、および前回 Running 残存の原因は引き続き未確認なので、上記の保守的な NO-GO 判定を維持する。
- Mock3 の CDP capture ファイル時刻（JST、取得後のファイル書込時刻）は開始 09:04:58.624、手動閉鎖 58.790、更新 59.050、項目完了 59.317、Tool 開始 59.603、ターン完了 59.882。ViewModel の各差分や `finishTurn()` 自体の独立ログではなく、DOM の観測時刻。以後の capture には `capturedAt` を含める。
- 回帰結果: `npm run check`、`npm test`（845/845）、`npm run test:coverage`（成功、65 executable modules）、`npm run test:hygiene`、`npm run build`、`npm run test:ui`（Chrome fixture 396画像、22操作）、`npm run test:integration`（隔離 VS Code 1.144.0）成功。最後に Mock ゲート試験を Tool の独立段階まで拡張し、対象単体テストも成功。UI fixture の結果と実 Host CDP の結果は別扱い。旧統合テストの自動ダウンロード試行は中断し、使い捨て VS Code executable を指定して成功した。
