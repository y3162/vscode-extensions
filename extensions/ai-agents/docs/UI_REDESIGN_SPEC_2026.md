# AI Agents UI 再設計仕様・比較案

調査日: 2026-10-28。監査の証拠と限界は [監査レポート](UI_REDESIGN_AUDIT_2026.md)。C 案を正式採用。設計時の比較を本稿に残し、実装結果と検証記録は [本番実装レポート](UI_REDESIGN_IMPLEMENTATION_2026.md) に記載する。表示例は架空データを使用した静的デザイン検討用で、実行・送信・承認などの機能はない。

## 比較と推奨

| | A. VS Code Native Minimal | B. Cursor-style Productive | C. Codex-style Conversation Focus |
|---|---|---|---|
| 中心思想 | ワークベンチの行・操作に溶け込み、密度を優先 | 実行状況と次の操作を近くに置き、作業を早く進める | 依頼・進捗・結果を一続きで読み、レビューと判断に集中 |
| 長所 | 狭幅に強く馴染みやすい。最小限の境界 | 状態とツールを素早く追える。実行中に強い | 長い回答の可読性と承認の文脈が最も明確 |
| 欠点 | 単調になりやすく、重要な判断が埋もれる | 活動が多い時に結果よりログが目立つ | 広い余白が短い画面で密度を下げる |
| 現行との差 | Home を枠なし行、タイトルと操作をワークベンチ風に整理 | 状態をコンパクトな実行行へ、ツールと変更を揃える | 完成回答を本文として扱い、ログを階層化。注意を要する状態のみ境界を使う |
| 実装コスト | 中: 共通 CSS と Home/行の整理 | 中〜高: 実行状態とツールの共通行、狭幅での操作設計 | 中〜高: turn/log 階層と結果・承認の配置、スクロール保持 |
| 静的比較 | [Chat](evidence/ui-redesign/images/a-chat-390-dark.png) | [Chat](evidence/ui-redesign/images/b-chat-390-dark.png) | [Chat](evidence/ui-redesign/images/c-chat-390-dark.png) |

**推奨は C**。この拡張の主な仕事は会話を通じて結果を読み、進捗と変更を確認し、必要な判断をすること。C は回答と承認の主従が分かりやすく、実行ログの詳細も失わずに畳める。ただし狭いサイドバーでは余白を抑え、B のコンパクトな実行行と A の VS Code トークン・フォーカス規則を共通基盤として採用する。比較は現時点の設計判断であり、実利用試験による優劣の証明ではない。

## 案ごとの具体規則

| 要素 | A | B | C |
|---|---|---|---|
| レイアウト | 単一カラム。左右 8–12px。行は 28–32px | 単一カラム。左右 12px。進行中の状態行を回答の直前 | 単一カラム。390px 以上は左右 16–18px、300px は 10px |
| 文字階層 | 本文 1em、見出し 1em/600、補足 .92em | 同左。対象と状態を 1 行、詳細は次行 | 本文 1em/1.55–1.6、見出し 1em/600、段落を明確に分離 |
| 余白・色 | 4px 刻み。透過ボタンと細い区切り | 4–12px。進行行だけ hover 相当の面 | 8–20px。本文は地色、警告・承認のみ強い境界 |
| Composer | 4px 角、短い入力高。モデル/モードは下段 | 8px 角、モード・モデル・添付・送信をまとまりとして維持 | 7px 角。十分な入力面、コンパクトな下段。会話を覆わない |
| 会話 | メッセージとツールをフラットな行に | 実行要約とツールを密な活動列に | ユーザー依頼を弱い面で区別、回答は地の文、完了ログを折りたたむ |
| Home | 枠なしリスト、タイトルと時刻を整列 | 最近の作業と状態を密な一覧で提示 | 最近の会話を少数表示し、開始操作を強調 |
| 状態 | テキスト＋小アイコン。線で区分 | 実行行に状態と現在の対象。失敗/承認待ちは常時表示 | 会話内で進捗を要約し、判断待ちは対象・説明・操作を一箇所に |

この比較プロトタイプは同一 fixture の密度・区切り・面を比較するもの。各案の全ての操作や仕様を実装していない。

## 共通デザインシステム

- **Typography**: 基準は `var(--vscode-font-family)` と `var(--vscode-font-size)` (既定 13px は例)。本文 1em / line-height 1.5〜1.6、セクション 1em / 600、補足 .92em / 1.4。固定 px の小文字を新設しない。コードは `--vscode-editor-font-family` とエディタのフォントサイズ設定を尊重。狭幅でも日本語と英語を同一サイズで、必要に応じて折り返す。
- **Spacing**: 4 / 8 / 12 / 16 / 24px 相当を基準にし、実装はフォント拡大にも耐える `em` ベースまたは density token。行内 4–8、関連要素 8、セクション 16、ターン 20–24。300px は左右 8–10px、390px 12–16px、520px 16–20px。
- **Surface / border**: ベース `--vscode-sideBar-background`、入力 `--vscode-input-background`、メニュー `--vscode-editorWidget-background`。分離はまず余白、必要な場合 `--vscode-panel-border`、入力は `--vscode-input-border`。テーマに border が未定義なら `--vscode-contrastBorder` 等の意味ある fallback を使う。面の上に枠付きカードを重ねない。
- **Radius**: 行/小ボタン 4px 相当、Composer 6–8px、吹き出し 8–12px。角丸の多用を避け、High Contrast では形状に頼らず境界を明示。
- **Semantic color**: 通常 `--vscode-foreground`、補足 `--vscode-descriptionForeground`、リンク `--vscode-textLink-foreground`、実行 `--vscode-progressBar-background`、警告 `--vscode-editorWarning-foreground`、エラー `--vscode-errorForeground`、成功 `--vscode-testing-iconPassed`、差分 `--vscode-gitDecoration-addedResourceForeground` / `--vscode-gitDecoration-deletedResourceForeground`。警告枠 `--vscode-inputValidation-warningBorder`、エラー枠 `--vscode-inputValidation-errorBorder`。状態は必ずテキストと形も併用し、色だけで伝えない。実テーマで文字 4.5:1、非テキスト境界 3:1 を目標に確認。
- **Button / icon / menu**: primary は文脈内で 1 つ、`--vscode-button-*`。secondary は `--vscode-button-secondary*`、補助は透明。アイコンは codicons、24–28px 以上の操作領域と accessible name。メニューはタイトル・選択チェック・必要なら検索、長い名前は省略時も全文を title / accessible name で保持。Esc で閉じ、フォーカスを元のトリガーへ戻す。
- **States**: hover は `--vscode-toolbar-hoverBackground` / `--vscode-list-hoverBackground`、focus-visible は `--vscode-focusBorder` の 2px 相当、active/selected は list selection token と文字または形で表示。disabled は意味と理由を示し、色・opacity のみで判定しない。forced-colors ではシステム色と `--vscode-contrastBorder` を使う。reduced motion では回転を停止し、テキストを残す。
- **Responsive**: 520px は単一カラムで読みやすさ優先、390px は主操作を一列に、300px 以下は Composer のメタ操作を折り返し、承認操作を必要なら縦積み。タイトル・モデル名は縮小可能な領域で ellipsis、全文はアクセス可能な名前と詳細で確認。コード・diff は局所的に横スクロールし、ページ全体を横スクロールさせない。高さが不足する時は会話をスクロールし、入力欄の成長を viewport の 40% 以下に制限する。必要な操作を単に非表示にしない。

## 状態別の振る舞い

| 状態 | 優先表示と操作 |
|---|---|
| Home / 履歴 | 最近のタイトル、状態、相対時刻。行全体が操作対象。長いタイトルは省略＋全文。空時は新規開始。 |
| 会話完了 | 回答とファイル変更を優先。完了ログは要約と展開、ユーザーメッセージは編集・再送の既存制約を保持。 |
| 実行中 / Build | 現在の対象と「実行中」、停止、キューの意味を明示。最新へ戻る操作は自動追従を奪わない。 |
| Plan 待機 | プラン名、概要、状態、詳細、対象 revision と Build の可否。モデル選択は Build 対象を明確にする。再生成・復元・古い revision の既存検証は保持。 |
| 承認 / 質問待ち | 種別、対象、作用範囲、全文、許可・拒否の区別を会話の末尾で提示。複数質問や unavailable は現行 capability に従う。 |
| ツール / Background Terminal | 状態＋対象＋経過、展開で出力。失敗は原因と次の操作。停止ボタンは対象を accessible name に含む。 |
| 変更ファイル | ファイル名、パス、+/-、diff と復元の可否を対応づける。大量ファイルは折りたたみ、全文/パスへアクセス可能。 |
| Subagent | 名前・タスク・状態・進捗を一行または二行、詳細では親へ戻る・結果・エラー。非同期更新は視覚と読み上げで区別。 |
| Settings / Usage | 設定群と現在値を揃え、VS Code の設定画面への導線を維持。Usage は未取得・非対応・0 を区別。 |
| エラー | 何が失敗し、何が実行済みか、できる次の行動。通知とターン内エラーを統一し、再試行が既存操作を取り消すと誤認させない。 |

## プレビューと検証

[比較プロトタイプを開く](ui-redesign-preview/index.html)（既定 C / Chat）。URL クエリ `variant=a|b|c`、`scene=home|chat|approval|plan|build|subagent|terminal|error|history|settings`、`theme=dark|light|hc`、`lang=ja|en`、`width=300|390|520`。例: `index.html?variant=c&scene=approval&theme=hc&width=300`。ボタンは表示見本、メニュー・承認・送信は動作しない。スクリーンショットは [300px HC 承認](evidence/ui-redesign/images/c-approval-300-hc.png)、[390px Light Plan](evidence/ui-redesign/images/c-plan-390-light.png)、[520px Dark Home](evidence/ui-redesign/images/c-home-520-dark.png)。CSS は VS Code 変数名で構成し、ブラウザーでは固定の近似テーマ値を使用するため実 VS Code テーマの検証ではない。

現行のブラウザー fixture は [current.html](ui-redesign-preview/current.html) から開ける。`scene=home|chat|running|approval|settings` 等、`lang=ja|en`、`theme=light|hc`、`width=390&height=800`。事前にルートで `npm run build` が必要。元の fixture は現行 shell との不整合があるため、上記複製に空配列を追加した。比較ページは `dist` を参照するが、本番ソースとビルド設定を変更しない。

検証対象の条件は 3 幅 × Dark / Light / HC、日英、長いタイトル・モデル名、実行・承認・エラー・Plan・Build・Subagent・Terminal。静的例はこの条件の代表例であり、全組合せ・文字拡大・スクリーンリーダー・キーボード・実テーマの確認を意味しない。設計選択後に実装 fixture を拡充し、以下を確認する。

1. 全幅・全テーマ・両言語で各状態を撮影し、横はみ出し、重要操作の消失、入力領域と会話の高さ、全文へのアクセスを確認。
2. Tab / Shift+Tab / Enter / Space / Esc、フォーカス復帰、ライブ領域の過剰読み上げ、スクリーンリーダー、forced-colors と reduced-motion を確認。
3. 主要導線（会話再開、モデル変更、Plan→Build、承認/拒否、差分、停止、エラー回復）を Extension Host の fixture と手動実機で検証。
4. ルートの `npm run check`、`npm test`、`npm run test:coverage`、`npm run test:hygiene`、必要な integration/build/package を実行。live テストは認証・使用量と実機条件を明示して別途判断。

**現在の検証結果:** 静止画の目視とコード監査を実施。`npm run check`、`npm test`（914 件成功）、`npm run test:coverage`、`npm run test:hygiene` は成功。リンク存在とプレビュー JavaScript の構文も確認した。操作可能な本番モック、完全な組合せ確認、実機アクセシビリティ・パフォーマンスは未実施。追加検証が必要なものを完成扱いにしない。
