# 0.10.0 UI audit (2026-10-17)

## Comparison scope

The current task's video binary was not available to the audit agent. The comparison below uses the behavior explicitly described in the request, not a claim that the video was replayed. Earlier UI_GAP_ANALYSIS.md describes 0.4.0 and is historical evidence.

| Requested Cursor IDE behavior | Current extension at audit HEAD |
| --- | --- |
| Agent / Plan / Debug / Multitask / Ask | Backend capability-driven modes; no cosmetic Debug/Multitask labels added. |
| Model hierarchy, search, descriptions, Fast | Webview ModelMenu already supports root parameter controls, nested model selection, aliases/search, descriptions and capability-provided toggles. Narrow widths drill into one menu. Model categories not supplied by backend are not invented. |
| Central new-chat Composer | New-chat action opens chat; Composer stays in bottom dock with empty-state hint above. Central placement remains a UI gap. |
| First-send transition to conversation | Current new-chat action enters chat before first send; sending populates transcript in the same view. |
| Running progress / bottom Composer | Tool/status logs and running state exist, Stop and queue are available. “Planning next moves” is a progress event, not sufficient to complete an extension Plan. |
| New Agent editor tab | No WebviewPanel added in this reliability pass. Shared-session editor surface remains follow-up scope. |

## Fixed and reproduced with DOM regression tests

- A sent draft was cleared only in the textarea. `setState` still contained the pre-send text, so recreating the Webview could resurrect an already submitted prompt. Composer now notifies the persistence callback after send/queue and ArrowUp recall.
- Empty/new conversation rendering never reset the prior prompt used by ArrowUp. The prior conversation's prompt could be recalled. Empty history now explicitly clears it.
- Model catalog cache and outstanding request IDs were scoped only by provider/workspace when receiving a reply. A backend/session switch with the same provider and workspace could reuse stale options. Identity changes now clear the cache, close the menu and invalidate outstanding request IDs.

Files: `src/webview/app.ts`, `src/webview/composer.ts`, `test/webview/ui.test.ts`.

The existing draft is still Webview-scoped (preserved when navigating history); this pass does not introduce per-conversation attachment/draft persistence.

## Verification evidence and limits

- `npx tsx --test test/webview/ui.test.ts`: 25/25 pass, including the two new tests covering the three defects above. Happy DOM assertions are not visual pixel/layout verification.
- `npm run test:integration`: pass in the installed VS Code Extension Development Host. The suite verifies Webview ready/probe, SDK subprocess answers/follow-up, Stop, queue, history/provider switch, model application, file links and terminal attach/detach. These use fixture backends, not live provider inference.
- Added opt-in `AI_AGENTS_GUI_MOCK_HOLD=1 npm run test:integration`: disposable fixture workspace and profile are held for native UI review until `ui-done` is created. This mode launches no paid inference. An Extension Host assertion writes `GUI clipboard 日本語 😀` through the real copy handler, verifies the OS clipboard, and restores its previous content. This passed (`/private/tmp/ai-agents-gui-audit.log`, `GUI_MOCK_READY`).
- Native CUA attempt did not reach the held Extension Host: `com.microsoft.VSCode` was ambiguous between installed and `.vscode-test` app bundles; selecting the installed full path bound an unrelated empty VS Code window, whose Window menu exposed only itself. Selecting the test app path timed out. Do not count this as successful GUI verification.
- Therefore native click-driven send/copy/model/restore and exact 300px/390px Dark/Light checks remain **unverified in this pass**. Existing DOM tests contain narrow-width menu and terminal/Plan structural assertions but cannot establish real clipping, contrast or pointer behavior. No screenshots of the unrelated window are presented as extension evidence.

Final normal Extension Host rerun after the controller/sidebar acknowledgment changes: pass, exit 0 (`/private/tmp/ai-agents-ui-final-integration.log`). Independent review additionally flagged asynchronous sidebar operations that must capture the target conversation before awaiting mode/model discovery; this finding was forwarded to the lead for fixes and final validation.

The final rerun after provider stabilization and the `setBuildModel` target/plan-id/revision guard also passed, exit 0 at 2026-10-17 02:34:01 UTC. The Build model picker now discards discovery results if the user changed conversations or the plan was revised/built while discovery was pending. Configure and Build acknowledgment handling was independently reviewed; target capture and deferred publication address the reported cross-conversation races. This fixture integration does not prove native pointer behavior or live model acknowledgment.


## 最終再監査の追加（2026-10-17）

補完/添付削除のdraft保存通知、失効suggestion、会話切替/busy開始時のmode menu閉鎖を修正。画像only Retryでは元画像のHost返信をidentity/turn/draft照合して復元し、入力変更や別会話の遅延返信を捨てる。DOM30/30成功、追加5回帰を含む。実GUI幅/テーマ・Copy・App Server Plan/Buildの具体的範囲は[VERIFICATION.md](VERIFICATION.md#final-audit)。OS IME、画像paste/Retryの実機確認は未完了。中央Composer/editor追加は対象外。

追加実GUIの最新範囲: 4経路で新規/継続finalを表示。CursorSDKはStop→同会話再送、AppServerは2子結果と手動Reload/履歴復元、ACPはAskへの切替も確認。ただしACPの2回答目はBackend自体が要求TWOへTHREEを返したため、要求語一致の合格とはしない。Backend原文/表示の一致は直接session/loadで確認した。
