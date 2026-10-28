# 実行方式

| エージェント | 会話の実行 | 補助機能 |
| --- | --- | --- |
| Codex | `codex exec --json` | 同梱 CLI の App Server でモデル一覧と履歴・分岐を確認 |
| Cursor | `agent --print --output-format stream-json` | `agent --list-models` でモデル一覧を取得 |

ユーザーが実行方式を選択する必要はありません。CLI の能力が公開しない操作は利用できません。Codex CLI は対話承認を受け取れず、Cursor CLI の print モードは画像添付と使用量の報告に対応していません。

以前の検証記録は当時の実行方式を記録したものです。現在の CLI 経路での成功を意味しません。
