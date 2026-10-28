# インストール・更新・復旧

現在の1.0.0ローカルVSIXは受入途中です。正式公開の判定はNO-GOです。

## 導入

確認対象はmacOS arm64、VS Code 1.142.0です。manifestのminimum engineは1.109.0です。
Nodeを使うCLI実行要件は22.13以上です。同梱CLIのarchitectureとVSIX targetを一致させます。
Cursorでの最終VSIX受入は未完了です。publisher/nameは`y3162.ai-agents`です。

受入完了後、VS CodeのExtensionsメニューからInstall from VSIXを選び、
`ai-agents-1.0.0-darwin-arm64.vsix`を指定します。SHA256SUMSとの一致を確認してください。
Reload後に拡張のID・version・インストール先を確認します。
Codexは許可済みのCLI認証を使い、CursorはCursorの認証を使います。

## 0.10.0からの更新

1. 実行中の処理を完了させるか、明示Stopして終了を確認します。
2. エディターを閉じ、対象profileのAI Agents globalStorageとworkspaceStorageをローカルへバックアップします。
   会話本文・tool出力が含まれるため、共有場所には置かないでください。認証ファイルをバックアップに含める必要はありません。
3. VSIXから1.0.0をインストールし、履歴・Session・下書き・Usage・有効Plan版と完了状態を確認します。
4. UnknownのPlanはBuildしません。実行所有者や元Turnを確認できない場合に再送で解決しないでください。

隔離した0.10.0実VSIXからの更新で、会話・Session・Plan ID/版・Usageと日本語を含む下書きの保持を確認しました。
更新前storageバックアップを戻しての1.0.0再試行も確認しました。すべての旧保存状態の互換性を保証する試験ではありません。

## 失敗時の再試行と復旧

ログと表示状態を保存し、実行が継続しているか確認します。通信失敗だけで同じpromptを再送しないでください。
接続先が確認できない場合はUnknownを維持し、重複送信を避けます。
移行失敗時はエディターを閉じ、現在のstorageも別名で退避してから、バックアップを対象profileへ戻して再試行します。
storage全消去を通常の復旧手順にしません。
旧版へ戻す場合は実行を停止し、旧VSIXと更新前バックアップを組み合わせます。
1.0.0で保存した状態を0.10.0が完全に読み戻せることは未確認です。

## 公開担当者向け

受入表の必須項目がすべてPASSで、receiptと最終VSIXのSHA-256が一致した場合だけ公開してください。
この作業では公開、Draft Release、Git stage/commit/tag/pushを行う手順を自動実行しません。
公開直前に同一版の衝突を再確認し、手動でGit記録と配布先への公開を行います。
