# AI Agents UI 実装計画（2026-10-28）

仕様は [CURSOR_UI_IMPLEMENTATION_SPEC_2026.md](CURSOR_UI_IMPLEMENTATION_SPEC_2026.md)。本番コードはこの計画の時点では未変更。HEAD は `f146f8fe7ab0231971a345764c5bad4cf2ef4419`。

## 既存との差分

残すもの:

- Extension Host、Webview、Codex CLI、Cursor CLI
- `ViewMessage`、`ViewPlan`、`ViewChange`、`permission` のプロトコル
- セッション、履歴、rewind、承認の postMessage 名
- High Contrast のフォーカス枠

変えるもの:

- ユーザーカードを列幅 100% の左カードに固定する。project レイアウトの右吹き出しは採らない
- 活動を「作業時間」1 行と、Explored / Ran / Edited のグループにする
- 思考本文が空の行を消す
- 回答の吹き出し枠を消す
- レビューを Composer 直上の 1 行にする。未受け入れは Undo と Keep を出し、受け入れ後は外す
- Composer を 12px の一体枠と、28px の操作行にする。枠は前景 20%
- 680px 以上で 640px 列を中央に置く

会話の em 余白（`--ui-space-*`）は、会話カラムに限って px トークンへ置き換える。設定画面の余白は触らない。

## ファイル

| ファイル | 変更 |
| --- | --- |
| `src/webview/styles.css` | トークン、ユーザーカード、活動行、回答、レビュー、Composer、640px 列 |
| `src/webview/turns.ts` | shell と edit の連続グループ。空の thinking を落とす。作業時間用の表示値 |
| `src/webview/transcript.ts` | 新しい DOM。開閉状態。回答と活動の順 |
| `src/webview/composer.ts` | バーの DOM 順。メニューを上に開く。最小高さ 44px |
| `src/webview/cards.ts` | 承認の対象を先に出す。ボタン順 |
| `src/webview/plan-view.ts` | View plan と Build の並び。disabled の理由 |
| `src/webview/strings.ts` | 作業時間、Explored、Ran、Edited、briefly、中断 |
| `src/webview/subagents.ts` | ターン内行とドックの役割を分ける |
| 対応する `*.test.ts` | グループ化、空思考、作業時間の境界 |

`src/protocol.ts` と CLI アダプタは変えない。表示に足りない秒は、既存の `startedAt` / `endedAt` / `durationMs` が無いものとして隠す。

## 順序

1. `turns.ts` のグループ化と空思考の削除。テストを先に足す。見た目はまだ古い CSS でよい。
2. トークンと列幅。ユーザーカードと回答。
3. 活動行の開閉。ターミナルは 8em。
4. レビューバーと Composer バー。
5. Plan と Approval の並び。
6. 300 / 390 / 600 / 1000 と Dark / Light / High Contrast を、既存のレイアウト計測と同じ Extension Development Host で見る。

各段階で `npm test` と `npm run check` をリポジトリルートから実行する。最後に `npm run test:hygiene`。

## テスト

- 連続する shell が 1 つの Ran グループになる。間に read があると分割される
- 連続する edit が Edited になり、ファイル数と増減を持つ
- thinking の text が空白だけならセグメントが残らない
- `endedAt` が無いターンに作業時間の文字列が無い
- 1ms 未満は作業時間を出さない。1 秒未満で 1 以上の差は `1s`
- 承認カードのボタン順が allow-once、allow-session、deny
- canBuild false の Build に accessible name で理由が入る
- 既存の送信、停止、rewind、履歴のテストが失敗しない

手動:

- 幅 300 でモデル名が切れ、Mode の文字が残る
- 幅 1000 で列が 640px
- 空の思考フィクスチャで文章が出ない
- 長いターミナルが 8em でスクロールする

## リスク

- グループ化を変えると、既存スナップショットテストが活動の件数を見ている可能性がある。件数の期待を更新する
- `color-mix` は High Contrast で薄くなる。`contrastBorder` へフォールバックする
- 640px 中央寄せが、設定や履歴の全幅レイアウトまで掛かると読みにくくなる。クラスは `.thread` と `.dock` だけに付ける
- Cursor の模擬思考を真似してプレースホルダを入れると、仕様の禁止に反する

## 完了

- 仕様の受入 12 項が、テストまたは Development Host の記録で満たされている
- CLI とプロトコルの diff が空である
- 思考本文を生成するコードが無い
- `npm test`、`npm run check`、`npm run test:hygiene` が通る

## 2026-10-29 に測れたもの

ライブの会話 DOM は、隔離した Cursor 3.26.13 のワークベンチチャットで取れた。記録は [CURSOR_UI_CHAT_LIVE_2026.md](CURSOR_UI_CHAT_LIVE_2026.md)。ユーザーカードは、そのチャット列の内容幅を埋めていた。サイドバー仕様の列幅 100% は維持する。

まだ測っていないのは、300 / 390 / 600 / 1000、Light、High Contrast、ストリーミング、思考とツールの展開、承認、サブエージェント、メニュー、Agents Window の会話である。これらが後から違っても、差分文書に無いものはこの仕様を上書きしない。
