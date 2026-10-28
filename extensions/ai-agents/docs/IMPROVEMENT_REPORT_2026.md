# 差分改善の結果（2026-10-28）

判定は、この差分について **GO**。実バックエンドへの推論は未実施であり、その未実施を不合格の理由にはしない。以前の v1 判定文書は上書きしない。

## 開始時の Git

ブランチ `main`、HEAD `4aa333f`（CLIだけに限定）。作業開始時から `extensions/ai-agents` に未コミットの変更があった。戻していない。commit、push、release はしていない。

## 変えたこと

実行方式は CLI のまま。`sdk` は拒否されたまま。ACP と App Server のアダプタは残している。

- ユーザーメッセージは薄い面、回答は地の文。通常テーマでは吹き出しの枠を外し、High Contrast では枠を戻す
- 幅 300px で操作を折り返し、600px 以上で余白を広げる
- ツール行に実行中 / 完了 / 失敗の文字を出す
- Build できない計画は、無効なボタンに理由を出す
- 画像を受け取れない実行方式では、画像の添付項目を無効にして理由を出す。ファイル添付は残す
- 安全な分岐ができない編集は「入力に戻す」。Codex の checkpoint があるときだけ「再送信」で分岐する
- 表示専用の履歴を `history/v1/conversations` に書く。モデルには送らない。`ai-agents.history.enabled` がオフなら書かない
- 再開でバックエンド本文が取れたときは、その本文を使う。取れず失敗でもないときだけ、表示スナップショットを出す。実行中だったターンは unknown のまま
- バックエンドのセッション ID が無い表示履歴は、再開せず表示だけにする
- `ready` / `implemented`、および中断中の計画を `ai-agents.plans` に書く。バックエンドの transcript が計画を持たないときだけ戻す。中断フェーズは `restorePlan` により Build できない

調査は [CURSOR_REFERENCE_2026.md](CURSOR_REFERENCE_2026.md)、レイアウトは [UI_DELTA_2026.md](UI_DELTA_2026.md)。

## テスト

| 実行 | 結果 |
| --- | --- |
| `npm run check` | 成功 |
| `npm test` | 822 成功、失敗 0。macOS、サンドボックス外。サンドボックス内の初回はソケットと `git init` の EPERM で失敗し、同じスイートを外で再実行して成功 |
| `npm run test:hygiene` | 成功（4269 files） |
| `npm run test:integration` | 成功。VS Code 1.143.1、darwin arm64、隔離プロファイル、mock。`INTEGRATION_ASSERTIONS_PASS` |
| `npm run test:ui` | 成功。幅 300 / 390 / 520 / 600、Dark / Light / HC、日英、22 シーン。528 枚。レイアウト検出 0。ブラウザ操作 22 成功。画像は `extensions/ai-agents/docs/evidence/ui-redesign/after`（Git 対象外）。Host は mock |
| Coverage | この回では未実行 |
| Live 推論 | 未実施 |

表示履歴のテストは、スナップショットの本文がセッションの `run` に渡らないこと、バックエンド本文がある再開ではローカル本文を重ねないこと、セッション ID が無い履歴はプロセスを開かないことを確認した。

GUI の自動検出は、指定した要素がフレームの外に出ていないことである。全ピクセルの目視や、実 OS の IME、実テーマの全種類ではない。

## モデル

Cursor CLI `agent --list-models` のカタログに `composer-2.5` はあった。`GPT-6 Luna` という ID は無かった。近い名前の `gpt-5.6-luna-*` は Cursor のカタログ項目であり、Codex の実行結果ではない。Codex のカタログは問い合わせておらず、別モデルへ切り替えて成功扱いにしていない。

## 残課題

- ローカル Cursor の画面は計測していない。クラス名は Cursor 2.6.22 のバンドルと CursorRemote の抽出コードで確認した
- 表示スナップショットとバックエンド transcript の ID が違うとき、ローカルだけのツール行は合流しない
- Codex CLI は Plan、対話承認、サブエージェント追跡が無い。Cursor CLI は画像、Usage、対話承認が無い。UI は Capability に合わせている
- Cursor に `thread/fork` は無い。ファイルを戻す代替の Rewind は実装していない
- Home は全セッションを出す。Terminal の入口はヘッダーと Composer の両方にある
- 実プロバイダでの Plan、承認、画像、Reload は未実施
- SDK セッションは復活させていない

## 判定

この差分は GO。チェック、unit、integration、GUI の自動検出が成功し、表示履歴はモデルへ再送されず、画像非対応は操作として有効に見せない。Live 推論は未実施。
