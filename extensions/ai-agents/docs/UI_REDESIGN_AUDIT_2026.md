# AI Agents UI 監査と参考調査

調査日: 2026-10-28。対象: `extensions/ai-agents`。本書は設計フェーズの観察・仮説であり、操作テストの合否報告ではない。提案と検証計画は [デザイン仕様](UI_REDESIGN_SPEC_2026.md)。

## 方法と証拠の範囲

- 現行実装の `src/webview/`、`protocol.ts`、既存の UI 文書、`test/ui-preview`、テスト・ビルド設定を読んだ。`test/ui-preview` は `dist/webview` の実装をロードし、架空の state を送るブラウザー用 fixture。現在の fixture は `subagents` が欠け、現行バンドルで `undefined.find` により描画が止まるため、**既存ファイルを変更せず** [複製 fixture](ui-redesign-preview/current-fixture.js) に空の `subagents` / `terminals` を補った。修正は fixture のみ。利用方法は仕様書参照。
- ブラウザーで 390×800、Dark の Home / Chat / Approval / Settings の静的状態を観察。画像は架空データであり VS Code Extension Host の実機画像ではない。UI の DOM と CSS の根拠は下表に示す。別 viewport や操作後に同じ問題が出るとは限らない。
- Plan、Build、モデルメニュー、履歴の操作、Subagent、Background Terminal、Usage、エラーはコードと既存テストから監査した。表示や使い勝手の問題は**検証すべき仮説**で、実画面で確認済みとは扱わない。既存文書の過去画像や実機検証も今回の再検証と混同しない。
- 画像例: [現行 Chat](evidence/ui-redesign/images/current-chat-390-dark.png) / [現行 Home](evidence/ui-redesign/images/current-home-390-dark.png) / [現行 Approval](evidence/ui-redesign/images/current-approval-390-dark.png) / [現行 Settings](evidence/ui-redesign/images/current-settings-390-dark.png)。この fixture の文面・データは製品の全状態を代表しない。

## 現行 UI の監査

「画面」は上記 fixture で視認したこと。「コード」は構造上確認できること。「課題」はデザイン上の判断または未検証仮説。

| 対象 | 根拠と画面上の観察 | 課題と優先度 |
|---|---|---|
| Home | 画面: 最近の会話が独立した枠付き行で並ぶ。コード: `history.ts` と `styles.css:412–425` の `.session-card`、`.session-list`。 | **高**: 各行の境界と大きな間隔がタイトル群の読み比べを分断し、長い履歴の密度を下げる。選択・実行状態は行内の文字でも区別する。 |
| Chat | 画面: ユーザーの吹き出し、作業ログ、本文、ファイル一覧、Composer が縦に並ぶ。`transcript.ts:109–135`, `styles.css:50–93`。 | **高**: 補助アクションと枠が本文と競合する。完成回答を最も読みやすくし、作業ログは状態と展開可能性を保つ。 |
| Composer | 画面: 固定入力欄が高さを占め、変更一覧が直上に来る。`styles.css:306–353`、`composer.ts:233–281`。 | **高**: 390px で会話の可視面積に対して固定部が大きい。最小高さと縦方向の情報を再配分し、送信・停止・モード・モデルは常に認識可能にする。 |
| Plan / Build | コード: `plan-view.ts:35–76` が名称、phase、詳細、Build モデル、Build を構成。`styles.css:472–487` は枠付き領域。 | **高・仮説**: Plan 表示・Build 実行可否・モデルが狭幅で競合し得る。Plan の確認と実行は別の明示状態にし、誤操作防止と変更済み revision の検証を保持。 |
| モデル選択 | コード: `composer.ts:239–244` がラベル全文を title/aria-label に設定。`styles.css:329–330,387–393` は制約幅と検索メニュー。 | **中・仮説**: 長いモデル名と effort が狭幅で切れる。選択中の全文・変更対象・利用不可理由をメニューで見せ、ellipsis は表示だけにする。実メニューの幅・キーボード操作は未観察。 |
| 承認 | 画面: 実行中ログと承認カードが会話の流れに並ぶ。コード: `cards.ts:7–35`, `styles.css:232–240`。 | **高**: 承認対象と作用範囲を一目で読み、許可・拒否を明確に区別する。カードの視認性は必要だが、一般的なカードと同じ強さで埋もれないようにする。長いコマンドの視認性は未検証。 |
| 履歴 | コード: `history.ts` は Home のセッション行、`app.ts:168–171` が表示を切替。`history.ts:31–33` は全文 title/aria-current。 | **中・仮説**: 時刻、状態、長いタイトルを並べると余白と情報量が競合する。クリック可能な行と選択状態を共通化。履歴固有操作は今回未操作。 |
| ツール実行 | 画面: 完了ログ中に file 読取行と枠・区切りを持つ shell が混在。`transcript.ts:301–454`, `styles.css:109–124`。 | **高**: 成功・実行中・失敗の意味と対象を同じ順序で示す。複数階層の境界は展開時に限る。色以外の文字・アイコンも必要。 |
| 変更ファイル | 画面: 下部に件数・差分数・ファイル操作が Composer に近接。`composer.ts:312–342`, `styles.css:111–135,182–217`。 | **高**: 集計・一覧・diff の階層が複数箇所に分散し得る。件数と +/-、対象、Review を一貫して対応づける。未保存や復元不可の既存制約は保持。 |
| Subagent | コード: `subagents.ts:29–80,90–140` はドック付近の一覧と詳細、`styles.css:251–299` は 0.78em の補助文字・枠付き詳細。 | **中・仮説**: 状態・タスク・進捗が小さな文字と多段の枠に分かれる。親会話への戻り、実行・完了・失敗、経過時間の根拠を明瞭にする。 |
| Background Terminal | コード: `header.ts:70`, `composer.ts:312–342`, `styles.css:488–510` に入口・実行中一覧・停止。 | **中・仮説**: 入口が複数あり、長いコマンドと停止の対象が狭幅で曖昧になり得る。対象を明示した行と詳細で統一。 |
| Settings | 画面: 会話領域に設定シートが開き、多数の設定が並ぶ。`settings.ts:6–114`, `app.ts:180–183`。 | **中**: 設定値と補足・外部設定への遷移が同じ密度で並ぶ。グループと現在値を優先し、永続設定は VS Code 設定への導線を保つ。 |
| Usage | コード: `app.ts:185–195` は未取得・非対応を区別し、`styles.css:495–497` は固定 11px。 | **中・仮説**: ユーザーフォント設定の拡大時も固定 11px になり、本文と比べ小さい。数値の意味・非対応・未取得を分けて提示。 |
| エラー | コード: `app.ts:235` は alert text、`styles.css:232–240` は error-block にエラー枠。再試行などは発生源ごとに異なる。 | **高・仮説**: 発生箇所により対処方法や文脈が分散し得る。原因、実行結果、次の操作をまとめ、未実行と失敗を混同しない。 |

横断所見: `styles.css:8–19` にはテーマ・フォント変数と focus outline、`440–455` に HC/forced-colors、`301` に reduced motion がある。これらは良い土台であり、テーマ変数を使うことだけではコントラストを保証しない。色を混合する箇所や固定 11px を実テーマで再検証する。`@container (max-width:340px)` は既存だが 300/390/520px の全状態での成立を示す証拠ではない。

## 参考製品: 観察と抽出原則

| 参照 | 見たもの・出典 | 採用する原則 / 制限 |
|---|---|---|
| VS Code | [2026 Modernized UI](https://code.visualstudio.com/blogs/2026/10/15/modern-ui) の Dark/Light 画面を視覚確認。工作領域とサイドバーは近い色相で分離され、文字・内容が主役。公式記事は密度へのフィードバック、Compact、接続タブ、共通トークンも説明。 | 境界は領域単位、情報量は密度で守る。色・余白・フォントを共通化し、拡張だけ独立したブランドを作らない。[UX](https://code.visualstudio.com/api/ux-guidelines/overview) / [Webview](https://code.visualstudio.com/api/ux-guidelines/webviews) はテーマ、コントラスト、キーボード、ARIA を要求。 |
| Cursor | [Plan Mode 記事](https://cursor.com/blog/plan-mode) の公開スクリーンショットを視覚確認。会話内で plan の見出し・概要・todo がまとまり、詳細確認へ段階的に進む。記事はレビュー後 Build を記述。[Agent](https://cursor.com/docs/agent/overview) と [モデル選択](https://cursor.com/help/models-and-usage/available-models) はツールと入力付近のモデル選択を説明。 | 状態の近くに次の行動、計画はレビュー可能にする。モデル選択・履歴・実行時の最新 IDE 画面は高解像度で直接確認できていないため、見た目の細部は推測しない。 |
| Codex | [Codex app 紹介](https://openai.com/index/introducing-the-codex-app/) と [Codex の更新](https://openai.com/index/introducing-upgrades-to-codex/) を確認。前者のページ上の現在の紹介は旧製品紹介で、比較可能な会話・承認・変更ファイルの静止画を十分確認できなかった。 | 複数作業の進捗とレビューを会話上で追えることを原則にする。操作の見た目や正確な位置は再現しない。リポジトリ内の過去のユーザー提供画面については `UI_GAP_ANALYSIS.md` の記述を二次資料として扱い、今回の視覚確認とは区別する。 |
| Linear | [Linear design](https://linear.app/now/behind-the-latest-design-refresh) 等の公開資料を参照。現行製品の実画面を十分な大きさで比較できていない。 | 対象に近いアクション、一定の行揃え、補助文字の抑制は提案上の一般原則として扱う。Linear 固有の実測値や画面上の断定はしない。 |

参照製品の画面はバージョン・設定で変化する。ブラウザーの公開記事とこの環境の確認範囲に限定される。実製品の認証・有料機能・スクリーンリーダー・実機の IDE 操作は確認していない。

## 検証環境

ルート `npm run check`, `npm test`, `npm run test:coverage`, `npm run test:hygiene` が既定チェック。統合テストは VS Code が必要で、live テストは認証・使用量を伴う。DOM テストは `test/webview`、実機用 fixture は `test/integration`。本フェーズの成果物は文書と静的プレビューで本番実装の変更はない。今回の実施結果は仕様書の検証記録に記載する。
