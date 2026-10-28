# UI レイアウト再設計の結果（2026-10-28）

既存の 2026 報告書は残してある。Commit、Push、Release はしていない。CLI の実行経路は変えていない。

## 実装

Webview の中だけを変えた。

- [transcript.ts](../src/webview/transcript.ts): ターンを `.user-row` と `.assistant` に分ける。完了してログを閉じている間、失敗したツールの理由を `.tool-failures` に出す。閉じたツール行にも失敗理由を残す。
- [styles.css](../src/webview/styles.css): 発話は `fit-content` で末尾寄せ、最大 `min(34em, 88%)`。回答は地の文。入力の最小高さは約 2 行。300px では Composer を折り返さず、モデル名を省略する。
- [header.ts](../src/webview/header.ts): チャットヘッダーは戻る、タイトル、新規、設定。実行中だけタイトル横に presence。ターミナルは Composer 上の一覧だけ。
- [plan-view.ts](../src/webview/plan-view.ts): View Plan は副ボタン、Build は主ボタンで右のグループ。完成できない計画は `.is-blocked`。エラーはカードの先頭。
- [history.ts](../src/webview/history.ts) の DOM は維持し、CSS で新規チャットを列幅の主操作、履歴を 1 行にした。

## 実 GUI

VS Code 1.142.0。ウィンドウタイトルは `[Extension Development Host] workspace`。プロファイルは `/private/tmp/ai-agents-layout-verify/user-data`。通常の Cursor / VS Code プロファイルは使っていない。

- Home: 幅いっぱいの New chat、空の履歴。`docs/ui-layout-2026/vscode-host-home.png`
- Chat: 戻る、タイトル、新規、設定。入力に「レイアウト確認」。高さ 34px。環境表示はカードの下。`docs/ui-layout-2026/vscode-host-chat.png`
- 読み込みと computed style、目印の反映と復元は [UI_LAYOUT_CAUSE_2026.md](UI_LAYOUT_CAUSE_2026.md)
- 右側の「Build with Agent」は VS Code 本体のチャットであり、この拡張ではない

ブラウザ fixture だけの確認とは分けてある。実モデル推論はしていない。

## 自動検証

本番バンドルを Chrome の使い捨てプロファイルで描画した。

| 実行 | 結果 |
| --- | --- |
| 代表 Before | 8 画面 × 300 / 390 / 600、Dark、日本語。`docs/ui-layout-2026/before` |
| 代表 After | 同じ条件。`docs/ui-layout-2026/after` |
| 全組合せ | 22 画面 × 300 / 390 / 520 / 600 × Dark / Light / High Contrast × 日本語 / 英語 = 528。はみ出しとコントラストの所見 0。ブラウザ操作 22 件成功 |
| `npm test`（`extensions/ai-agents`） | 823 件成功 |
| `npm run check` | 成功 |
| `npm run test:hygiene` | 成功 |

528 枚の出力は `extensions/ai-agents/docs/evidence/ui-layout-2026/matrix`。このディレクトリは Git 管理外である。再生成はリポジトリルートで次のとおり。

```sh
UI_CAPTURE_OUTPUT="$PWD/extensions/ai-agents/docs/evidence/ui-layout-2026/matrix" \
UI_CAPTURE_WIDTHS=300,390,520,600 \
UI_CAPTURE_THEMES=dark,light,hc \
UI_CAPTURE_LANGUAGES=ja,en \
UI_CAPTURE_SHEETS=0 \
node extensions/ai-agents/scripts/capture-ui.mjs
```

はみ出し 0 は必要条件であり、改善の根拠にはしていない。根拠は Before と After の配置の差と、実 Host の computed style である。

## 残課題

- Cursor IDE のサイドバーは未計測。忠実度は未検証。
- ログを開いたシェルは、コマンド行を展開前から見せる。
- 発話のコピーは別ボタンにしていない。編集は発話のクリック。
- 実推論、実 IME、スクリーンリーダーは未実施。
- 開いているサイドバーは、Host を再読み込みするまで新しい CSS を取りにいかない。

## 判定

GO。

本番 Webview の発話、作業ログ、ヘッダー、Composer、Plan、Home の配置が Before と違って見え、実 VS Code の Extension Development Host がこのリポジトリの `dist/webview/main.css` を読み、幅とテーマの自動検出と回帰テストが通った。Cursor への忠実度は検証済みとしない。
