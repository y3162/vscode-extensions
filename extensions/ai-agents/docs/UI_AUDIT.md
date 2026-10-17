# 0.10.0 UI監査（2026-10-17）

## 比較範囲

今回の依頼で参照する動画ファイルは監査時に利用できませんでした。以下は依頼文に明記された動作仕様との比較であり、動画を再生して確認したという意味ではありません。以前のUI_GAP_ANALYSIS.mdは0.4.0当時の状態を記録したものです。

| Cursor IDEに求められる動作 | 監査時のHEADにおける拡張機能の状態 |
| --- | --- |
| Agent / Plan / Debug / Multitask / Ask | BackendのCapabilitiesに基づいてモードを表示します。Debug/Multitaskの見せかけのラベルは追加していません。 |
| モデル階層、検索、説明、Fast | WebviewのModelMenuは、最上位のパラメーター操作、階層型モデル選択、別名・検索、説明、Capabilitiesが提供する切り替え項目に対応済みです。狭い幅ではメニューを1階層ずつ表示します。Backendが返さないモデル分類は作りません。 |
| 新規チャットの中央Composer | 新規チャット操作でChatを開き、Composerは下部に固定します。空の状態では上にヒントを表示します。Composerを中央に置く点は未対応です。 |
| 最初の送信後の会話表示 | 現在は最初の送信前にChatへ移動し、送信後は同じ画面の履歴に内容を表示します。 |
| 実行中の進捗と下部Composer | ツール・状態ログと実行状態があり、Stopとキューを利用できます。「次の手順を計画中」という進捗イベントだけでは、拡張機能のPlanを完了扱いにしません。 |
| 新しいAgentエディタータブ | 今回の信頼性改修ではWebviewPanelを追加していません。複数画面で共有するセッション表示は今後の対象です。 |

## DOM回帰テストで再現・修正した問題

- 送信後、入力欄だけが空になり、`setState`には送信前の文章が残っていました。そのためWebviewを作り直すと送信済みプロンプトが復活する可能性がありました。現在は送信・キュー登録・ArrowUpによる再呼び出しの後、Composerが保存コールバックを呼びます。
- 新規または空の会話を表示しても、ArrowUpで呼び出す前回プロンプトがリセットされていませんでした。以前の会話のプロンプトを再利用できてしまうため、空の履歴では明示的に消去します。
- モデルカタログのキャッシュと未完了リクエストIDを、返信時にProviderとworkspaceだけで判定していました。同じProviderとworkspaceのままBackendやセッションを切り替えると、古い選択肢を再利用する可能性がありました。現在は識別情報が変わるとキャッシュを消去し、メニューを閉じ、未完了リクエストIDを無効にします。

変更ファイル: `src/webview/app.ts`、`src/webview/composer.ts`、`test/webview/ui.test.ts`。

下書きは引き続きWebview単位で保持し、履歴を移動しても維持します。今回の変更では、会話ごとの添付ファイルや下書きの永続化は追加していません。

## 検証結果と制限

- `npx tsx --test test/webview/ui.test.ts`: 25/25件成功。上記3つの問題を対象とした新規テスト2件を含みます。Happy DOMによる検証は、実際の画素やレイアウトの目視確認ではありません。
- `npm run test:integration`: インストール済みVS Code Extension Development Hostで成功しました。Webviewのready/probe、SDK subprocessの回答と追加送信、Stop、キュー、履歴とProvider切替、モデル適用、ファイルリンク、ターミナルの接続・解除を検証します。実Providerの推論ではなくfixture用Backendを使用します。
- 任意で有効にできる`AI_AGENTS_GUI_MOCK_HOLD=1 npm run test:integration`を追加しました。破棄可能なfixture用workspaceとprofileを、`ui-done`が作成されるまでネイティブUI確認用に保持します。このモードでは有料推論を起動しません。Extension Hostの検査では、実際のコピー処理を通じて`GUI clipboard 日本語 😀`をOSクリップボードへ書き込み、内容を照合してから元の内容に戻しました。この確認は成功しました（`/private/tmp/ai-agents-gui-audit.log`、`GUI_MOCK_READY`）。
- Native CUA操作では対象のExtension Hostに到達できませんでした。`com.microsoft.VSCode`がインストール済みアプリと`.vscode-test`のアプリバンドルを指す可能性があり、インストール済みアプリのフルパスを選ぶと拡張機能とは無関係な空のVS Codeウィンドウに接続されました。そのウィンドウのWindowメニューには自分自身しか表示されませんでした。テスト用アプリのパスを選んだ場合はタイムアウトしました。GUI検証成功として数えません。
- そのため、ネイティブ操作による送信・コピー・モデル選択・復元と、正確に300px/390pxで表示したDark/Lightテーマの確認は、**今回未検証**です。既存DOMテストでは狭幅メニューやターミナル・Planの構造を確認しますが、実際のはみ出し、コントラスト、ポインター操作は判定できません。無関係なウィンドウのスクリーンショットを拡張機能の証拠として示していません。

Controller/Sidebarの確認応答処理を変更した後に、通常のExtension Host統合テストを再実行して成功しました（終了コード0、`/private/tmp/ai-agents-ui-final-integration.log`）。別のレビューでは、モードやモデルの情報取得を待つ前に対象会話を固定する必要がある非同期Sidebar操作も指摘されました。この指摘は修正と最終検証のため担当者へ共有されました。

Providerの安定化と`setBuildModel`の対象・plan-id・revision確認処理を加えた後の最終テストも、2026-10-17 02:34:01 UTCに成功しました（終了コード0）。モデル情報の取得中に会話が切り替わった場合や、Planが改訂・Buildされた場合、Build用モデル選択メニューは古い取得結果を破棄します。ConfigureとBuildの確認応答処理も独立してレビューされました。対象の固定と画面への反映を遅らせる処理で、報告された会話間競合に対処しています。このfixtureによる統合テストは、ネイティブのポインター操作や実モデルの確認応答を証明するものではありません。


## 最終再監査の追加（2026-10-17）

補完/添付削除のdraft保存通知、失効suggestion、会話切替/busy開始時のmode menu閉鎖を修正。画像only Retryでは元画像のHost返信をidentity/turn/draft照合して復元し、入力変更や別会話の遅延返信を捨てる。DOM30/30成功、追加5回帰を含む。実GUI幅/テーマ・Copy・App Server Plan/Buildの具体的範囲は[VERIFICATION.md](VERIFICATION.md#final-audit)。OS IME、画像paste/Retryの実機確認は未完了。中央Composer/editor追加は対象外。

追加実GUIの最新範囲: 4経路で新規/継続finalを表示。CursorSDKはStop→同会話再送、AppServerは2子結果と手動Reload/履歴復元、ACPはAskへの切替も確認。ただしACPの2回答目はBackend自体が要求TWOへTHREEを返したため、要求語一致の合格とはしない。Backend原文/表示の一致は直接session/loadで確認した。
