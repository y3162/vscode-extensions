# Cursor model and UI stability — 2026-10-30

## Composer 2.5

調査対象は `/Users/sekiyuuta/.local/bin/agent`、CLI `2026.10.22-27dcf5f`。`--list-models` と `models` は成功し、`auto - Auto (default)`、`composer-2.5 - Composer 2.5`、`composer-2.5-fast - Composer 2.5 Fast` を別エントリとして返した。リストは多数の他モデルも含む。公式CLIはモデル一覧の取得をサポートし、公式ドキュメントはモデルIDを `composer-2.5` としている。CLI自身は一部モデルで角括弧によるオーバーライドを案内する。

実CLIに意図的に不正な `composer-2.5[invalid=invalid]` を指定したところ、モデル実行前に `Cannot use this model: composer-2.5[invalid=invalid]. Available models: ...` と拒否された。拡張機能は標準エラーの末尾4000文字だけを保持していたため、この先頭の理由と要求モデルが消えることを確認した。先頭を保持し、パイプが閉じるまで待つよう修正した。ログの一覧は依然4000文字に制限される。

ターンの選択にパラメータがない場合、旧セッションのパラメータにフォールバックするコードも修正した。例えば旧設定 `fast=true` の状態でターンに `composer-2.5` を指定すると、変更前は `--model composer-2.5[fast=true]`、変更後は `--model composer-2.5` となる。Mockでargvを検査する。現行CLIの一覧パーサーは上記2モデルを取得し、未掲載モデルを追加しない。

ただし元の報告時に実際に渡された引数は残っておらず、この経路が元の障害の直接原因と断定できない。隔離された空ディレクトリで `--model composer-2.5` を使った短い実CLI実行は成功し、initは表示名 `Composer 2.5`、結果は `OK.` を返した。実際の課金・ルーティング先の標準版とFast版の区別はこの応答から確認できない。過去のCursorサポート報告は標準IDがFastへルーティングされた問題を記載しており、現行版の挙動は未確認。保存済みの無効パラメータの完全な検証、エラー一覧のUI要約と詳細ログの分離も未完了。

## Webview幅とUI

過去のT19証拠ではWorkbench sidebarが309〜1172pxに変わる一方、Webview documentは298pxだった。保存Targetは1件で、古いTargetが原因とは断定できない。新たな計測ではWorkbench iframe 574pxに対し外側documentとactive frameは298px、後には1000pxへ追いついた。受入スクリプトが伝播前の値を使って補正を重ねる問題があり、階層間の一致を待ってから補正するよう変更した。不一致は15秒間の観測でも解消しない条件があり、前面化の試行でも再現した。VS Code側の根本原因は未確定で、修正後のT19もFAIL。

Model SelectorとPlan位置の既存未コミット変更は保持した。Composer/User/Activity/Reviewの色はCursorのDark実測とテーマ色の合成差が解明されていないため今回固定色を追加していない。Plan Build失敗・Stop後の位置はT13で確認した。Reload後の位置を検証するDOM順序Assertionを追加したが、T13は幅チェックで先に失敗し実Hostで未確認。

## 回帰と判定

- 型チェック、Hygiene、Build: PASS。
- Unit再実行: 854/854 PASS。Coverage再実行: 854/854 PASS。初回は並列実行中に各1件がタイムアウトした。
- UI fixture: 396 scenes PASS、画像取得なし。T13単独はPlan操作を通過したが300px待ちでFAIL、T19単独も幅同期でFAIL。修正後T13とT19も幅伝播不一致でFAIL。IntegrationはPASS。全件受入はT04実行中に中断したため、全件結果はない。証拠は `/private/tmp/ai-model-stability-all/`。
- A Composer 2.5 Integration: 未完了。元の送信引数と実際のルーティング先は未確認。実CLI単発実行は成功。
- B GUI Acceptance: 未完了。幅同期の根本原因とT01〜T20の新規全件結果が必要。
- C Cursor UI Fidelity: 部分評価。保存実測の対象外や色・Tool Detailsは未確認。

参考: [Cursor CLI model list](https://cursor.com/changelog/cli-jan-08-2026)、[Composer 2.5](https://prod.cursor.com/docs/models/cursor-composer-2-5)、[過去のCLIルーティング報告](https://forum.cursor.com/t/cli-model-returning-empty-list/164664/5)。
