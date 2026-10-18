# macOS GUI acceptance runbook

Date: 2026-10-18  
Extension under test: `y3162.ai-agents` 0.10.0

## Current run status

The Extension Development Host was opened and visually inspected in an isolated profile. The clean chat view rendered and showed the AI Agents header, New chat, Settings, Composer, and the `y3162.ai-agents` webview. In the 2026-10-18 follow-up, Settings was opened and closed using the GUI. A disposable Composer draft was visible before and after the Settings view. An additional three-line synthetic draft was set through the Composer's accessibility value setter to inspect multiline layout; this was not keyboard or IME input and was never sent.

The temporary window was switched to Dark Modern and its theme was verified from the live Workbench DOM class (`vscode-theme-defaults-themes-dark_modern-json`). Read-only DevTools evaluation returned `devicePixelRatio: 2` and `.part.sidebar` width `300` CSS px. The full app screenshot was 2880×1740 physical pixels, so the measured width is distinct from the Retina screenshot scale. The 300px/Dark Modern clean-chat smoke showed the header, Back/New Chat/Settings controls, Composer, model selector, Usage disclosure, and workspace/backend status. It did not contain transcript, Plan, diff, Subagent, or Terminal data, so those areas were not tested at that condition.

CUA can click several accessibility controls, but coordinate drag/click intermittently returns `Computer Use server error -10005: noWindowsAvailable`; a screen capture also returned ScreenCaptureKit `-3811` once. Rebinding the exact temporary app restored AX access. In this follow-up, the isolated Settings view was opened/closed and the same synthetic draft remained visible. Resizing, text entry, and keyboard shortcuts did not produce a verifiable change. The sash drag to 390px did not complete. No prompt was sent in that clean-chat smoke. Native Japanese IME, Clipboard image, authenticated backend, and in-progress Reload scenarios remain untested; the staged Subagent panel was later exercised as recorded below. These automation errors do not prove that the VS Code process exited.

The temporary host's DevTools console showed no signed-in GitHub session, a Marketplace `400`, a blocked source-map request, a missing `After Dark` theme resource (`ENOPRO`), and VS Code/Extension Host warnings including `url.parse()` deprecation and API proposal mismatch. These are recorded as host/runtime messages; this run did not establish that they caused the separate window exit.

## Separate window crash observed

The user clarified that the supplied screenshot is the healthy window and a separate window is the one that repeatedly exits. The attached crash report is for another `Code` process (PID 51996), launched from `/Applications/Visual Studio Code.app/Contents/MacOS/Code`, which aborted with `SIGABRT` in AppKit `___RegisterApplication_block_invoke` while initializing `NSApplication`. The report does not include the process arguments, so it does not independently prove which profile paths that process received. It is not evidence that the healthy screenshot window or the extension itself crashed.

The previous integration runner selected `/Applications/Visual Studio Code.app` whenever `VSCODE_EXECUTABLE_PATH` was unset. It now downloads a disposable VS Code copy into the temporary test profile by default, records its executable, app bundle, and launch arguments before launch, and refuses an executable under `/Applications`. A controlled `test:integration` attempt used the disposable app at `/private/tmp/ai-agents-acceptance.AYHZgj/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app/Contents/MacOS/Code`. The runner logged `ISOLATION_PREFLIGHT` with its fixture workspace, `--user-data-dir`, `--extensions-dir`, and `--shared-data-dir` all under separate `/private/tmp/ai-agents-*` paths. The process then exited with `SIGABRT` before the test Extension Host wrote its runtime receipt or `SUBAGENT_GUI_READY` marker.

The matching macOS report is `Code-2026-10-18-150707.ips`: PID 3413, launched at 15:06:24 from `/private/tmp/*/Visual Studio Code.app/Contents/MacOS/Code`, `SIGABRT` / `Abort trap: 6`, with the triggering stack in AppKit `___RegisterApplication_block_invoke` and `_RegisterApplication`. This confirms the controlled test process crashed during app registration before extension tests began. It does not identify which launch argument or OS condition caused AppKit to abort. Leave both normal VS Code windows untouched while this is unresolved.

A read-only CUA inventory during this follow-up listed two running `Code` app entries. The clean-chat GUI smoke was bound to the temporary app bundle path and window title `[Extension Development Host] workspace2`; its workbench URL began with `vscode-app/private/tmp/ai-agents-acceptance.AYHZgj/`. A separate read-only binding to `/Applications/Visual Studio Code.app` returned a workbench URL under `/Applications/Visual Studio Code.app`; no actions were sent to that installed app. After closing the disposable smoke window, CUA exposed another generic Extension Development Host window with no workspace and the "All installed extensions are temporarily disabled" notice. Because its profile could not be independently identified from the CUA surface, no further VS Code actions were taken. Activity Monitor showed several `Code` PIDs, but its rapidly changing accessibility rows could not be reliably mapped to executable paths. The crash report and `ISOLATION_PREFLIGHT` establish the intended isolated app path and argv before launch; the crash report itself does not record the argv received by PID 3413.

## Isolated development host

Use only the temporary app and profile. Do not open the repository or a user workspace in the regular VS Code window.

- OS: macOS 26.6.2, arm64.
- VS Code app: `/private/tmp/ai-agents-acceptance.AYHZgj/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app` (official VS Code 1.142.0).
- Workspace: `/private/tmp/ai-agents-acceptance.AYHZgj/workspace2` (synthetic `README.md` only).
- User data: `/private/tmp/ai-agents-acceptance.AYHZgj/profile2/user-data`.
- Extensions directory: `/private/tmp/ai-agents-acceptance.AYHZgj/profile2/extensions`.
- Shared data: `/private/tmp/ai-agents-acceptance.AYHZgj/profile2/shared-data`.
- Development extension: `/Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents`, version 0.10.0.
- Profile theme when the host was first opened: Light+. Current temporary GUI theme: Dark Modern.
- The temporary window is titled `[Extension Development Host] workspace2`; its webview URL identifies `extensionId=y3162.ai-agents`.

The temporary VS Code app was started with `--new-window`, `--disable-extensions`, `--disable-workspace-trust`, `--user-data-dir`, `--extensions-dir`, `--shared-data-dir`, and `--extensionDevelopmentPath`. The normal `/Applications/Visual Studio Code.app` window and its data were not used by the isolated GUI host. For a manual run, verify the target window title, executable/app bundle path, exact three data-directory arguments, workspace path, and loaded extension/version before interacting. Confirm `globalStorage` and `workspaceStorage` resolve inside the temporary `user-data` directory and the interactive shared-state database (if created) is under the temporary `shared-data` directory. Stop if any path resolves outside the disposable root or if the target process cannot be distinguished from either existing window.

## A. Width and theme matrix

In the temporary development host, use the sidebar sash to set the actual width, then use **Developer: Toggle Developer Tools** and evaluate:

```js
({ dpr: window.devicePixelRatio, width: document.querySelector('.part.sidebar')?.getBoundingClientRect().width })
```

Record the returned CSS width. Do not infer CSS pixels from Retina screenshot pixels. Select themes using **Preferences: Color Theme**. Use Dark Modern, Light Modern, and High Contrast (or the equivalent installed built-in themes). At each width/theme, inspect the active view and exercise available controls.

| CSS sidebar width | Dark | Light | High Contrast |
|---:|---|---|---|
| 300 | Not run as a full cell; partial GUI smoke in Dark Modern, measured at 300 CSS px | Not tested | Not tested |
| 390 | Not tested; sash drag failed with `noWindowsAvailable` | Not tested | Not tested |

For each cell, check header, backend/model/mode selectors, Composer, transcript/history, Markdown and long code block, file diff, Plan and Build, Usage, subagent list/detail, Background Terminal, errors, narrow labels, and horizontal overflow. Use synthetic content and confirm that controls remain reachable. Record screenshots outside Git; do not commit them.

## B. Subagent panel (deterministic Mock; never report this as live-backend evidence)

The staged Host fixture uses a synthetic App Server and a disposable workspace. It creates child A and child B, waits for the explicit parent wait, and exposes independent completion gates.

1. Close the existing temporary host after recording any manual observations.
2. From the extension directory run `AI_AGENTS_SUBAGENT_GUI_HOLD=1 AI_AGENTS_SUBAGENT_GUI_FINAL_HOLD=1 npm run test:integration`.
3. Wait for `SUBAGENT_GUI_READY <workspace>` in the terminal and select the resulting test window titled `[Extension Development Host]`.
4. Confirm both child cards are Running and the parent is Waiting. Test collapse/expand, open child A detail, return to parent, open child B detail, and confirm the parent's scroll position and any Composer draft.
5. In a second terminal, create the first gate: `touch '<workspace>/gui-child-a.done'`. Verify only A becomes Completed, B remains Running, and the parent remains Waiting. The extension host also writes `subagent-a-verified` after it observes this state.
6. Create the second gate: `touch '<workspace>/gui-child-b.done'`. Verify B becomes Completed, the parent resumes, and exactly one final answer appears. With the final-hold flag enabled, wait for `SUBAGENT_GUI_FINAL_READY <workspace>`, finish the visual inspection, then release cleanup with `touch '<workspace>/gui-final-ui.done'`.
7. Inspect event separation and tool output. Try a long task name and three-or-more children only if a separate fixture is added; this fixture has two children and does not cover those variants.

The integration test's status assertions are automated Host evidence. Only the steps personally observed in the actual test window count as GUI evidence. The runner removes its temporary workspace/profile after completion.

## C. Japanese IME and Composer

Use the macOS Japanese input source (Japanese – Romaji/Kotoeri) in the temporary VS Code window. Do not use synthetic composition events as a substitute.

1. Enter a test phrase such as `きょうはいいてんきです`; invoke conversion and select `今日はいい天気です`.
2. Press Enter once to commit the conversion. Confirm the message remains a Composer draft and is not sent.
3. Press Enter again. Confirm exactly one user message is sent and the Composer clears.
4. Repeat with Shift+Enter to insert a newline, then send a two-line Japanese message.
5. While a conversion candidate is active, open the model menu and mode menu, then switch to another synthetic conversation. Confirm the candidate/draft is not sent or lost; return and finish the conversion.
6. Reload only after noting the conversation ID, draft text, and current input state. Confirm the draft returns unchanged and the send action does not duplicate a turn.

Pass criteria: conversion Enter commits only; a later Enter sends once; Shift+Enter inserts a line; multiline Japanese arrives intact; switching menus/conversations does not submit or corrupt the draft; send clears the Composer.

Status: native IME actions not tested in the current run.

## D. Clipboard image and Retry

Generate a synthetic image (never use a personal image) in the temporary directory:

```sh
python3 - <<'PY'
import struct, zlib
w = h = 16
rows = b''.join(b'\0' + b''.join(bytes((220, 40, 70, 255) if (x // 4 + y // 4) % 2 else (35, 120, 210, 255) for x in range(w)) for y in range(h))
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
open('/private/tmp/ai-agents-acceptance-image.png', 'wb').write(png)
PY
open -a Preview /private/tmp/ai-agents-acceptance-image.png
```

In Preview, copy the image and paste it into the Composer. Repeat to paste two images. Use a backend that explicitly supports image input and an isolated account/profile already authorized for that backend; do not add credentials to the regular profile. Test image-only send, text plus image, remove, draft restoration, Queue while a prior turn is running, conversation switch, deliberate send failure, and explicit Retry.

Before Retry, confirm the exact conversation and attachment. After Retry, verify the same image reference is sent once. Change the draft and switch conversations before a delayed retry response; the response must not overwrite the new draft. If the image reference is unavailable, Retry must ask for reattachment and must not send another conversation's image. Never retry automatically.

Status: real clipboard image and authenticated backend transmission not tested in the current run; no credentials were added to the isolated profile.

## E. Reload and restoration

Run each case separately in a disposable workspace/profile. Record before Reload: conversation ID, backend session ID, message IDs and final text, tool IDs/output, Usage, Plan state, child IDs/status, terminal process ID/status/output, queued prompt, draft, and a hash/status of any test file. Invoke **Developer: Reload Window** in the temporary development host. Do not rerun the prompt or command to “restore” work.

Required cases:

1. Normal turn in progress.
2. Two child agents Running with parent Waiting (use the staged Mock above; also test a real backend only when separately authorized and available).
3. Background Terminal Running (a harmless local process with a unique `READY` marker and a short timeout).
4. Plan creation and Build separately.
5. A queued prompt while another turn is active.
6. An unsent Composer draft.

After Reload, compare all recorded identifiers, transcript, tool output, Usage, plan, child and terminal states, queue, draft, and test-file hash. A stopped process must not still appear Running. If the backend cannot report or reconnect a process, the UI must say Unknown/Disconnected and must not launch a replacement automatically. A live terminal may reconnect only to the same process ID; it must not rerun the command. Check for duplicate output, a duplicate Final, a stale event from an old session, accidental file restore, or loss of a pending draft.

Status: reload was not performed for any live state in the current run.

## F. Result record

For every test, write one of `PASS`, `FAIL`, or `NOT RUN`, with the actual CSS width, theme, app/profile path, and observed evidence. Mock, DOM, and Host Integration results must remain separate from direct GUI and real-backend results. Do not mark a row as a pass when input automation failed or when only a test assertion ran.

## GUI retry on 2026-10-18

The retry did not reach an isolated Extension Development Host, so no acceptance cell is promoted to `PASS`.

- CUA bound `/Applications/Visual Studio Code.app` read-only and identified the normal `Visual Studio Code` window. Its native **Window** menu listed only that window. The menu was closed using its exposed Cancel action; no workspace, settings, chat, or extension state was changed.
- CUA binding the known disposable app under `/private/tmp/ai-agents-acceptance.AYHZgj/.../Visual Studio Code.app` timed out. No test-window action was sent.
- A new synthetic workspace and empty profile directories were created under `/private/tmp/ai-agents-cua-retry.vHUAp1/`. They contained only the synthetic `README.md` after the launch attempts; no VS Code storage was written there.
- Launch Services rejected both app paths with `kLSNoExecutableErr` even though `Contents/Info.plist` names `Code` and `Contents/MacOS/Code` exists. Resolving by bundle ID also failed.
- Directly invoking the installed Code executable with the disposable `--user-data-dir`, `--extensions-dir`, `--shared-data-dir`, workspace, and `--extensionDevelopmentPath` exited 134 (`SIGABRT`) before a window appeared. The new report `Code-2026-10-18-190415.ips` records PID 83509 from `/Applications/Visual Studio Code.app/Contents/MacOS/Code`, with `SIGABRT` in AppKit `___RegisterApplication_block_invoke` / `_RegisterApplication`.
- The `code` CLI returned 0 with a macOS `task_name_for_pid` code-signing diagnostic, but created no disposable-profile files and no additional window. This is not a GUI launch pass.
- A fresh launch-path check found that `codesign --verify --deep --strict` rejects both the installed app bundle and the cached temporary bundle as having an invalid signature. `Contents/Info.plist` and the named `Contents/MacOS/Code` file are present. This is consistent with the Launch Services launch failure, but does not by itself prove the cause. The currently running normal window remains readable; do not replace or repair its app bundle as part of acceptance testing.

Do not continue in the normal window or the unidentified Extension Development Host. To resume, first launch a separate Code instance with all three data directories and the workspace rooted under a fresh disposable directory. Verify its process arguments, window title/workspace, extension path/version, `globalStorage`, `workspaceStorage`, and shared-state database before any GUI input. Stop if Launch Services or AppKit still rejects the instance. Once that preflight passes, run sections A–E and record each direct GUI action separately from Host/DOM evidence. The six width/theme cells, native IME, real clipboard images, and in-progress Reload cases remain `NOT RUN` for this retry. The staged Subagent interaction was subsequently completed in the follow-up below.

## Isolated Subagent GUI follow-up on 2026-10-18

The earlier launch failures remain unexplained, but the official disposable VS Code 1.142.0 app launched successfully in a fresh profile for this deterministic Mock-only run. No actions were sent to either normal VS Code window.

- **Isolation:** `ISOLATION_PREFLIGHT`, the Extension Host receipt, and the runtime receipt all pointed to `/private/tmp/ai-agents-test-profile-zf9jzW/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app`, workspace `/private/tmp/ai-agents-integration-LgRRJv`, and profile `/private/tmp/ai-agents-test-profile-zf9jzW`. The runner resolved `globalStorage` and `workspaceStorage` under the temporary `user-data` directory. The test Host used in-memory VS Code shared storage and received the separate temporary `shared-data` path. The development extension path was `/Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents`, version 0.10.0.
- **Direct GUI — PASS (Subagent panel only):** In the `[Extension Development Host]` window, both children initially showed Running and the parent showed Waiting. Collapse/expand worked; child A and child B detail views opened with distinct task labels and run-history entries, then returned to the same visible parent transcript position. The synthetic draft `Parent navigation draft - not sent.` remained visible after navigation and after the parent completed. After the A gate, the UI showed A Completed, B Running, and the parent Waiting. After the B gate, the final held screen showed both children Completed, the parent Ready, and one final message: `Both independent acceptance tasks completed.` The final screenshot was captured in the Codex run; no screenshot file was added to Git. The CSS sidebar width and theme were not measured for this run.
- **Host Integration — PASS (deterministic Mock only):** The staged App Server assertion passed, the Extension Host exited 0, `ISOLATION_RUNTIME_PASS` and `INTEGRATION_ASSERTIONS_PASS` were emitted, and the runner exited 0 after the final hold was released. The Host verified independent child completion and the final answer. This is not live-backend evidence.
- **Runner setup:** The installed `node_modules` tree initially resolved `restore-cursor@5.1.0` to `signal-exit@3.0.7` even though it requires `^4.1.0`. A temporary symlink to the already-installed 4.1.0 package allowed the run and was removed afterward; no package manifest or lockfile was changed.
- **Remaining:** Section A’s six width/theme cells, Japanese IME, real clipboard images, authenticated backend transmission, and in-progress Reload cases remain `NOT RUN`. The runner removed its temporary workspace and profile after completion.

## Residual GUI acceptance run on 2026-10-18

The successful official VS Code 1.142.0 disposable-app launch and Computer Use route was reused. The extension under development was version 0.10.0. The ordinary VS Code environment was not operated. Evidence is outside Git in `/private/tmp/ai-agents-acceptance-residuals-20261018/`.

### A. Width and theme matrix — partial; Section A `NOT RUN`

Six populated transcript screenshots were captured with a Japanese Markdown message and a 26-line TypeScript code block, plus the existing diff editor and Usage display. The workbench DOM reported `devicePixelRatio=2`; `.part.sidebar.getBoundingClientRect().width` was measured as 300 CSS px and 390 CSS px. Screenshot files are 2880×1740 physical pixels and must not be read as CSS dimensions.

| CSS sidebar width | Theme | Screenshot |
| ---: | --- | --- |
| 300 | Dark Modern | `A-300-dark-modern.jpg` |
| 300 | Light Modern | `A-300-light-modern.jpg` |
| 300 | High Contrast | `A-300-high-contrast.jpg` |
| 390 | Dark Modern | `A-390-dark-modern.jpg` |
| 390 | Light Modern | `A-390-light-modern.jpg` |
| 390 | High Contrast | `A-390-high-contrast.jpg` |

Observed in the six cells: Header/back/title/settings, Composer, fixture Model selector, SDK backend status, transcript/Markdown, long code block, the workbench diff, and Usage. The fixture Usage panel showed input 1/output 1/total 2. The 300 px view showed ellipsized narrow labels and long code lines extending past the code viewport; the workbench itself did not visibly widen, but horizontal scrolling within the code block was not exercised. Subagent list and detail were separately observed in the staged App Server Mock UI; see `A-subagents-list-waiting.jpg`, `A-subagent-detail-waiting.jpg`, and `A-parent-waits-alpha-complete-beta-running.jpg`.

This run did not display Plan output, Build output, or Background Terminal. In the SDK fixture, the Plan/Build mode picker was not available; in the App Server parent-Running fixture, the `Default` mode picker was disabled. Therefore, the six screenshots are evidence for the visible subset only and do not satisfy the full Section A checklist. Mock fixtures are not live-backend evidence.

### C. Japanese IME — `NOT RUN` (partial keyboard checks recorded)

Computer Use sent Control+Space followed by actual key presses for `konnichiha`; the Composer contained those Latin characters and no Japanese conversion candidate appeared. No candidate Enter or message send was attempted. This is a Computer Use/input-source limitation, not evidence of an extension defect. Screenshots: `C-ime-composition.jpg` and `C-ime-no-japanese-source.jpg`.

Partial keyboard checks passed: Shift+Enter made a two-line draft (`line one` / `line two`) without sending it (`C-shift-enter-two-lines.jpg`). The macOS Edit menu was opened and dismissed, then navigation into a child view and back to the parent preserved that draft. The draft was explicitly cleared before the Reload attempt. These checks do not replace the native Japanese IME acceptance test.

Manual completion: in the isolated VS Code window, select the macOS `Japanese – Romaji` input source and Hiragana mode; type `konnichiha`, press Space to show candidates, then press Enter once and verify the Composer remains unsent. Press Enter again and verify exactly one user message appears. Repeat with Shift+Enter for a two-line Japanese message. With an unsent Japanese draft, open Model and Mode menus and switch to another synthetic conversation, then return and confirm the draft remains intact and unsent.

### D. Clipboard image and Retry — Mock UI `NOT RUN`; Real Backend `NOT RUN`

Disposable PNGs `image-a.png` and `image-b.png` were generated. No image was copied into macOS Clipboard or pasted into the Composer: `cua.getApp` for Preview repeatedly returned Computer Use error `-10005` (`timeoutReached`). No attachment, removal, queue, send-failure, retry, or cross-conversation image test is claimed. The isolated profile had no backend credentials; no credentials were read from the ordinary profile and no Real Backend transmission was attempted. Keep Mock UI and Real Backend results separate when completing this section.

### E. Reload during work — `NOT RUN` (one attempt ended at the test-runner boundary)

Before Reload, the staged Mock conversation `SUBAGENT_GUI_STAGED` showed parent `Waiting for subagents`, `gui-child-a` Completed, `gui-child-b` Running, Usage `Not reported`, and an empty Composer. Evidence: `E2-before-reload.jpg` and `E2-before-reload-ax.txt`.

`Developer: Reload Window` was invoked in that Extension Development Host. The window closed; the test Extension Host exited with code 0 and unknown signal, while `@vscode/test-electron` reported `TestRunFailedError` / exit code 1. The runner's cleanup removed the disposable app and profile before a post-Reload GUI state could be read. No state restoration, duplicate execution, or extension-level reconnection outcome can be inferred. This is a test-runner limitation for this attempt, not a product pass or a confirmed product failure. The other five Reload states—ordinary generation, Background Terminal, Plan generation/Build execution, queued prompt, and unsent draft—were not run. Each requires its own isolated case in an Extension Development Host launched without `--extensionTestsPath`.

### Logs, dependency resolution, and code changes

- Integration and Reload attempt log: `integration-attempt-2.log`. It records no `SIGABRT`; the prior crash reports and unresolved cause above remain unchanged. No new Crash Report was produced or required for this run.
- `restore-cursor@5.1.0` requests `signal-exit:^4.1.0`, and the lockfile already resolves that nested dependency to 4.1.0. The installed tree had incorrectly fallen through to the root `signal-exit@3.0.7`. The temporary symlink described in the earlier follow-up is no longer needed: this run repaired only the ignored installed tree by copying the existing 4.1.0 package into `node_modules/restore-cursor/node_modules/signal-exit`. `npm ls signal-exit restore-cursor --all` now resolves successfully, with `proper-lockfile` still using root 3.0.7. No manifest or lockfile was changed. A clean `npm ci` should recreate the lockfile's nested resolution; it was not run because replacing the current dependency tree was not needed for this GUI run.
- No extension source or test fix was identified or made. Existing edits to `scripts/test-integration.mjs` and `test/integration/extension-host.ts` were left untouched. No commit, push, or release was made.

### Results

| Section | Result | Scope |
| --- | --- | --- |
| A | `NOT RUN` | Six populated visual cells saved; Plan/Build and Background Terminal coverage missing, and code-block horizontal scrolling was not verified. |
| C | `NOT RUN` | Native Japanese IME could not be activated; Shift+Enter and menu/conversation draft retention passed for an ASCII draft only. |
| D Mock UI | `NOT RUN` | PNGs generated; Preview Computer Use timed out before Clipboard paste. |
| D Real Backend | `NOT RUN` | Isolated backend authentication was unavailable and not fetched from a normal profile. |
| E | `NOT RUN` | One parent-Waiting Reload was attempted, but the test runner ended before post-Reload state could be observed; the remaining cases were not run. |

These results provide partial GUI evidence only. They do not constitute a v1.0.0 Go/No-Go decision.
