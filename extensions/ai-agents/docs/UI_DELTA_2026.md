# UI 差分（2026-10-28）

基準は [C. Codex-style Conversation Focus](UI_REDESIGN_SPEC_2026.md)。比較記録は上書きしない。Cursor 本体の CSS px は未計測のため、ここにある長さは既存トークンと仕様の範囲で決めた値である。

## 画面

単一カラム。`.shell` の子はヘッダー、`.stage`（会話）、`.dock`（Composer、変更、サブエージェント）。Home は同じシェルで履歴を出す。

- ユーザー: `.bubble`。地の色に前景を 8% 混ぜた面。通常テーマでは枠を付けない。High Contrast と forced-colors では枠を戻す
- 回答: `.answer`。背景も枠も付けない
- ツール: 完了ターンは折りたたみ。行はアイコンと `.tool-state`（Running / Done / Failed、日本語は実行中 / 完了 / 失敗）
- 計画: 会話の後。Build できないときはボタンを無効にし、title と accessible name に理由を出す
- 承認: 末尾の `.pending-card`。左の境界は既存のまま
- Composer: モードとモデルは Capability どおり。画像非対応の実行方式では画像項目を無効にし、理由をメニューとエラーに出す

## トークン

既存の `:root` を維持する。

- 間隔: `--ui-space-1` から `--ui-space-6`（13px 基準でおよそ 4 / 8 / 12 / 16 / 24px）
- 角: `--ui-radius`、入力は `--ui-radius-input`
- 色: `--vscode-*` のみ。差分の追加と削除は git decoration。失敗は error、実行中は progress bar
- 文字: `em` と VS Code のフォント。固定 px の新しい文字サイズは置かない

## 幅

コンテナクエリ。ページ全体は横スクロールしない。コードと diff だけが局所スクロール。

- 300px 以下: gutter 約 10px（`.7692em`）。Composer の操作行、承認、Plan のモデルを折り返す
- それより広く 600px 未満: gutter 約 16px（`.shell` の `1.2308em`）。390px 付近は折り返さない
- 600px 以上: gutter 約 18px（`1.3846em`）。会話の左右パディングは約 20px

300 / 390 / 600 はコンテナ幅。テーマは Dark、Light、High Contrast、forced-colors、reduced motion を既存ルールで継続する。

## 状態

| 状態 | 表示 |
| --- | --- |
| Home | セッション行。表示スナップショットも一覧に出す。バックエンド再開とは別 |
| 会話 | ユーザー面と地の回答 |
| 実行中 | ログを開いたまま。ツールは「実行中」 |
| 完了 | ログを閉じる。ツールは「完了」または「失敗」 |
| Plan | `canBuild` のときだけ Build。unknown は Reload 後の文言 |
| 承認 | ホストがカードを送ったときだけ |
| サブエージェント | ドックは実行中と、その親にぶら下がる兄弟。完了だけならターン内の行 |
| 画像不可 | 添付は残し、画像だけ無効 |
| Rewind 不可 | ボタンは「入力に戻す」。分岐しない |
| Rewind 可 | 「再送信」。title は分岐であり、checkpoint があるときだけ、と書く |

無効なボタンは opacity だけにしない。Build、画像、入力へ戻す操作は、見える文字か accessible name に理由がある。
