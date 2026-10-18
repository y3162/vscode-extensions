# 2026-10-18 実測追補

現在のbounded live runでは、Codex App Serverの親Wait通知`[true,false,true,false]`と別thread IDを持つ子2件の約9.4秒の実行重複を確認しました。Cursor ACPでも別task/tool IDの2件がCompletedとなり、公開区間とshell marker時刻が約6秒重複しました（`composer-2.5-fast`）。これはその回の実測であり、過去の約200秒timeoutが再現しないことや全てのプロンプトで並列実行されることの保証ではありません。

Cursor ACPアダプターはBackendが実際に提供した`rawOutput` / result本文がある場合に限り、秘密情報をマスクして最大500文字のresult previewを保持します。公開子履歴ストリームを新設したものではなく、Backendが返さない内容は表示しません。遅延したrunning通知でCompleted/Error/Cancelledを戻さない単調な終端状態回帰も追加しました。

Extension Development HostのDark・約300px実GUIでは親Waitingと子2行、子A詳細、親への復帰を操作しました。子Bの結果詳細をGUIで確認できず、幅/テーマ全組合せ・draft・正確なscroll・IMEなどの受入は未完了です。DOM/Hostテストは実GUIの証拠とは区別します。詳細な結果は[VERIFICATION.md](VERIFICATION.md)を参照してください。

# サブエージェントの状態とサイドバー詳細

Chatビューでは、子エージェントを既存のサイドバー内に表示します。折りたたみ式パネルはComposerのすぐ上に配置します。表示中の会話だけを対象とし、Backend IDで記録を重複排除します。展開状態と行一覧のスクロール位置を保ち、実行中の子、または同じ親ターンに実行中の子がいる子だけを一覧に表示します。そのターンの子がすべて終了すると、要約は会話履歴に残り、そこから子の詳細を開けます。

行を開くと、同じサイドバー内で親の履歴領域が子の詳細画面に切り替わります。「戻る」操作では、既存の履歴DOM、スクロール位置、Composerの下書きを復元します。子の詳細を開いている間も拡張機能は更新を受信し続けます。画面には選択したBackendが提供した項目とイベントだけを表示します。取得できない思考内容、モデル名、ツール履歴、経過時間は作りません。

## 親の待機状態

親の待機状態は子の状態とは独立しています。子が実行中または不明というだけでは、親を待機状態にしません。現在のApp Serverアダプターは、ツールが`wait`であることを明示する`collabAgentToolCall`を受信し、対応するitemイベントから呼び出し中と確認できる間だけ、ローカライズされた`Waiting for subagent(s)`状態を出します。対応する完了・更新イベントで待機状態を解除します。親ターンの完了、Stop、復元、古いターンの表示時にも解除します。待機通知だけで子を完了扱いにはしません。

現在、ほかのBackendは親が子の結果を待っていると証明する独立した信頼できるイベントを公開していません。そのため、親の状態にはBackendが返すRunning、Thinking、ツール実行状態をそのまま表示します。

## Backend別の対応状況

| バックエンド | 子の検出とID | タスク・モデル・状態 | 子の履歴 | 親の待機を示す情報 | 子のStop |
| --- | --- | --- | --- | --- | --- |
| Cursor SDK | 公開`task`ツールイベント。ツール呼び出しIDで識別 | 返却された場合はタスク説明・プロンプト、backgroundフラグ、状態、所要時間、結果の末尾 | このアダプターは個別に参照できる子threadやイベントストリームを公開しない | 公開されていない | 公開されていない |
| Cursor ACP | 公開`cursor/task`通知または要求。`toolCallId`で識別し、提供時は`agentId`も保持 | 提供されたプロンプト、役割、モデル、backgroundフラグ、タスク状態、所要時間。現在のアダプターは子の最終結果を保持しない | このアダプターは公開された子の履歴ストリームを持たない | 親の待機を示す個別イベントは公開されていない | 公開されていない |
| Codex SDK | 公開`task`ツール呼び出し項目。呼び出しIDで識別 | 返却されたプロンプト・説明、役割、backgroundフラグ、状態、所要時間、`resultSuffix` | このSDKイベントストリームは、ここでは独立した子threadを公開しない | 公開されていない | 公開されていない |
| Codex App Server | `subAgentActivity` / `collabAgentToolCall`と子thread ID | 通知されたタスク、役割、モデル、親Backendターン、子ターンの状態、結果、エラー | 子thread IDで子の通知を関連付ける。`thread/turns/list`から取得可能な子のツール、思考、ファイル、回答イベントを再読み込みする | 明示的に実行中の`wait`ツール項目のみ | 公開されていない |

Status `Unknown` is preserved when the backend cannot confirm a terminal state. Parent completion and Stop do not change a child to Completed or Cancelled. A child thread that keeps running after parent Stop remains visible as running/unknown and blocks safe turn rewind. Stop is a request; the terminal status changes only after the backend reports it.

ライブ検証では、確認した子thread IDとturn IDを指定してApp Serverの`turn/interrupt`を要求しました。しかし、その実行では子の状態が`Cancelled`ではなく`Completed`と報告されました。IDを指定できるだけでは、対象の子だけを停止できるとは確認できません。未検証の操作を提供しないため、現在はどのBackendでも子用Stopボタンを表示しません。親のStopは引き続き親ターンだけを対象にします。

## 子イベントの保存

子メッセージには子IDを付け、親のAssistant回答とは分けて保存します。実行中・復元後の子のテキストは秘密情報をマスクし、イベントごとに長さを制限します。ローカル履歴の上限は子ごとに80メッセージまたは160 KB、子ログ全体で1 MBです。上限を超えて履歴を削った場合は、詳細画面に古い履歴を省略したことを表示します。大きすぎるmetadataは破棄し、省略したことを記録します。子のタスク、進捗、結果、エラー、ツール対象も長さを制限して秘密情報をマスクします。この履歴は表示専用で、モデルへの入力には使いません。

App Serverでは復元時に親の保存済みthread履歴から子を再検出し、取得可能な子ターンを要求します。Backendから子の履歴を再取得できない場合は、既知のタスクと結果を表示し、詳細履歴を取得できないことを伝えます。Cursor ACP、Cursor SDK、Codex SDKでは、復元時に存在しない子の履歴を作りません。

## 検証

決定的なテストでは、親の明示的な待機状態の遷移、並列子ID、子専用イベントの振り分け、子の完了・失敗・キャンセル・不明状態、通知の重複や順序入れ替わり、App Server復元、履歴の上限と秘匿情報のマスク、親ターンの巻き戻し制限、子単位の停止が未確認の場合にStopを隠すこと、一覧の折りたたみと重複排除、親と詳細画面の移動、Composer下書きと親のスクロール位置の保持を検証します。プロトコルfixtureは合成イベントです。ライブBackendとGUIの結果および制限は[VERIFICATION.md](VERIFICATION.md)を参照してください。
# 2026-10-18 実測追補

現在のbounded live runでは、Codex App Serverの親Wait通知`[true,false,true,false]`と別thread IDを持つ子2件の約9.4秒の実行重複を確認しました。Cursor ACPでも別task/tool IDの2件がCompletedとなり、公開区間とshell marker時刻が約6秒重複しました（`composer-2.5-fast`）。これはその回の実測であり、過去の約200秒timeoutが再現しないことや全てのプロンプトで並列実行されることの保証ではありません。

Cursor ACPアダプターはBackendが実際に提供した`rawOutput` / result本文がある場合に限り、秘密情報をマスクして最大500文字のresult previewを保持します。公開子履歴ストリームを新設したものではなく、Backendが返さない内容は表示しません。遅延したrunning通知でCompleted/Error/Cancelledを戻さない単調な終端状態回帰も追加しました。

Extension Development HostのDark・約300px実GUIでは親Waitingと子2行、子A詳細、親への復帰を操作しました。子Bの結果詳細をGUIで確認できず、幅/テーマ全組合せ・draft・正確なscroll・IMEなどの受入は未完了です。DOM/Hostテストは実GUIの証拠とは区別します。詳細な結果は[VERIFICATION.md](VERIFICATION.md)を参照してください。

# サブエージェント表示と状態管理
