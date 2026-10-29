# Cursor 3.26.13 ソース解析（2026-10-29）

対象はローカルの署名済み Cursor 3.26.13、commit `3bfec373749d3d4a53a151283022d49743ab50b0`。アプリは読み取り専用で調べた。`workbench.desktop.main.js`（41,358,576 bytes）、`workbench.glass.main.js`（49,214,785 bytes）、両 CSS（desktop 1,278,054 bytes、glass 1,286,271 bytes）。指定の `workbench.js` は当該ディレクトリにない。ローカル source map は見つからず、JS末尾の sourceMappingURL は内部ホストを指す。以下の位置は UTF-8 としてデコードした文字位置であり、バイトオフセットではない。元ソースの完全復元ではなく、圧縮後の関数境界、文字列、呼び出しと JSX / Solid テンプレートを追った。機械可読の証拠と範囲は [source](cursor-ui-analysis/source/index.html)。

Desktop と Glass の両 JS に `ThinkingLine.js`、`step-group-display.js`、レビューと Composer が存在し、主要なロジックを共有する。位置や Glass 固有のコード、CSS の配置は異なる。React compiler memo cache と JSX runtime、Solid のリアクティブテンプレートの両方があり、元のソース構成や実行条件まで同一とは断定しない。CSS-in-JS の StyleX 形状（`$$css` と生成クラス）がある。Thinking の `ui-byyjgo` / `ui-13epnph` は両主要 CSS で見つからず、別 stylesheet や動的挿入を含む実際の供給元は未確定。`composer-rendered-message` は CSS に無いが JS の human renderer に存在し、実 DOM にもある。inline style、`data-message-*`、テーマ変数、状態に応じたクラスが併用される。CSS 検索の不一致を要素不存在と解釈しない。

## コンポーネントと状態

| UI | JS（desktop 文字位置） | DOM / CSS | 状態と根拠 |
| --- | --- | --- | --- |
| User | 29622400、29626800 human renderer | `.composer-rendered-message[data-message-kind=human]` → `.composer-human-message`、CSS 523622 | hidden は inline display、suppressed / plan 実行で子を分岐。幅100%、hover、12px は既存ライブ記録と対応 |
| Thinking | 11086000–11089108、`Npu` / `V5s` / `Lpu` | `.ui-thinking-collapsible` → header、StyleX | loading は本文があれば初期展開しユーザーが閉じられる。完了時は別 state で初期閉。見出しだけなら展開不可。500ms未満は基本 briefly。ヘッダー解析指定に例外あり |
| Activity / Tool | 11089108–11095976、`Wpu` と各分岐 | `.agent-transcript-row-work-group` → collapsible header | 思考のみ、ブラウザ、待機、編集、コマンド、画像、混合の順に選択。コマンドのみなら件数または1件の説明。混合はファイル・検索・fetch・lint・コマンド等を並べる。集約元の全イベント規則は未追跡 |
| Review | 28784500–28796350、`fTr`、`acceptAll` / `rejectAll` | `.composer-toolbar-section-header`、CSS 515268、inline flex | 件数は URI 集合を別に集計。pending tool decision は個別 accept/reject、通常は全差分処理、worktree適用済みは別 undo。Undo は2回確認、4秒で解除。questionnaire は帯を抑制 |
| Composer | 28517783、28671416 | `.full-input-box` → input → `.composer-bar-input-buttons`。CSS 241710、mode CSS 220384 | input/focus/submit と toolbar を分離。実チャット操作行28px、箱75px。全メニューの表示条件は未追跡 |
| Plan | 10996810、11390328、29833083 | activity 内 View Plan / Build、本文は別 `.plan-editor` | 実画面で Plan 完了後のボタンを観測。Build の完全な条件・遷移は未追跡 |
| Assistant / Terminal / Subagent | assistant は関数未特定。`step-layout.js` は shell を詳細モードで block、task を text として扱う | 回答 `.ui-markdown`。展開 terminal は未実測 | 回答に枠なし。詳細出力・失敗の実画面と全親子関係は未確認 |

Review の `fTr` は個別の表示条件を返すが、その内部の全依存関係は未解明。toolbar の可視性はファイル・pending decisions・実行・質問など複数の条件の和で、ファイル数と受け入れ可能性は同一ではない。別のメニューは各 inline diff に accept/reject を呼ぶ。ライブでは Keep 後もファイル数と Review が残るが、それだけで内部履歴や実ファイルの保存方式は確定できない。新しい変更後の再レビューもライブ未確認。

## CSS と実測の関係

詳細な宣言、条件、specificity は [css-rules.json](cursor-ui-analysis/source/css-rules.json)。ユーザーカードは `:not(.standalone-glass)` を含む specificity (0,2,0)、`width:100%`、input背景、secondary stroke、surface radius。Composer の static CSS は `.ai-input-full-input-box` の padding `8px 10px 6px`、gap 6px、border / radius 変数。レビューラベル hover は opacity `.8 → 1`。通常ルールとユーティリティ層、疑似クラス、テーマ変数、inline style が混在する。存在する container utility は確認したが、対象コンポーネントへの container query 適用は確認していない。メディア条件の全列挙や優先順位の完全な cascade 解決は未実施。

[2026-10-29 の実測](CURSOR_UI_CHAT_LIVE_2026.md)は workbench chat、Dark、400px editor group。User は368px、12px radius、前景12%枠、Assistantは14px/22px枠なし、活動見出し14px/22px、Composer枠20%、操作行28px、Reviewは直上。宣言の変数と computed 値は対応する候補だが `CSS.getMatchedStylesForNode` を取得していないため、実際の優先順位・上書き原因を確定したとは言えない。以前の PID 34502 は存在せず、9334 も応答しない。実チャットの DOM・snapshot は保存済み JSON のみで、新たな live 計測ではない。幅別、Light / HC、展開思考、Terminal、メニュー、送信中の Cursor 実測は未取得。
