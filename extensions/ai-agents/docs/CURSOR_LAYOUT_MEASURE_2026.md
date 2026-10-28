# Cursor レイアウト計測（2026-10-28）

Cursor IDE のサイドバー DOM は、この作業では計測していない。余白、最大幅、フォント、flex の数値を Cursor の実測値としては扱わない。Cursor への忠実度は未検証である。

通常の Cursor プロファイルと作業中のウィンドウは開いていない。隔離したのは VS Code 1.142.0 の Extension Development Host で、対象は `y3162.ai-agents` のサイドバーである。同じウィンドウの右側に出る「Build with Agent」は VS Code 本体のチャットであり、この拡張の画面でも Cursor の画面でもない。

## 使った資料

- [CURSOR_REFERENCE_2026.md](CURSOR_REFERENCE_2026.md)。公開リポジトリの役割名。CSS の px は未計測、と既に書いてある。
- CursorRemote の抽出が分ける `human` と `assistant`、折りたたみの思考、コンパクトなツール、View Plan と Build の分離。CursorRemote 独自の電話 UI CSS は使っていない。

## 設計目標

数値は目標であり、Cursor の計測値ではない。

| 領域 | 目標 |
| --- | --- |
| ユーザー発話 | 内容幅。行の末尾寄せ。最大幅は `min(34em, 88%)` |
| 回答 | 地の文。左から読む |
| 作業ログ | 回答の上。完了後は 1 行。失敗理由は折りたたみの外 |
| Composer | 入力が主。その下の 1 行に Mode、Model、添付、送信または停止 |
| ヘッダー | 戻る、タイトル、新規、設定。実行中はタイトル横の点 |
| Home | 最上段に新規チャット。履歴は名前、実行中だけ状態、時刻の 1 行 |

## この環境で測ったもの

測ったのは AI Agents の Webview である。

| 項目 | 値 | 条件 |
| --- | --- | --- |
| 読み込み先 | リポジトリの `extensions/ai-agents/dist/webview/main.css` | VS Code 1.142.0、使い捨て `user-data-dir` |
| `.bubble` | `width: fit-content`、`max-width: min(34em, 88%)` | 同上。再読み込み後 |
| `.user-row` | `align-items: flex-end` | 同上 |
| 目印 outline | 変更後 `4px rgb(255, 0, 170)`。復元後 `3px rgb(204, 204, 204)` | Host の再読み込み |
| 実 Composer の入力高さ | 34px | 空のチャットに「レイアウト確認」を入れた直後。テーマは Dark Modern |
