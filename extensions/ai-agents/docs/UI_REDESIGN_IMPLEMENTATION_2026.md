# Conversation Focus の本番実装と検証

2026-10-28。正式採用された C 案を `src/webview` 全体へ反映した。既存の Provider / Backend / Host protocol / 認証 / セッション処理は変更していない。設計基準は [承認済み仕様](UI_REDESIGN_SPEC_2026.md)、背景は [監査](UI_REDESIGN_AUDIT_2026.md)。

## 反映した内容

| 領域 / 主なファイル | 変更 |
|---|---|
| 共通 / `styles.css`, `strings.ts` | 4/8/12/16/24px 相当の間隔、相対文字サイズ、意味に沿ったテーマ色、4px 程度の操作部と 7px 程度の入力部の角丸、最小 28px の主要操作、focus-visible を統一。派手な面や固定の Plan 色を廃止。High Contrast と reduced motion を保持。 |
| Home / `history.ts`, `header.ts` | 枠付きカードから左揃えの行へ。時刻、状態文字、選択状態を追加し、新規開始を明確化。Chat のヘッダーは戻る・全文を保持した省略タイトル・新規・設定。 |
| Chat / `transcript.ts`, `app.ts` | 本文・段落・見出しを中心に配置し、完了ログは折りたたむ。展開状態を保持し、実行中は対象と状態を簡潔に表示。Usage を本文より下位に移動。Plan は対応する会話の後に配置。 |
| Composer / `composer.ts` | 大きな固定最小高を廃止。入力、モード、モデル、添付、Queue/Stop を整理。300px では必要に応じて操作行を折り返す。実際の作業環境と権限をフッターで確認できる。入力の成長は 30vh 以下。 |
| 変更 / Terminal / Subagent | 変更件数と Review を集約し、ファイル一覧を開閉。Terminal と Subagent は高さを制限した活動領域で確認。パスや停止対象の accessible name を明示。詳細・出力・差分・復元可否を維持。 |
| 承認 / 質問 / Plan / `cards.ts`, `plan-view.ts` | 左境界と見出しで判断領域を区別。主操作と補助操作を揃え、複数の承認選択肢と複数質問を保持。自由入力質問に accessible name を付与。Build の revision・モデル・canBuild 制約を保持。 |
| Settings / `settings.ts` | 実行設定と関連操作を整列。承認ポリシーと権限を区別。無関係な state 更新でフォーカスを失わないようにし、閉鎖時は入口へ戻す。 |
| メニュー / `popover.ts` | 検索・チェック・階層メニュー・キーボード操作を保持。通常メニューも実測幅で位置を決め、狭幅の長い内容が領域外へ出るのを防止。 |
| Usage / エラー | 固定 11px を相対サイズに変更。取得なし・非対応・0 の既存の区別を保持。エラーの説明と Retry / Logs / Diagnose を本文中で確認可能にする。 |

## 静的プロトタイプとの差異

以下は機能を保持するための意図的な変更で、実装漏れではない。

- 承認は「許可」「セッション中の許可」「拒否」の既存選択肢を残す。300px では折り返す。
- Composer は添付・Stop・Queue を同時に使えるため、300px の実行中は二行になることがある。環境・権限は実際の capability の文言で示す。
- shell の展開内容はコマンド全文と出力を読み分けられる構成を維持。完了したログ全体は既定で閉じる。
- Plan の生成経路・復元注意・以前の版・Build モデル・実行不能状態を維持。静的な Build ボタンに機能を限定しない。
- Home は明示的な新規開始と時刻・状態を持つ。状態を色だけに頼らない。

## 撮影と改善のサイクル

[Before / C 案 / After の比較](evidence/ui-redesign/comparison.html)、[全画面ギャラリー](evidence/ui-redesign/final/index.html)、[自動計測結果](evidence/ui-redesign/final/report.json)、[ブラウザー操作結果](evidence/ui-redesign/final/functional.json)。画像とテスト証跡は Git の対象外に保存した。

1. 変更前の本番バンドルをローカルに保存し、同じ fixture で Home / Chat / Approval / Settings の Before を撮影。
2. 基本実装後、指定 12 状態の 216 画面を撮影。ページ横はみ出しはなかったが、目視で完了ログの強調と Plan の位置を修正。
3. Light の補助文字と境界が Dark の root token を継承する問題を目視で発見。意味別トークンをテーマ適用後に解決するよう修正。
4. 396 画面へ拡張。選択中の履歴時刻が 4.36:1 になる組合せを検出し、選択面に対応する foreground を使用するよう修正。
5. 300px の警告文が補助ボタンに圧迫される配置を grid に改め、説明と操作を別行へ整理。補助操作の最小領域と Light の native control の color-scheme、Subagent 詳細の重複境界も整えた。
6. 全行列を再撮影し、横はみ出し、対象操作の領域外表示、ランタイム例外、対象文字のコントラスト不足が検出されない状態を確認。

行列は 300/390/520px × Dark/Light/HC × 日英 × 22 状態。要求された 12 状態に加え、空 Home、モデル一覧・モードメニュー、質問、Usage、Queue、多数の変更、展開 Plan、Subagent 詳細、警告を含む。長いタイトルとモデル名を使用する。縮小一覧で各条件を比較し、代表画面は元サイズで確認した。自動コントラスト計測は指定文字要素のサンプルであり、全ピクセルや任意のテーマに対する保証ではない。

## 機能検証と実機検証

機能検証と視覚検証は独立して実施した。

- ブラウザー操作テスト 22 項目: 完了ログ開閉、diff の conversation identity、モデル階層メニューと検索フォーカス、Esc、モード選択、設定のフォーカス保持と復帰、Queue、Stop、合成 IME イベント、送信、承認 token、Build revision と二重実行防止、複数質問、Retry、Subagent 往復、スクロール追従の抑制と Latest、Terminal 停止対象を確認。Host は mock である。
- 実 VS Code 1.143.1 / macOS arm64 の分離した Extension Development Host で、production Webview とテスト Backend を使用。ユーザーの通常プロファイルや認証情報をコピーせず実施。
- ネイティブ GUI で、日本語テキスト入力、Shift+Enter 改行、Enter 送信と返信、モデルメニュー、Esc、設定フォーカス、会話スクロール、Plan 詳細→Build→Build finished、承認待ち→Allow→再開を確認。[入力送信](evidence/ui-redesign/native-send.png) / [Plan 詳細](evidence/ui-redesign/native-plan.png) / [承認](evidence/ui-redesign/native-approval.png)。これらは **実 VS Code 上の mock Backend** の結果であり、実 Provider 推論の検証ではない。
- Extension Host 統合テストでは、ready handshake、SDK subprocess、Stop / Queue、背景会話、モデル、履歴、権限 token、diff / revert、OS クリップボードの Unicode 往復などが成功。

再現方法は [UI preview README](../test/ui-preview/README.md)。ルートの `npm run test:ui` は必要なビルド、全行列撮影、操作検証を行う。CI の既存条件や失敗判定は変更していない。

## チェック結果

| 実行 | 結果 |
|---|---|
| `npm run check` | 成功 |
| `npm test` | 919 件成功、失敗 0 |
| `npm run test:coverage` | 成功。Statements / Functions / Lines 100%、Branches 99.91% |
| `npm run test:hygiene` | 成功 |
| `npm run build` | 成功 |
| `npm run test:ui` | 396 枚、22 操作チェック成功。自動検出の所見 0 |
| Extension Host integration | VS Code 1.143.1、最終実装で成功。mock Backend の使用 |

回帰テストは `conversation-focus.test.ts` に完了ログの開閉と更新保持、変更ファイルの操作対象とフォーカス、Settings のフォーカス復帰、Home の状態・時刻・新規操作を追加。メニューの実測幅による狭幅配置も追加した。画像添付テストは固定 30ms 待機を実際の読み込み完了待ちへ変更し、描画負荷が高い時のタイミング依存を解消した。

## 制限と残る確認

- ブラウザーの 3 テーマは代表値。実 VS Code の全テーマや High Contrast Light、フォント拡大の全組合せ、100% 以外の OS 表示倍率は未網羅。
- 実機の日本語はテキスト入力と改行・送信を確認した。OS 日本語 IME の変換候補・確定操作は未検証で、合成イベントの成功と混同しない。
- スクリーンリーダーによる通読、長時間・大量履歴の性能ベンチマーク、実 Provider の認証や課金を伴う live inference は未実施。
- 自動撮影は代表 fixture と viewport 800px 高での検証。モデルの全パラメーター、全 Provider capability の組合せ、極端に低いウィンドウの手動検証は残る。
- 確認済み範囲に未解決の視覚的破綻は見つかっていない。任意の内容・テーマで完全に破綻しないことを主張するものではない。
