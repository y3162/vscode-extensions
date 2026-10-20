# AI Agents 1.0.0

リリース準備中。必須受入が残っているため、現在のローカル成果物は **NO-GO / 公開不可** です。

0.10.0からの変更:

- 計画カードを折りたたみ、View Planで同じサイドバー内に本文と生成元を表示します。
- Planは生成・改訂後に停止し、Buildを明示的に押したときだけ実装します。完了済み計画や状態不明の計画を再Buildしません。
- macOSのCodex App Server実行を管理プロセスへ分離しました。隔離したインストール済みVSIXで、通常Turn・Plan生成・Buildの実行中GUI Reloadから同じプロセス・Session・Turnの完了を確認しました。他の必須受入は残っています。
- 接続先を確認できない実行はUnknownとし、Buildを無効にします。復帰のためのprompt自動再送はしません。
- 画像Retryは失敗した入力をComposerへ戻します。内容を確認してSendを押すまで送信しません。
- 会話・Session・Planの対応、下書き、モデル設定、Usageと履歴の保持を修正しました。
- Codex App Serverの親本文・コマンド出力のストリームを、存在しない子Agentへ割り当てる不具合を修正しました。

確認対象はmacOS arm64です。他OS/architectureの出荷確認はしていません。
Backendごとの能力と受入範囲は[対応表](BACKENDS.md)、導入・復旧は[手順](INSTALL.md)を参照してください。
