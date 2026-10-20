# Backendと検証範囲

| Backend | 接続 | Plan/モデル | Reload実行継続 |
|---|---|---|---|
| Codex App Server | 同梱Codex CLI 0.162.1、既存CLI認証 | Planはread-only、明示Build時に設定した権限へ戻す。モデル/Effortを次Turnへ反映 | macOS arm64の隔離VSIXで通常Turn・Plan生成・BuildのGUI Reload継続を確認。OS再起動や所有プロセス自体の喪失は対象外 |
| Codex SDK | 公式SDK 0.162.1 | モデル変更に新しいSessionが必要 | 未受入。App Serverの成功を適用しない |
| Cursor SDK（Cursor既定） | 公式SDK 1.0.37 | カタログが示すモデル/詳細設定を次送信へ反映 | 未受入 |
| Cursor ACP | local Cursor CLI | カタログ/設定・モードの対応範囲はSDKと異なる | 未受入 |

Codexの指定試験モデルは`gpt-6-luna`です。別モデルやAPIキー課金へ自動的に代替しません。
Cursor Composer 2.5の現在のカタログID確認は受入記録を参照してください。CLIとSDKのカタログ・認証は区別します。
CLIの現在の実IDは`composer-2.5`です。隔離CLI認証でACP送信・履歴再開・Stopを確認しました。SDKの認証・カタログ成功へ流用しません。
Cursor SDK 1.0.37の標準ログインは期限付きAPIキーを発行・保存します。CLIのサブスクリプション認証と同じ経路ではありません。
APIキーを許可しない受入条件では、CLIログイン成功をSDK実行成功として扱いません。
Subagentは実Backendの通知を観測して表示します。表示目的で拡張から子Agentを作成しません。
Terminal操作はBackendのprocess IDへ送り、コマンドを再実行して再接続を装いません。
Usageは入出力/cached/累計を区別します。Context内訳やTo-doはBackendが返した値だけを表示します。
実Backendが値を提供するかどうかの確認と、表示の受入には残項目があります。

## 管理プロセス

profile・workspace・会話ごとにローカルUnix socketで接続し、ユーザー専用権限とランダムtokenで保護します。
ReloadではUI接続だけを切ります。Stopは元の実行を中断します。
UIが再接続しない状態が10分続くと、所有する実行を中断し、プロセスと管理ファイルを回収します。
OS再起動、管理プロセス自体の終了、保持上限16 MB超過まで継続を保証するものではありません。
