# Provider audit — 0.10.0, 2026-10-17

## Reproduced failure and fix

Cursor ACP emits `agent_message_chunk` as strict text deltas. The installed CLI's ACP adapter maps its `textDelta` event directly to this notification. Session replay uses the same notification for complete stored assistant steps. The extension previously applied an ambiguous delta/snapshot heuristic: if the previous accumulated text ended with an incoming string, that string was discarded. A final answer identical to text before a tool therefore disappeared; legitimate repeated token chunks also disappeared. This is reproducible on HEAD without inference.

The regression fixture emits `done`, a tool boundary, `done`, ` done`, ` done`. Before the fix the assistant messages were `done` and ` done`; after the fix they are `done` and `done done done`, on all three turns. ACP now uses strict concatenation, while the SDK keeps its existing mixed snapshot handling. Successful `session/prompt` completion marks the last assistant segment final. Replay marks each turn's last assistant final and retains separate IDs across tool boundaries and restored turns. ACP thought chunks also use strict concatenation.

A rejected per-turn mode change previously occurred before the `try/finally`, retaining the live update callback. It now releases that callback; a regression sends an idle notification after failure and verifies it goes to replay instead of the failed turn.

Cursor worker model changes previously returned immediately and discarded IPC errors. Both client and worker now await the model operation. The fake-worker test holds acknowledgment, verifies the returned promise is pending, sends a provider error and verifies rejection, then verifies recovery with a successful acknowledgment. Controller state rollback is covered separately.

## Actual Cursor ACP capability probe

Executable: `/Users/sekiyuuta/.local/bin/agent`, resolving to CLI `2026.06.26-7079533`.

A real local stdio JSON-RPC process was initialized and authenticated. No model inference was used for these capability probes.

- `session/new` advertises exactly `agent`, `plan`, `ask` in `modes.availableModes`; all three `session/set_mode` operations succeeded.
- ACP `debug` and `multitask` mode changes returned errors. This finding applies to this ACP interface; it does not claim that Cursor IDE or interactive CLI slash commands lack Debug.
- Startup `--model composer-2.5` resolves to advertised model ID `composer-2.5[fast=true]`, advertised name `composer-2.5`.
- Plain `session/set_model` model ID `composer-2.5` returned `Invalid params`. Canonical `default[]` and `composer-2.5[fast=true]` succeeded; `composer-2.5[fast=false]` returned `Invalid params`.
- `session/set_config_option` with `configId: model` changed Auto → Composer. Returned `configOptions` confirmed `currentValue: default[]` and then `currentValue: composer-2.5[fast=true]`. Fast false was rejected.

ACP runtime model changes now resolve only against that session's advertised IDs/names, require each explicitly requested parameter to match an advertised canonical variant, await `session/set_config_option`, and require the returned current value to match. Unknown models, unadvertised parameter combinations, backend errors, and missing acknowledgment reject the operation. No fallback to a different model variant occurs. Initial model parameters are also validated and applied; a requested model is reconciled with the actual advertised state after resume. A backend rejection or missing/mismatched acknowledgment closes the connection before another turn can be sent; retry resumes the same session through a fresh connection. The static capability describes the supported operation; availability is validated per session. Older CLIs without advertised model variants reject runtime changes without a UI-only success. Startup `--model` remains distinct from an acknowledged runtime change.

## Live inference evidence

A separate live test used Composer 2.5, ACP Ask mode, a temporary isolated workspace, and denied all permission requests. It created one session, submitted three short prompts, disposed it, loaded the same session ID, and inspected the replay.

| Check | Result |
| --- | --- |
| Turn 1 answer | `AUDIT_TURN_1`, `final: true` |
| Turn 2 answer | `AUDIT_TURN_2`, `final: true` |
| Turn 3 answer | `AUDIT_TURN_3`, `final: true` |
| Restored answers | All three present with `final: true` |
| Restored turn IDs | Three distinct backend turn IDs |

Raw extension update evidence from this run is available at `/private/tmp/ai-agents-acp-live-evidence.json`. This is provider execution evidence, not human GUI evidence. The exact pathological repeated-final sequence is proven by deterministic protocol replay, rather than claimed to have been induced from a live model.

## Tests and limits

- Focused Cursor SDK, stream-text, and provider protocol tests passed (21 tests before the final added regressions).
- Expanded worker-client, protocol, and model-settings suite passed (23 tests before the callback-release regression was added).
- Seven final focused ACP regressions passed: repeated live deltas, replay final answers, canonical model acknowledgment, callback release after mode rejection, closed connection after provider rejection, closed connection after missing acknowledgment, and requested-model validation after resume.
- The broader Cursor SDK, worker-client, protocol, model-settings and stream-text suite passed (30 tests before the three final safety regressions).
- Type checking passed after final provider changes.
- Existing Cursor SDK snapshot-collapse regression remains passing.

This provider task does not independently establish GUI clipboard operation, all four backend Stop/Retry flows, Plan file-write isolation, or child/terminal runtime behavior; those checks belong to the overall audit. ACP token usage remains unavailable rather than estimated. Runtime model validation uses the installed CLI's advertised variant list; it does not make an unsupported Fast variant available merely because the SDK model catalog includes that parameter.


## App Server Plan sandbox guarantee

Final review identified a material gap: collaboration Plan instructions alone did not enforce the extension's no-write-before-Build rule. Bundled 0.162.1's generated `v2/TurnStartParams.json` explicitly says both `sandboxPolicy` and `approvalPolicy` override this turn **and subsequent turns**. Every Plan turn now explicitly sends `sandboxPolicy: { type: readOnly, networkAccess: false }` and `approvalPolicy: never`. Every Agent/Build turn explicitly restores the exact sandbox policy and approval policy returned by thread start/resume, including writable roots, network access, and temporary-directory exclusions. This prevents read-only Plan settings from persisting into Build. Older responses without a policy use the existing configured sandbox and roots as a fallback.

Three deterministic tests exercise Plan → Agent → Plan → Agent for workspace-write, read-only, and full-access configurations. They assert Plan's restriction and exact restoration of the configured policy, including response-only temporary-directory exclusions. All 24 provider protocol tests passed; type checking passed.

A focused real GPT-6-Luna test used one App Server session (`01a147b8-9098-7f62-94c4-2c7a597ed373`) and an isolated temporary workspace:

1. Plan prompt explicitly requested `printf forbidden > forbidden.txt` before planning an edit. `forbidden.txt` remained absent and `note.txt` stayed `alpha\n`.
2. A second Plan prompt revised the target to `gamma`. The original file remained unchanged and a plan event was returned.
3. Agent/Build in the same session changed `note.txt` to exactly `gamma\n`; the forbidden file remained absent.

Raw extension updates are stored in `/private/tmp/ai-agents-codex-plan-sandbox-evidence.json`. The backend/model reported that the forbidden write was rejected; the independent filesystem assertion establishes no file was created. This report does not elevate model narration to raw tool execution evidence. The equivalent repeatable opt-in regression is now included in `test/live/tools.test.ts` under the name `codex-app-server: Plan denies requested writes and Build restores workspace access in the same session`.

Final root verification: the checked-in opt-in live test `Plan denies requested writes and Build restores workspace access in the same session` also passed (1/1, 2026-10-17). Both Plan turns retained `alpha\n`, the forbidden file was absent, and Agent/Build wrote `gamma\n` in the same session. Final unit suite 144/144 and Extension Host integration passed.


## 最終再監査の追加

ACP再開時のAgent mode再適用、App Server公開履歴final_answer保持、背景process ID判明前のbuffer/itemId結合を追加修正。いずれも修正前にfixture失敗を確認。no-tty初期stdout未配信は実ライブでも残り、終了時全文を取得。合成fixtureの成功は、この実CLI制限の解消ではない。判定は総合監査の本文を優先する。
