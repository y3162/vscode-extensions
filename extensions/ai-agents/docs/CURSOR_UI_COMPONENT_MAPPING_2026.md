# Cursor → AI Agents コンポーネント対応

根拠の位置と確認範囲は [source analysis](CURSOR_UI_SOURCE_ANALYSIS_2026.md) と [components.json](cursor-ui-analysis/source/components.json)。

| Cursor UI | AI Agents | 判定 |
| --- | --- | --- |
| Human / assistant | `src/webview/transcript.ts`, `styles.css` | 全幅カード・枠なし回答は一致。テーマ背景は意図的に VS Code に従う |
| Thinking / Activity | `turns.ts`, `transcript.ts`, `strings.ts` | UI状態を各思考・ツールに対応させる修正。集約は read/search・連続 shell/edit を使う独立設計、Cursor の全 tool 分類は未再現 |
| Tool / Terminal | `transcript.ts`, `subagents.ts` | 展開可能な詳細、8em 上限。Cursor の展開画面未実測 |
| Composer / mode / model | `composer.ts`, `styles.css` | 28px行、12px枠は既存実測に対応。Agent / Plan / Ask と capability は保持 |
| File Review | `review-acceptance.ts`, `change-review.ts`, `sidebar.ts`, `protocol.ts`, `composer.ts` | 未受け入れと受け入れの表示を保持。受け入れは Git 操作でない。Cursor 内部履歴と同一と主張しない |
| Plan / Approval | `plan-view.ts`, `cards.ts` | 別エディタでなく Webview 内。テーマボタンと既存 approval を保持。Build の Cursor 内部条件は未確定 |
| Usage | `composer.ts`, `usage.ts` | 使用可能なプロトコル値のみ表示。Cursor の詳細カテゴリを創作しない |

レビュー一括Undoは保存された before / after digest、dirty editor、workspace 境界、realpath、symlink 等を検査し、不明な場合は無効化する。複数ファイル操作は部分失敗を報告するが、外部書き換えとの完全な原子性は保証できない。Cursor内部APIへの依存はない。
