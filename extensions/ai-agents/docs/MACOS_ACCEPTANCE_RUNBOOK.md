# macOS GUI acceptance runbook

Date: 2026-10-18  
Extension under test: `y3162.ai-agents` 0.10.0

## Final acceptance status — 2026-10-18

The user reports that macOS GitHub Actions passed for commit `188c892f`. This acceptance pass did not rerun CI or the Unit suite. `HEAD` is `188c892f39695be054b267d2b699453057ebfa64`; the extension manifest version is `0.10.0`.

### Status matrix

| Requirement | Result | Evidence or blocker |
|---|---|---|
| 300px Dark basic layout | `PASS` | `A-300-dark-modern.jpg`; CSS width read from the Workbench DOM. |
| 300px Light basic layout | `PASS` | `A-300-light-modern.jpg`; CSS width read from the Workbench DOM. |
| 300px High Contrast basic layout | `PASS` | `A-300-high-contrast.jpg`; CSS width read from the Workbench DOM. |
| 390px Dark basic layout | `PASS` | `A-390-dark-modern.jpg`; CSS width read from the Workbench DOM. |
| 390px Light basic layout | `PASS` | `A-390-light-modern.jpg`; CSS width read from the Workbench DOM. |
| 390px High Contrast basic layout | `PASS` | `A-390-high-contrast.jpg`; CSS width read from the Workbench DOM. |
| Transcript and Markdown | `PASS` | Japanese Markdown and a 26-line TypeScript block were visible in all six cells. |
| Diff Preview | `PASS` | The synthetic `note.txt` before/current diff was open beside the sidebar in all six cells. Code-block horizontal scrolling was not checked. |
| Plan View | `BLOCKED` | The deterministic fixture returned generic text rather than a usable plan; an authenticated isolated backend was unavailable. No Plan acceptance is claimed. |
| Build | `BLOCKED` | No verified Plan/file change could be produced by the deterministic fixture; an authenticated isolated backend was unavailable. No Build acceptance is claimed. |
| Usage | `PASS` | Mock display showed input 1, output 1, total 2. This is not backend billing evidence. |
| Subagent Panel and Detail | `PASS` | Mock GUI showed parent Waiting with two Running children; child A then Completed while B remained Running; both details opened; afterward both children Completed and one parent final appeared. |
| Background Terminal — Mock UI | `PASS` | `PAGED` showed `proc-1` and `proc-2` as Running. After Reload and History restore, both same IDs showed Unknown; no replacement run occurred. These are fixture IDs, not OS processes. |
| History — Mock UI | `PASS` | The `FAIL_TURN` record was opened from History after Reload; the transcript, including `PAGED`, returned without a prompt being sent. The fixture maps requests to the same `thread-1`, so this does not prove distinct backend conversation identity. |
| Error display — Mock UI | `PASS` | `FAIL_TURN` visibly rendered `boom` with Retry/Logs/Diagnose. After the fix, Retry restored the prompt and `image-a.png`; a separate Send created one retry turn with `imageCount: 1` and reused the original user-message ID. |
| Native Japanese IME, steps 1–9 | `PASS` (user-confirmed) | User reports normal completion using macOS Japanese – Romaji/Hiragana: conversion Enter committed without sending; next Enter sent once; Shift+Enter inserted a newline; model/mode actions and Japanese draft retention after conversation switching worked. Direct AX state showed separate `こんにちは` and `こんにちは\n改行` user messages. |
| ASCII Shift+Enter and draft retention | `PASS` (partial only) | A two-line ASCII draft survived Settings and conversation navigation. This is not Japanese IME evidence. |
| Clipboard images — Mock UI: paste/count, image-only, text+image, remove | `PASS` (user-confirmed) | The user reports completing items 1–4 in Preview with the disposable PNG fixtures. No backend delivery is inferred. |
| Clipboard images — Mock UI: Queue while parent/children run | `PASS` | In QVC6kt, pasted `image-a.png` and queued one image while the parent waited and both children ran. The Queue item persisted across Reload and was not auto-sent. |
| Clipboard images — Mock UI: failure and Retry | `PASS` after fix; pre-fix `FAIL` reproduced | Before fix, Retry restored text but dropped the image; a manual send produced a retry with no `imageCount`. After fix, the GUI restored `image-a.png`, and one manual Send created exactly one retry with `imageCount: 1`, reusing the existing user-message ID. |
| Clipboard images — Mock UI: missing-image guidance | `PASS` | After Reload, selected the saved image-bearing `FAIL_TURN` conversation and clicked Retry. Composer showed the text and filename chip, displayed `添付を再指定して入力を確認してください。自動再実行はしません。`, and did not send. The user must paste the image again before sending. |
| Clipboard images — Mock UI: cross-conversation isolation | `PASS` | Kept a real `image-a.png` Clipboard attachment in conversation A's unsent Composer, switched to a new conversation B, confirmed B had no image thumbnail, then returned to A and confirmed its image remained. No turn was sent. |
| Image transmission — Real Backend | `BLOCKED` | The isolated profile was not authenticated. No regular-profile credential was read or copied and no real-backend image was sent. |
| Reload: normal Turn | `BLOCKED` | The deterministic GUI fixture has no held single-turn prompt; the isolated profile is unauthenticated, so a live normal Turn cannot be held safely. |
| Reload: parent Waiting/child Running | `PASS` (Mock; combined with Queue/draft) | In QVC6kt, parent `gui-parent-turn` waited on `gui-child-a` and `gui-child-b`, both Running. After Reload, UI marked parent/children Unknown, retained the same child IDs and transcript, and did not fabricate completion or rerun children. Synthetic children have no OS `processId`. |
| Reload: Background Terminal — Mock UI | `PASS` after fix | Before: `PAGED`, session `thread-1`, `proc-1` and `proc-2` Running, empty Queue and Composer; README SHA-256 unchanged. After Reload and History restore: same IDs Unknown, transcript retained, no automatic execution. See the follow-up record below. |
| Reload: Plan generation | `BLOCKED` | The deterministic fixture does not provide a held Plan generation; the isolated profile was not authenticated to a real backend. |
| Reload: Build execution | `BLOCKED` | The deterministic fixture does not provide a held Build execution; no isolated real-backend session was available. |
| Reload: queued prompt | `PASS` (Mock; combined case) | One queued image remained after Reload with the same queue ID and attachment name; no automatic send occurred. |
| Reload: unsent Composer draft | `PASS` (Mock; combined case) | Pre-Reload draft `DRAFT_BEFORE_RELOADDeveloper: Reload Window` remained byte-for-byte visible after History restore. The command text was accidentally appended during palette automation and is recorded as part of the observed draft. |
| Active GUI launch isolation | `PASS` (QVC6kt) | User-launched VS Code 1.142.0 `[Extension Development Host] workspace`; isolated workspace, user-data, extensions, shared-data, and fixture paths; `credentialsCopied: false`; no sandbox bypass flags. The agent execution environment cannot independently validate Apple trust services, while the user reports the preflight passed in normal Terminal. |

Record each manual result with this minimum evidence. Keep screenshots/logs under the disposable session or `/private/tmp`, never in the normal profile.

| Date/time | Case and exact operation | App/version + session root | Mock or Real Backend | Expected | Observed + IDs/process IDs | Screenshot/log path | Result |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  | `PASS` / `FAIL` / `BLOCKED` / `NOT RUN` |

The six width/theme images and Subagent images are in `/private/tmp/ai-agents-acceptance-residuals-20261018/`, outside Git. Subagent evidence files are `A-subagents-list-waiting.jpg`, `A-subagent-detail-waiting.jpg`, and `A-parent-waits-alpha-complete-beta-running.jpg`. The image fixtures are `image-a.png` and `image-b.png` in the same directory. QVC6kt's History JSON remains in its disposable session root; the latest AX observations and outcomes are recorded in this runbook. No new screenshot was saved in the repository.

### GUI environment and operator handoff

The independent launcher is `npm run gui:start`; it builds the extension, omits `--extensionTestsPath`, creates a disposable app/profile/workspace/shared-data tree, uses an isolated `HOME`/`CODEX_HOME`/`CURSOR_HOME`, does not copy credentials, and retains its tree through Reload until explicit cleanup. `npm run gui:status -- <root>`, `npm run gui:stop -- <root>`, and `npm run gui:cleanup -- <root>` operate on the printed session root. VS Code may create an empty `extensions.json` registry in the isolated extensions directory; the launcher permits that file only when the registry is an empty array. Cleanup refuses while the recorded process group may still be alive.

This host could not safely launch the available VS Code bundles: `/Applications/Visual Studio Code.app` and cached copies under `/private/tmp` failed `codesign --verify --deep --strict`. An official download attempt in Chrome was blocked by the client; the earlier CLI download attempt recorded `getaddrinfo ENOTFOUND update.code.visualstudio.com`.

The user supplied a fresh official VS Code 1.142.0 Apple-silicon app at `/private/tmp/vscode-arm64.ZKpQYY/Visual Studio Code.app` and reports that, from their normal macOS Terminal, `codesign --verify --deep --strict` and the designated-requirement check pass, `spctl --assess --type execute` accepts it, and Gatekeeper reports notarized Developer ID. The app is arm64, bundle ID `com.microsoft.VSCode`, Microsoft Team ID `UBF8T346G9`. In this Codex execution context, the same `codesign`/`spctl` path fails for both the supplied app and Apple Calculator (`CSSMERR_TP_NOT_TRUSTED` / Code Signing subsystem error). Computer Use also refuses access to `com.apple.Terminal`. These failures show that this execution context cannot perform the requested trust check; they do not establish that the app is invalid. Do not bypass trust checks or launch it from this context. The latest prepared GUI session receipt is `/private/tmp/ai-agents-gui-acceptance-9od5XA/session.json`; it has no app executable or process ID and was not launched.

Run the following once in the user's normal macOS Terminal. It selects the exact user-verified bundle, makes a separate disposable app copy, and lets the launcher check that copy's signature before launching. It does not use the regular `/Applications/Visual Studio Code.app`, profile, extensions, workspace, shared storage, or credentials. The independent launcher omits `--extensionTestsPath`, creates isolated user-data/extensions/shared-data/workspace and HOME trees, and preserves the session across Reload:

```sh
cd /Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents
AI_AGENTS_GUI_VSCODE_APP_BUNDLE="/private/tmp/vscode-arm64.ZKpQYY/Visual Studio Code.app" npm run gui:start
```

Keep the single launch attempt open until its output is available. Record `GUI_ISOLATION_PREFLIGHT_PASS` and `GUI_SESSION_STARTED <session-root>`. If it errors, do not relaunch repeatedly: keep the printed session root and error for diagnosis. Before GUI input, match `session.json` against the target window: disposable app path/version, `[Extension Development Host]` title, isolated workspace, extension path/version, `--user-data-dir`, `--extensions-dir`, `--shared-data-dir`, empty isolated extensions directory, and `credentialsCopied: false`. Confirm the profile databases resolve inside the session root. If any check fails, stop. If Computer Use times out once, switch to manual mouse/keyboard on that already identified window; do not repeat the same automation call or relaunch the same failing app. Preserve the session tree until all Reload comparisons and acceptance evidence are recorded, then stop and explicitly clean it up. The user must return the session root and confirm that the disposable Extension Development Host is visible before GUI acceptance can resume here.

#### Active user-launched GUI session

On 2026-10-18, the user launched the exact verified app from their normal Terminal. Session root: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG`; app: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/vscode-cache/local-disposable-app/Visual Studio Code.app`; executable: the `Contents/MacOS/Code` inside that bundle; reported PID: `28937`; VS Code 1.142.0; extension 0.10.0; `credentialsCopied: false`. The bound window title and URL both identify the disposable app, the workspace is inside the session root, and the AI Agents webview reports `Ready`. Keep this process and all session data alive until the acceptance work is complete. The app wrote `extensions.json` containing `[]`; a local launcher preflight originally rejected the mere presence of this VS Code housekeeping file. The preflight now accepts that empty registry while rejecting any registered or unexpected extension entry.

At startup, macOS showed “The keychain that saves ‘Code Key’ could not be found.” The user canceled it; no sign-in or key was entered. Electron documents that its `safeStorage` keys are stored in macOS Keychain and may prompt, while VS Code stores its SecretStorage encryption key in an app-specific `Code Safe Storage` item. The dialog alone does not identify whether this particular access came from Electron `safeStorage`, Chromium cookie encryption, or another startup path. The isolated `HOME` with no initialized login keychain is a plausible trigger, but this remains an inference. Continue with the no-auth deterministic Mock UI after cancellation if it remains functional; do not sign in or open any keychain. VS Code’s `--password-store=basic` option is documented for Linux keyring selection and does not provide a macOS Keychain override. Electron has a `--use-mock-keychain` switch for automated macOS tests, but it changes the OS-keychain path and is not applied to this live session; it must not be treated as equivalent to a real SecretStorage/credential test. If real-backend authentication is required, record it `BLOCKED` until an explicitly isolated macOS user/keychain arrangement is available.

The user supplied a fresh official VS Code 1.142.0 Apple-silicon bundle, signature-verified from their normal Terminal, and launched the active session once. The launcher preflight and the live window identify the disposable app/profile/workspace; no normal VS Code window was used. After the first GUI prompt accidentally read the default bundled App Server executable and returned HTTP 401, the test setup was corrected in the isolated `profile/user-data/User/settings.json`: machine-scoped `ai-agents.codex.executablePath` now points to `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/fixture-bin/codex-app-server`. The VS Code Settings UI showed that exact effective value, and the extension Settings view showed App Server. The wrapper's standalone `initialize` check returned `userAgent: fixture`. No retry of the 401 turn was made. A harmless `SUBAGENT_GUI_STAGED` string was also entered once into the standard VS Code Copilot Chat by a stale accessibility target; Copilot displayed its sign-in requirement. No credentials were entered, and this is not AI Agents/subagent acceptance evidence.

For the native IME handoff, the user selected Japanese – Romaji and Hiragana. Computer Use typed `konnichiha` in the AI Agents Composer, but its Space action added a literal space and did not expose Japanese candidates; that draft was then cleared. This is recorded as an automation limitation, not an IME pass/fail. The user has been asked to perform the native conversion/commit/send, Shift+Enter, model/mode, and conversation-switch checks manually and report the observed outcome.

References: [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage), [VS Code keychain troubleshooting](https://code.visualstudio.com/docs/editor/settings-sync#_troubleshooting-keychain-issues), and [Electron’s macOS mock-keychain test switch](https://releases.electronjs.org/pr/53790).

For the remaining feature checks, use separate evidence rows and screenshots:

1. **History:** send a harmless synthetic prompt using the deterministic App Server fixture, open History, select that conversation, and verify its transcript returns once without resending the prompt.
2. **Plan and Build:** sign in only inside the isolated profile, select a supported model, create a plan against a disposable file, then run Build and verify the file diff/content. Record the file hash before and after. If the isolated account cannot authenticate, keep both rows `BLOCKED`.
3. **Background Terminal:** run a harmless command that prints a unique `READY` marker and waits briefly; record its command, `processId`, output, and final status. Do not launch it twice.
4. **Error display:** with the deterministic fixture, submit `FAIL_TURN` and verify that the extension shows the backend error and leaves the session usable. This verifies the fixture error path only.

These are procedures, not passes. Sign in only inside the isolated profile if real-backend transmission is required; otherwise keep those rows `BLOCKED`.

For the native IME, switch macOS input source to **Japanese – Romaji** and Hiragana mode, type `konnichiha`, press Space, select `今日はいい天気です`, and press Enter once. Confirm the Composer still contains the committed text and no user message exists. Press Enter again and confirm exactly one user message. Test Shift+Enter, model/mode menus during composition, and draft retention after switching conversations. Record the input-source name and each observed send count. Missing/duplicate sends are `FAIL`.

For image UI, copy only the disposable `image-a.png` and `image-b.png` through Preview. Record attachment count after each paste; verify image-only and text-plus-image drafts, remove, queue while a prior turn runs, deliberate send failure, explicit Retry, missing-image reattachment guidance, and cross-conversation isolation. Separate Mock UI from Real Backend. Before Retry, record the conversation and attachment IDs; confirm one matching image is sent and no other conversation's attachment leaks. If Preview or the GUI controller times out, perform the copy/paste manually once and record the result.

For each Reload case, record conversation ID, backend Session ID, turn/item/child IDs and status, child `processId`, queue text/count, draft, transcript, Usage, Plan, terminal command/output/process ID, and test-file hash before Reload. After **Developer: Reload Window**, record the same fields from the reopened session without sending/restarting work. Missing/unqueryable active state is `Unknown`, not Completed. Any automatic Queue resend, Build rerun, terminal relaunch, fabricated child completion, or old-session event in the new session is `FAIL`.

### Release decision

**v1.0.0: `NO-GO`.** macOS CI passed at `188c892f` per user report. Six basic width/theme cells, user-confirmed native IME, Mock image paste/send/remove/Queue/Retry/missing-image guidance/conversation isolation, Subagent UI, Mock Background Terminal/History, and the combined Subagent/Queue/draft Reload comparison passed. Real-backend image transmission, Plan, Build, normal-turn Reload, and dedicated Plan/Build Reload observations remain `BLOCKED`. Mock evidence does not replace real-backend acceptance.

### Active GUI acceptance follow-up — 2026-10-18

The active window remained `[Extension Development Host] workspace` from the user-launched, isolated VS Code 1.142.0 app. `gui-session.mjs status` reported process group running (PID 28937; OS process probe permission denied), app/profile/workspace/shared-data/HOME all rooted at `/private/tmp/ai-agents-gui-acceptance-lZ1xAG`, and `credentialsCopied: false`. Computer Use observed the AI Agents view in that exact app bundle after Reload. No ordinary VS Code window, regular Keychain, or existing credential was accessed. The saved launch receipt also shows `--disable-workspace-trust`, `--no-sandbox`, and `--disable-gpu-sandbox`; this was inherited from the first launcher version. The current session was kept open under the user's instruction. Those flags have been removed from `gui-session.mjs` for future launches. Current GUI evidence therefore comes from the user's isolated, signed app and isolated data paths, with Chromium sandbox and workspace-trust bypasses recorded as an environment limitation.

To continue with the hardened launcher, the user must start a second disposable GUI from their normal macOS Terminal while leaving this session and its files untouched:

```sh
cd /Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents
AI_AGENTS_GUI_VSCODE_APP_BUNDLE="/private/tmp/ai-agents-gui-acceptance-lZ1xAG/vscode-cache/local-disposable-app/Visual Studio Code.app" npm run gui:start
```

The new launcher verifies the same copied, official VS Code bundle, creates a fresh app/profile/workspace/shared-data/HOME tree, and omits the sandbox/workspace-trust overrides. Confirm the new `GUI_ISOLATION_PREFLIGHT_PASS`, unique session root, `[Extension Development Host]` title, workspace/profile paths, extension path/version, and `credentialsCopied: false` before GUI input. If VS Code asks whether to trust the workspace, trust only the new disposable workspace. Do not close or clean the older session while continuing the work.

The user manually confirmed the complete native Japanese IME sequence in the isolated AI Agents Composer. The direct GUI accessibility tree subsequently showed separate user messages `こんにちは` and `こんにちは\n改行`; the user confirmed conversion Enter did not send and the following Enter sent once, along with Shift+Enter, model/mode controls, and Japanese draft retention after conversation switching. This is user-reported manual input using native macOS IME, not a synthetic composition test.

The deterministic App Server Mock `FAIL_TURN` operation showed `boom` and Retry/Logs/Diagnose. Clicking Retry restored `FAIL_TURN` in Composer without auto-sending; pressing Send separately produced one failed turn and no duplicate. The History view listed `FAIL_TURN` and `SUBAGENT_GUI_STAGED`. Selecting `FAIL_TURN` after Reload restored the transcript without sending a prompt. This fixture returns the same backend thread ID (`thread-1`) for unrelated requests, so the History evidence is limited to the visible local restore path.

#### Background Terminal Reload comparison — Mock UI

Before Reload, the AI Agents UI showed `PAGED`, backend Session ID `thread-1`, Mock terminal IDs `proc-1` (`finite-process`) and `proc-2` (`second-process`) as Running, empty Queue and Composer, and workspace `README.md` SHA-256 `2c51e9ca0b2512d7f94c9c4897822754561d0a5d33c309064ca82eeff78da93f`. Local conversation ID was `7e8de26f-8139-4ddd-bc33-5ce78ae8be99`; the history record had two earlier failed `turn-1` records and two `background-turn` records because this fixture reuses turn IDs. These fixture process IDs do not identify OS processes. `Developer: Reload Window` was invoked in the independent GUI host. As expected, the host reopened on New chat; after opening History and restoring `FAIL_TURN`, the same `proc-1` and `proc-2` records appeared as `unknown`, with both `PAGED` tool cards still in the transcript. Persisted turn statuses remained failed/completed; Queue length remained 0 and Composer draft remained null. No command, Build, or Queue was replayed. No live OS process or backend work was claimed.

The first post-Reload attempt, before the fix, restored the conversation but the empty Mock terminal list erased the saved Unknown rows. The code now retains absent saved Unknown records when a successful post-Reload terminal list does not include them; a matching returned row can still update its status. Regression coverage is `test/sidebar/chat-controller-session-switch.test.ts` (“a missing terminal in a successful post-reload list remains unknown”). That test passed (4/4 in the file), `npm run check` passed, and `npm run build` passed. The isolated GUI was reloaded after the build, and the Unknown rows were visibly confirmed there.

Remaining independent Reload cells are normal Turn, parent Waiting/child Running, Plan generation, Build execution, queued prompt, and unsent Composer draft. No active-state status can be inferred from the successful window reload alone.

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
- An earlier launch-path check in this execution context found that `codesign --verify --deep --strict` rejects the installed and cached app bundles as having an invalid signature. The same local trust path also failed for Apple Calculator. The user subsequently verified the supplied official app from their normal Terminal. Treat the earlier output as a limitation of this execution context, not as evidence that the supplied app is invalid. The currently running normal window remains readable; do not replace or repair its app bundle as part of acceptance testing.

Do not continue in the normal window or the unidentified Extension Development Host. To resume, first launch a separate Code instance with all three data directories and the workspace rooted under a fresh disposable directory. Verify its process arguments, window title/workspace, extension path/version, `globalStorage`, `workspaceStorage`, and shared-state database before any GUI input. Stop if Launch Services or AppKit still rejects the instance. Once that preflight passes, run sections A–E and record each direct GUI action separately from Host/DOM evidence. The six width/theme cells, native IME, real clipboard images, and in-progress Reload cases remain `NOT RUN` for this retry. The staged Subagent interaction was subsequently completed in the follow-up below.

## Final macOS GUI follow-up — 2026-10-18

This is the latest direct GUI record and supersedes earlier `NOT RUN` statements above where the same item is now explicitly marked PASS, FAIL, or BLOCKED in the status matrix.

### Isolated GUI identity

The user launched the independent GUI from normal macOS Terminal. The active window is `[Extension Development Host] workspace`, VS Code 1.142.0 arm64, extension `y3162.ai-agents` 0.10.0, PID 40804. The active app bundle and executable are under `/private/tmp/ai-agents-gui-acceptance-QVC6kt/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app`. The session root, workspace, user-data, extensions, shared-data, HOME, Codex HOME, Cursor HOME, and Mock executable are all under `/private/tmp/ai-agents-gui-acceptance-QVC6kt`; `credentialsCopied` is false. The live webview URL contains `extensionId=y3162.ai-agents`. The launch receipt has no `--no-sandbox`, `--disable-gpu-sandbox`, or `--disable-workspace-trust`. The user's normal-Terminal preflight reported PASS. In this agent environment, `codesign` and `spctl` still fail even for Apple Calculator; the identical Code executable hash is `c22afb0725e909e6bd4c2dd3a40da59ae6f32b53d4e9187e4f63b032ed34b495`, matching the bundle previously verified by the user. No normal VS Code profile, Keychain, or credential was accessed. Session status confirmed the process group running; its process probe is denied by this execution sandbox. Keep QVC6kt and the earlier lZ1xAG session intact until the operator explicitly stops and cleans them up.

The user-reported clipboard completion covered paste/count for one and two images, image-only send, text plus image, and attachment removal (`PASS`, Mock UI). A further direct GUI operation pasted `image-a.png` while the parent waited on two running Mock children and added one Queue item. The item stayed queued across Reload. The fixture children use synthetic IDs and do not have OS process IDs.

### Image Retry defect and fix

In the first direct QVC6kt `FAIL_TURN` attempt, the Composer contained the real Clipboard `image-a.png`; the Mock UI displayed `boom`. Retry returned the text but no image. Sending manually once produced one retry record with `imageCount` absent. This reproduced a production bug: `retryPrepared.conversationId` used the durable conversation ID, while the webview guard compares it with the active SessionRegistry key, so the response carrying the saved image was discarded.

The fix in `src/sidebar.ts` now echoes the target conversation's SessionRegistry key. A regression assertion in `test/sidebar/sidebar-retry-image-preservation.test.ts` checks that the Retry response ID matches the active state shell ID. After rebuilding and reloading the isolated host, the user-visible Retry action restored the `image-a.png` thumbnail. One manual Send then produced one retry turn with `imageCount: 1`, the same original user-message ID, and no duplicate user message. The Mock returned `boom` as expected.

Evidence from the isolated History records (image bytes are not copied into this document):

| Run | Conversation ID | Original user ID | Retry turn | Retry image count | Result |
|---|---|---|---|---:|---|
| Before fix | `13a6a312-481e-4e6f-901a-eb2b7d287834` | `b7f77890-674f-45bb-bb3e-b116f5b7a284` | `631b0650-4252-49fc-a80e-0f06f8b18bd6` | absent | Image was dropped by Retry. |
| After fix | `9a3d9edd-65c3-47df-8b1f-14197e44ef88` | `f13ebe2c-d1c6-450e-b5b3-9adfe19d72b7` | `8f893b96-38e8-487f-96c7-2613d89fbb6c` | 1 | Image restored and manually sent once. |

After a subsequent Reload, reopening the saved failure and clicking Retry showed `添付を再指定して入力を確認してください。自動再実行はしません。` and an `image-a.png` filename chip, with the text in Composer and no new user turn. This is the correct missing-bytes path: the binary is not persisted in local History, so the operator must paste the image again before Send. No send was performed in this handoff check.

For cross-conversation isolation, a real Clipboard `image-a.png` remained in conversation A's Composer while switching to a new conversation B. B showed no image thumbnail. Returning to A showed its image still present. No prompt was sent in either conversation for this check. The Composer text draft was visible in B as well; text-draft continuity is separately expected and is not counted as image leakage.

### Reload comparison: parent, children, Queue, draft

Before Reload, the direct GUI showed parent turn `gui-parent-turn` Waiting, children `gui-child-a` and `gui-child-b` Running, one queued image, and an unsent draft. The local conversation ID was `4e73fb20-93d0-4ecf-9fab-915b0e240943`; fixture Session ID was `thread-1`; the user-message/turn ID was `26dbdc71-de79-4980-a900-4fe93fc0deb3`; Queue ID was `c1c80a19-d56b-4ff8-9f12-0c8bc3d6371f`; attachment name was `image-a.png`; the synthetic workspace `README.md` hash was `2c51e9ca0b2512d7f94c9c4897822754561d0a5d33c309064ca82eeff78da93f`. The pre-Reload draft read `DRAFT_BEFORE_RELOADDeveloper: Reload Window`; command-palette typing had appended the command label, and that exact text is recorded here.

After **Developer: Reload Window**, the host opened a New chat; opening History and selecting `SUBAGENT_GUI_STAGED` restored the relevant conversation. The UI labeled the parent/child execution state Unknown after Reload, kept child IDs `gui-child-a` and `gui-child-b`, retained the same Queue ID with one image, and restored the exact draft. The persisted terminal list was empty; the unchanged README hash confirmed no fixture file changes. No child completion was fabricated, and there was no Queue auto-send, Build rerun, terminal relaunch, or visible stale event. Since the Mock cannot prove backend work resumed, active execution remains `Unknown`. This combined run passes the Reload safety criteria for parent Waiting/child Running, Queue, and draft.

A second Reload after the retry fix happened with no active turn; History restored the completed Mock `FAIL_TURN` once. It did not auto-run the failed turn. The active GUI remains open after these Reloads.

### Human handoff for outstanding release blockers

1. **Real Backend image delivery, Plan, and Build:** the isolated profile has no credential and the agent must not copy one from a normal profile. The human operator can authenticate through AI Agents in QVC6kt only, using the isolated app's supported sign-in flow and disposable fixtures. After the operator explicitly confirms the target backend/model, send only `image-a.png` and `image-b.png`; record backend/session/conversation IDs and the visible response. For Plan/Build, hash a disposable workspace file before and after, capture the Plan card and Diff Preview, and record each operation's turn ID. If the Code Key prompt requires changing or unlocking a normal Keychain, cancel and keep these rows `BLOCKED`.
2. **Normal Turn Reload:** the GUI fixture returns ordinary turns immediately and cannot hold a single ordinary turn in progress. Authenticate only in the isolated profile or add a deterministic held-turn fixture before this GUI case; record the same conversation/session/turn IDs immediately before and after Reload. If the operator cannot authenticate and no held-turn fixture is available, keep `BLOCKED`.
3. **Plan/Build Reload:** while the isolated backend visibly reports Plan generation or Build execution in progress, record plan/turn IDs, pending state, and file hash, then invoke Reload once. On return, mark state `Unknown` unless the same backend operation and UI status can be queried. Do not click Build again to recreate the state.
4. **Evidence recording:** for each manual operation, write UTC/local time, `QVC6kt`, exact visible operation, Mock/Real Backend, conversation/session/turn/child/Queue/process IDs where applicable, before/after status, file hash, and screenshot/AX log path in the table at the top. A completed Reload alone is not a PASS.

### Verification and repository state

At this follow-up, local `HEAD` remained `188c892f39695be054b267d2b699453057ebfa64`; GitHub Actions macOS CI success at that commit is user-reported. The source and regression-test changes are uncommitted. `npm run check`, `npm run build`, the focused Retry/Sidebar tests (9/9), and the specific Retry preservation test passed. No Linux validation, commit, push, or release was performed. The release decision remains **v1.0.0 NO-GO** until the `BLOCKED`/`NOT RUN` acceptance items above are resolved and evidenced.

## Isolated Subagent GUI follow-up on 2026-10-18

The earlier launch failures remain unexplained, but the official disposable VS Code 1.142.0 app launched successfully in a fresh profile for this deterministic Mock-only run. No actions were sent to either normal VS Code window.

- **Isolation:** `ISOLATION_PREFLIGHT`, the Extension Host receipt, and the runtime receipt all pointed to `/private/tmp/ai-agents-test-profile-zf9jzW/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app`, workspace `/private/tmp/ai-agents-integration-LgRRJv`, and profile `/private/tmp/ai-agents-test-profile-zf9jzW`. The runner resolved `globalStorage` and `workspaceStorage` under the temporary `user-data` directory. The test Host used in-memory VS Code shared storage and received the separate temporary `shared-data` path. The development extension path was `/Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents`, version 0.10.0.
- **Direct GUI — PASS (Subagent panel only):** In the `[Extension Development Host]` window, both children initially showed Running and the parent showed Waiting. Collapse/expand worked; child A and child B detail views opened with distinct task labels and run-history entries, then returned to the same visible parent transcript position. The synthetic draft `Parent navigation draft - not sent.` remained visible after navigation and after the parent completed. After the A gate, the UI showed A Completed, B Running, and the parent Waiting. After the B gate, the final held screen showed both children Completed, the parent Ready, and one final message: `Both independent acceptance tasks completed.` The final screenshot was captured in the Codex run; no screenshot file was added to Git. The CSS sidebar width and theme were not measured for this run.
- **Host Integration — PASS (deterministic Mock only):** The staged App Server assertion passed, the Extension Host exited 0, `ISOLATION_RUNTIME_PASS` and `INTEGRATION_ASSERTIONS_PASS` were emitted, and the runner exited 0 after the final hold was released. The Host verified independent child completion and the final answer. This is not live-backend evidence.
- **Runner setup:** The installed `node_modules` tree initially resolved `restore-cursor@5.1.0` to `signal-exit@3.0.7` even though it requires `^4.1.0`. A temporary symlink to the already-installed 4.1.0 package allowed the run and was removed afterward; no package manifest or lockfile was changed.
- **Remaining:** Section A’s six width/theme cells, Japanese IME, real clipboard images, authenticated backend transmission, and in-progress Reload cases remain `NOT RUN`. The runner removed its temporary workspace and profile after completion.

## Residual GUI acceptance run on 2026-10-18 (historical snapshot; final disposition is in the status matrix above)

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

This section preserves the outcome recorded at the end of that individual run. The authoritative consolidated result and v1.0.0 Go/No-Go are in the status matrix at the top of this document.


## Post-change blocker retest — 2026-10-18

Target: macOS arm64, HEAD 188c892f39695be054b267d2b699453057ebfa64, extension 0.10.0, current uncommitted working tree. This is a new snapshot and does not rewrite the previous status matrix.

### Isolated GUI session inventory

- QVC6kt remains open and untouched. The known unsent FAIL_TURN prompt and image-a.png were not sent, removed, or edited. No cleanup was attempted.
- lZ1xAG is the selected disposable Mock GUI session: VS Code 1.142.0, Extension Development Host window, workspace /private/tmp/ai-agents-gui-acceptance-lZ1xAG/workspace, user-data /private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/user-data, shared data /private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/shared-data, CODEX_HOME /private/tmp/ai-agents-gui-acceptance-lZ1xAG/isolated-home/.codex. The GUI extension is y3162.ai-agents 0.10.0. Its fixture executable override points to /private/tmp/ai-agents-gui-acceptance-lZ1xAG/fixture-bin/codex-app-server. The receipt says credentialsCopied=false. PID 28937 is reported by the receipt; the sandbox denies an independent process probe. The lZ1xAG window and its data remain open.
- No normal VS Code window was selected or operated.

### Additional GUI results

In lZ1xAG, the PAGED Mock prompt showed two fixture terminal rows, proc-1 and proc-2, both Running, and visible Terminate controls. They are synthetic fixture IDs; no OS process was started or confirmed. The Terminate click was BLOCKED by Computer Use error -10005 because the accessibility target became stale. No terminal termination is claimed.

A synthetic unsent draft, UNSENT_SWITCH_DRAFT_20261018, was visible after entry. Navigating back to History succeeded, but activating the same blank conversation again failed with stale Computer Use targets. Its post-switch retention is BLOCKED for this attempt. No Send action was invoked.

Copy success at 300 px, long code-block horizontal scrolling, Plan View display/actions, and Build button state were NOT RUN in this Mock GUI attempt. The current fixture transcript did not supply the needed code/Plan/Build content. The earlier six width/theme cells were not re-captured.

### Reload case status

| Case | Result | Evidence |
|---|---|---|
| Ordinary Turn in progress | BLOCKED | Fixture ordinary turns complete immediately; authenticated isolated backend is not yet available |
| Plan generation in progress | BLOCKED | Current fixture has no held Plan execution |
| Build execution in progress | BLOCKED | Current fixture has no held Build execution |
| Queue held across Reload | PASS (prior QVC6kt evidence; not rerun) | Existing record shows the same queued item remained and was not auto-sent |
| Unsent draft across Reload | PASS (prior QVC6kt evidence; not rerun) | Existing record shows the draft after Reload; new lZ1xAG switch result is inconclusive |
| Background Terminal across Reload | PASS (prior Mock GUI evidence; not rerun) | Existing record shows saved terminal IDs restored as Unknown; current lZ1xAG only verified the pre-Reload Running display |

The Developer: Reload Window performed in lZ1xAG during this retest was in a blank chat. It verified the window could reload and return to the extension, but it is not evidence for any active Turn, Plan, Build, Queue, or process.

### Post-change local regression and package

All Phase 1 checks passed on macOS arm64: check; unit 822/822; coverage; hygiene (431 files); build; test:integration (VS Code 1.142.0 Host Integration); package; and git diff --check. Coverage: lines/statements 99.75%, branches 98.83%, functions 99.79%.

The Darwin arm64 VSIX contains 1,514 files, 389,151,529 uncompressed bytes, SHA-256 1252a542604725eb8ce727210841730fe0d3f3e16ef518131eb29548e8ca7d89. It contains no test paths, maps, auth.json, .env, credential-named files, or local session/workspace paths. The bundled Codex Mach-O contains one key-shaped upstream literal identical to the installed dependency; its value is intentionally not copied here. The complete package audit is in AUDIT.md.

### Real-backend handoff — Codex App Server

The selected test backend is Codex App Server, not Cursor. lZ1xAG is not authenticated; the isolated CLI returned Not logged in. No real image or prompt was transmitted and no paid inference was started.

The Codex CLI bundled through the extension dependency was verified at /Users/sekiyuuta/Developer/y3162/vscode-extensions/node_modules/@openai/codex/bin/codex.js and runs with Node /opt/homebrew/Cellar/node/26.7.0/bin/node. To keep authentication inside this disposable session, its isolated CODEX_HOME config is already set to cli_auth_credentials_store = file. No credential data was copied or read.

User action:
1. In a normal Terminal, run the command below. CODEX_HOME directs Codex to the isolated lZ1xAG directory; it does not use the normal Codex auth store.
2. Complete the ChatGPT sign-in in the browser opened by Codex yourself. Do not paste an API key. The CLI should write auth only under the isolated CODEX_HOME.
3. In the isolated lZ1xAG VS Code window, clear the machine-scoped ai-agents.codex.executablePath setting so the extension uses its bundled Codex CLI instead of the Mock executable. Do not change the normal VS Code profile. Then verify Codex App Server remains selected and start a fresh conversation.

    CODEX_HOME=/private/tmp/ai-agents-gui-acceptance-lZ1xAG/isolated-home/.codex /opt/homebrew/Cellar/node/26.7.0/bin/node /Users/sekiyuuta/Developer/y3162/vscode-extensions/node_modules/@openai/codex/bin/codex.js login

4. Verify login status with the same CODEX_HOME and CLI, then tell me that isolated login is complete. I will run at most two real image-bearing requests: one PNG-only prompt and one text-plus-PNG prompt. For the Retry case, I will inject a local launch failure before the backend receives input, confirm the image is restored, then Retry once and verify the backend receives exactly one image-bearing turn. This is a pre-backend transport failure simulation, not a claim that the service rejected an image. No automatic retry, duplicate send, file edit, or external tool action will be triggered. Queue/session isolation will be checked in the disposable GUI.
5. Login can consume ChatGPT plan usage or quota. A Platform API key could incur separate API charges, so the requested path uses ChatGPT sign-in. After testing, the isolated auth can be cleared with codex logout using the same CODEX_HOME. The auth file will not be opened or copied. The GUI session and unsent records will remain until cleanup is separately approved.

Official reference: https://developers.openai.com/codex/auth/

### Current v1.0.0 decision

NO-GO pending isolated Codex authentication, real-backend image/Retry verification, active ordinary-Turn/Plan/Build Reload, and residual GUI actions. No release or repository commit was made. Official macOS CI must be rerun after a future authorized commit/push; the known success at 188c892f predates this working tree.


### Session identity clarification

The read-only session receipts distinguish the two active disposable GUI sessions. Neither receipt includes copied credentials, and auth.json is absent from both isolated CODEX_HOME directories.

| Session | App / process receipt | Workspace and profile | Backend / authentication | Handling |
|---|---|---|---|---|
| QVC6kt | VS Code 1.142.0 at /private/tmp/ai-agents-gui-acceptance-QVC6kt/vscode-cache/vscode-darwin-arm64-1.142.0/Visual Studio Code.app; receipt PID 40804 | Workspace /private/tmp/ai-agents-gui-acceptance-QVC6kt/workspace; user-data /private/tmp/ai-agents-gui-acceptance-QVC6kt/profile/user-data; shared data /private/tmp/ai-agents-gui-acceptance-QVC6kt/profile/shared-data; CODEX_HOME /private/tmp/ai-agents-gui-acceptance-QVC6kt/isolated-home/.codex | Deterministic Mock; auth.json absent; fixture executable override present | Protected conversation A was not touched; unsent FAIL_TURN and image-a.png remain |
| lZ1xAG | VS Code 1.142.0 at /private/tmp/ai-agents-gui-acceptance-lZ1xAG/vscode-cache/local-disposable-app/Visual Studio Code.app; receipt PID 28937 | Workspace /private/tmp/ai-agents-gui-acceptance-lZ1xAG/workspace; user-data /private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/user-data; shared data /private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/shared-data; CODEX_HOME /private/tmp/ai-agents-gui-acceptance-lZ1xAG/isolated-home/.codex | Deterministic Mock; auth.json absent; fixture executable override present; Codex CLI login status is Not logged in | Selected for Mock GUI work; remains open |

The receipts report PIDs 40804 and 28937, but this sandbox returns permission denied when probing process groups. Active window selection and app paths were confirmed separately through Computer Use. These are not normal VS Code profiles and no cleanup was attempted.
## Authenticated App Server and active Reload retest — 2026-10-18

This record supersedes the earlier authentication-pending status above. Historical Mock and pre-auth results remain unchanged.

### Selected session and authentication

- Session: `lZ1xAG`; root `/private/tmp/ai-agents-gui-acceptance-lZ1xAG`.
- App: disposable VS Code 1.142.0 at `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/vscode-cache/local-disposable-app/Visual Studio Code.app`.
- Workspace: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/workspace`.
- User data / shared data: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/user-data` and `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/profile/shared-data`.
- `CODEX_HOME`: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/isolated-home/.codex`.
- Backend: Codex App Server; Mock `ai-agents.codex.executablePath` override cleared in this disposable profile only; bundled Codex CLI 0.162.1.
- `CODEX_HOME=... codex login status` reported ChatGPT login. Authentication files were not opened, copied, logged, or removed. Authentication remains in the isolated home; no logout or cleanup was performed.
- Extension Host process environment was verified against the same isolated `CODEX_HOME`. No normal VS Code/Codex profile was accessed. QVC6kt and its unsent `FAIL_TURN` plus `image-a.png` remain untouched.

### Real Backend image requests

A metadata-only observer delegated requests to the bundled 0.162.1 CLI. It recorded JSON-RPC method, input item types/counts, synthetic PNG path metadata, file length, and completion status; it did not record prompt text, image bytes, auth, cookies, or tokens. Evidence: `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/tmp/appserver-observer.jsonl`.

1. A new conversation sent one synthetic PNG and no text. App Server received exactly one `localImage`; the turn completed and the UI displayed the Backend answer. **PASS — real Backend.**
2. A separate turn sent text plus one synthetic PNG. App Server received the text and exactly one `localImage`; the Backend answered with the image colors and the UI matched. **PASS — real Backend.**
3. Retry restoration retained the original image, conversation ID, and User message ID. Switching conversations did not leak the image. The single failure injection occurred after local process startup and before forwarding `turn/start`; it was not the requested local process-launch failure. The one authorized manual Send failed at `thread/resume` with `no rollout found`, before `turn/start`. No model inference or duplicate Turn resulted. **Image restoration/isolation: PASS. Local-launch failure: NOT RUN. End-to-end Retry: BLOCKED/FAIL.** No additional Retry was attempted.

This Retry result is not Mock evidence and is not reported as a Backend image receipt: the Backend did not receive the image in the failed Retry attempt.

### Active Reload — real App Server

Reload used `Developer: Reload Window` in the independent lZ1xAG GUI. Each case was reselected from History after the Extension Host restarted.

| Case | Result | Observed after reload |
|---|---|---|
| Ordinary Turn | PASS | Same conversation, Backend Session, and User history; partial Assistant output is Unknown |
| Plan generation | PASS | Plan text/history and Usage remain; Run/Plan is Unknown; Build was not triggered |
| Build execution | PASS | Build is Unknown; test-only target file remains `before\n` with baseline hash; no edit or rerun |
| Queue with one PNG | PASS | Same Queue ID, body and image remain; Queue did not auto-send; Composer draft remains |
| Composer drafts | PASS | Two separate unsent drafts reappeared after Reload |

No unknown execution was marked Completed. Queue and Build were not sent/restarted. The Plan scenario's queued item had drained before Reload, so Queue retention is evidenced only by the separate dedicated Queue case. An ordinary 2,000-word Turn and its later queued item completed before a separate Reload and are not counted as active-Reload cases.

### Remaining GUI and release items

- Plan View display and Build Ready/Building/Unknown UI actions: **PASS — real Backend GUI**.
- Background Terminal operation: prior **PASS — Mock GUI only**; not rerun against the real Backend.
- 300px Copy success indicator, long-code horizontal scrolling, and Composer draft restoration after conversation switch: **NOT RUN** in this retest. The prior six width/theme display matrix was not repeated.
- Host Integration uses its own temporary VS Code app/profile/workspace and fixture Backend; it is not interactive Reload or live service evidence.
- Current v1.0.0 decision: **NO-GO**. The requested local process-launch failure and successful one-time Retry dispatch were not demonstrated; the authorized Retry Send ended before Backend `turn/start`. After future authorized Commit/Push, rerun official macOS GitHub Actions. No Commit, Push, Release, sign-out, or session cleanup occurred.

### Final local regression and artifact audit — 2026-10-18

All commands ran on macOS arm64 at the uncommitted working tree over HEAD `188c892f39695be054b267d2b699453057ebfa64`.

| Check | Result |
|---|---|
| `npm run check` | PASS |
| `npm test` | PASS — 822/822 |
| `npm run test:coverage` | PASS — Lines/Statements 99.75%, Branches 98.83%, Functions 99.79% |
| `npm run test:hygiene` | PASS — 431 assets |
| `npm run build` | PASS |
| `npm run test:integration` | PASS — VS Code 1.142.0, isolated Host Integration with fixture backend |
| `npm run package` | PASS |
| `git diff --check` | PASS |

VSIX `dist/ai-agents-darwin-arm64.vsix`: 1,514 files; 389,151,529 uncompressed bytes; 144,110,947 archive bytes; SHA-256 `2e699714e864c6cde09fb195f6cf226d2b5858166db27f82ab5c26e7f585d126`. No auth.json, .env, private-key header, test paths, source maps, or isolated-session/workspace path markers were found. Six `.d.ts` files under Cursor SDK auth directories are type declarations only. The one key-shaped static literal is in the bundled Codex Mach-O and the byte-identical local package dependency has SHA-256 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`; it is not user auth data.

The initial Integration download failed at DNS resolution; a subsequent run had a transient model-details QuickPick timeout. A fresh official VS Code 1.142.0 app completed every Host Integration assertion. The suite's temporary workspace/profile was cleaned by its own script. The interactive lZ1xAG and QVC6kt sessions were not cleaned up.

The worktree still has the prior uncommitted changes: modified `docs/AUDIT.md`, `docs/MACOS_ACCEPTANCE_RUNBOOK.md`, `docs/VERIFICATION.md`, `package.json`, `src/chat-controller.ts`, `src/sidebar.ts`, `test/sidebar/chat-controller-session-switch.test.ts`, `test/sidebar/sidebar-retry-image-preservation.test.ts`; untracked `scripts/gui-session.mjs`. No package-lock or auth files changed. No commit, push, release, or official CI run was performed.
## Plan/View Plan差分修正と最終受入再確認 — 2026-10-18

この節は本日付の過去チェックポイントより新しい記録です。対象はmacOS arm64、HEAD `188c892f39695be054b267d2b699453057ebfa64` 上のdirty worktree、拡張版 `0.10.0`。Linux検証、Commit、Push、Release、通常profileの認証情報参照は行っていません。開始時から存在したユーザー変更と添付MOVは保持しています。

### 今回の修正

- Plan復元時に、生成中・失敗・停止・不明の旧状態を `ready` として復元しないようにしました。復元後は `unknown` とし、Build対象になりません。既に `ready` または `implemented` の状態は維持します。
- 既存サイドバーに折りたたみPlanカード、実際の本文から作る要約、`View Plan`／`Build`操作を追加しました。`View Plan`は同じサイドバー内に詳細を展開し、本文、公開された生成元、ファイル、To-do、モデル操作を表示します。View Plan自体はBuildを開始しません。
- 会話・Session・Plan IDごとの詳細表示状態を保存してReload後も同じ詳細へ戻し、Composer draftを保持します。`Back to chat`で詳細を閉じるとComposerへ戻ります。既存の計画生成／Build経路やBackendのモード切替契約は表示操作から分離されています。
- 生成元は実際のruntime経路（Cursor ACP `create_plan`、Cursor SDK `createPlan`、Codex App Server plan item、正常完了したAssistant message fallback）に応じて表示します。単なる進行中のPlan本文を完了Planとして確定させるfallbackにはしていません。

### 参照動作の差分表

| 録画／要件 | 現行動作と根拠 | 今回の判定 |
|---|---|---|
| Plan完了カード、View Plan、Build分離 | Mock直接GUIで `Ready to build`、`Plan source: Assistant message fallback`、`View Plan`、`Build`を確認。詳細を開くと同じSidebar内に本文・生成元・Buildが表示され、Composer draftも維持。Buildはクリックしていない。 | **PASS — 直接GUI／Mock** |
| PlanとBuildのBackend状態遷移 | Codex App Server実Backendの統合ケースがPlanを作成、同じSessionで改訂、Agent Buildを1回だけ開始。計画生成中に対象ファイルが編集されず、再度のBuild dispatchも拒否。出力 `provider=codex, backend=app-server, model=gpt-6-luna, revision=2, sameSession=true, duplicateBuildPrevented=true`。 | **PASS — 実Backend** |
| Reload後のPlan表示とdraft | 隔離GUIでDeveloper: Reload Window後、同じMock計画カード、本文とdraft `Draft survives plan navigation`を復元。履歴画面にはFixtureのみが表示されたため、別履歴の選択再開はこのMock会話では確認できていない。以前の認証済みApp Server Reload記録は別根拠として保持。 | 現画面復元 **PASS — 直接GUI／Mock**、履歴選択再開 **NOT RUN** |
| Plan改訂の失敗時に旧版保持、失敗・StopからBuild禁止 | 状態復元の回帰テストPASS。実Backendの改訂成功とBuildは確認したが、実Backend失敗／Stop/Reload各分岐は今回は発生させていない。 | 回帰テスト **PASS — Mock/Unit**、実Backend失敗分岐 **NOT RUN** |
| モデル・設定 | Codexの現在のカタログからAPI ID `gpt-6-luna`（GPT-6-Luna、Effort対応、default medium）を確認し、ライブ実行にも同じIDを使いました。別ID `gpt-5.6-luna`へ代替していません。CursorのComposer 2.5は今回、通常Cursor認証を参照せず現カタログ照合していません。以前の記録値 `composer-2.5`は今回の実測ではありません。 | Codex **PASS — catalog + live**、Cursor **NOT RUN** |
| 使用量・Context Usage | GUIのToken UsageはBackend未報告時に `未取得 / Not reported`。トークン累計からContext占有率や内訳を作っていません。今回の直接GUIではContext Usage詳細の実Backend更新を開いていません。 | 不明値の表示 **PASS — 直接GUI／Mock**、実Backend詳細 **NOT RUN** |
| ツール・推論進行・最終回答 | 今回の実Backendケースでは計画本文・通常完了・Build状態を確認。内部推論を再現せず、Mock GUIで公開Backend要約以外を作りません。実Backendを使ったツール詳細・Thinking時間・UsageのGUI照合は別の既存記録を参照。 | 今回の新規GUI照合 **NOT RUN** |
| To-doとAgent参照 | 作成元の表示をPlan sourceとして分離し、Agent数を捏造しません。To-doと親子状態の結び付けは回帰テスト対象。今回の直接GUI Mock PlanはTo-doを返さず、実Backend Buildの進捗イベントもGUIでは開いていません。 | Source表示 **PASS — 直接GUI**、live To-do進捗 **NOT RUN** |
| Subagent並列実行 | 既存deterministic MockのA/B独立ゲート結果はMock証拠のまま。今回、実Backend並列実行は試していません。 | live **NOT RUN** |
| Background Terminal | 既存Mock/Host記録は実プロセスの生存・Reload再接続の証拠ではありません。今回live Terminalを開始していません。 | live **NOT RUN** |
| 画像・Retry | 以前の同日App Server記録にPNG-onlyとtext+PNGの実送信PASSがあります。Retry画像復元はPASSですが、要求されたローカルプロセス起動失敗は未試験。唯一の手動Retry Sendは`thread/resume no rollout found`で`turn/start`前に失敗し、成功するRetry dispatchを証明できていません。今回は再実行していません。 | 実画像送信 **PASS — 既存当日実測**、Retry **FAIL/BLOCKED** |
| Copy／レイアウト／入力 | 今回、暗色テーマの約300 CSS px SidebarでPlanカードとComposerの折返しを直接表示確認。詳細の表示もAX treeで確認。390px、Light、High Contrast、長文出力の折返し、Copy Clipboard、実IMEは未実施。送信キー割当は変更していません。 | 300px Dark Plan **PASS — 直接GUI**、残り **NOT RUN** |

### 要求・差分・実装箇所・確認方法

| 要求 | 現行動作 | 根拠 | 差分 | 修正箇所 | 確認方法 |
|---|---|---|---|---|---|
| Plan完了後に停止し、完成カードから本文を見る | 成功完了Planをカード化し、詳細は既存Sidebar内に展開。進行中・未確定状態はBuild可能にしない | Mock GUIのReady/Source/View PlanとAX、同じ会話のReload復元 | 今回の欠落は折りたたみカードとPlan source表示 | src/webview/plan-view.ts、app.ts、transcript.ts、strings.ts、styles.css | npm test、直接GUI Mock |
| 初回失敗・改訂失敗・Stop・ReloadでBuild対象を誤らない | 未確定・旧transient状態をunknownへ復元し、直近のsettled版のみready/implementedとして保持 | 状態回帰テスト。実Backend改訂成功ケース | 旧状態の読み込みだけでreadyへ戻る危険を修正。実Backend失敗/Stop branchは未検証 | src/chat-controller.ts、test/sidebar/chat-controller-plan-state.test.ts | npm test。Runtime改訂/Build成功ケースPASS、失敗branch NOT RUN |
| Buildは計画版・Session・モデルを固定して一回だけ開始 | 既存App Server経路で同一Sessionのplan revision後にAgent Build。重複dispatchを拒否 | 実Backend runtime結果 revision=2、sameSession、duplicateBuildPrevented | 今回はUIのView PlanとBackend dispatchを分離。dispatch実装自体の変更なし | Plan UI: src/webview/plan-view.ts。Backend回帰: test/live/runtime.test.ts | 隔離Codex実Backend、gpt-6-luna |
| モデル本体とEffort等を実カタログ/capabilityに合わせる | Codexはgpt-6-lunaを採用。Cursor現カタログは未照合。View Plan内のモデル操作はBuildを明示する | Codex catalog queryとruntime payload、model menu routing test | Cursor Composer 2.5の現ID/payloadは今回の差分として未検証 | src/webview/plan-view.ts、test/webview/model-catalog-menu-routing.test.ts | Codex catalog/live PASS、Cursor NOT RUN |
| UsageとContext Usageを別値で表示 | Backend未報告は未取得と表示し、累計tokensから割合や内訳を推測しない | 直接GUIのToken Usage: 未取得 / Not reported | Context Usage詳細と実Backend内訳の今回照合が残る | 今回の機能差分なし | Mock GUI表示PASS、実Backend詳細 NOT RUN |
| Public progress、tool、To-do、作成元を区別 | Plan sourceを表示し、作成元表示を子Agent数と混同しない。To-doはPlan viewの実データを表示 | 直接GUIのSource。Unit/DOM回帰。live進捗は未取得 | 実BackendのTo-do進捗・ツール詳細の直接GUI証拠が残る | src/webview/plan-view.ts、test/webview/plan-view-build-actions.test.ts | Mock/DOM PASS、live GUI NOT RUN |
| 会話状態・Plan詳細・draftをReload/履歴で復元 | Plan表示状態は会話/Session/Plan IDでscopeし、Reloadで復元。今回は履歴画面がFixtureのみ | 直接GUIでReload後のPlan本文とdraftを確認。履歴一覧の観測 | 別履歴を選ぶ再開は今回のMock GUIで未確認。過去の実App Server Reload結果は別証拠 | src/webview/app.ts、src/webview/transcript.ts、test/webview/plan-view-build-actions.test.ts | Reload現画面PASS、History-selected resume NOT RUN |
| SubagentとBackground TerminalはBackend所有の状態を観測 | deterministic MockのA/Bと既存Terminal履歴を維持。live開始・再接続は今回なし | 既存Mock/Host記録。live証拠なし | 並列子の実Backend結果と同一プロセスReload再接続が未確認 | 今回の差分なし | Mock-only PASS、live NOT RUN |
| 画像、Retry、Clipboard、幅・テーマ・IMEを受入 | 過去の同日記録は画像送信PASS、Retryはdispatch前に失敗。今回300px Dark Planを直接確認 | 当日App Server画像ログ／直接GUI AXと表示／現回帰suite | local process-launch Retry、Clipboard、390px、Light/High Contrast、実IME、長文出力確認が残る | Retry/画像の既存ユーザー差分: src/sidebar.tsとRetry tests。Plan幅要約: src/webview/styles.css | Retry FAIL/BLOCKED、300px Dark Plan PASS、残りNOT RUN |

### 今回の検証結果

| 検査 | 結果 | 実測の範囲 |
|---|---|---|
| `npm run check` | **PASS** | Extension/Webview型・静的検査 |
| `npm run build` | **PASS** | Extension、Webview、Cursor workerを生成。package/integrationでも再実行 |
| `npm test` | **PASS — 823/823** | Mock/Unit/Webview回帰 |
| `npm run test:coverage` | **PASS** | 現行suite全体 |
| `npm run test:hygiene` | **PASS — 432 assets** | Hygiene |
| `npm run test:integration` | **PASS** | macOS arm64、公式VS Code 1.142.0、隔離app/profile/workspace、Mock fixture Host Integration |
| `npm run package` | **PASS** | Darwin arm64 VSIX 1,514 files、144,111,673 bytes、SHA-256 `caa6ac956ca44e19222e86b8c165e26617c62d89b156d237a0936e7b225ddc4f` |
| `git diff --check` | **PASS** | 実装差分のwhitespace確認 |
| Codex App Server Plan改訂→Build | **PASS** | 同日isolated `CODEX_HOME`、実Backend、`gpt-6-luna`。このケースはUIではなくruntime統合試験 |

生成したVSIXのentry pathを走査し、1,514件中 `test`／`tests`／`__tests__`、`auth.json`、`.env`、source mapに一致する名前は0件でした。これはentry名の検査です。VSIX全内容に対する秘密値や一時パスの再走査は今回行っていません。

### GUI環境と証拠の境界

直接GUIは `/private/tmp/ai-agents-gui-acceptance-Lq8H0J` の隔離環境で実施しました。アプリは公式VS Code 1.142.0、workspace `/private/tmp/ai-agents-gui-acceptance-Lq8H0J/workspace`、user-data `/private/tmp/ai-agents-gui-acceptance-Lq8H0J/profile/user-data`、extensions `/private/tmp/ai-agents-gui-acceptance-Lq8H0J/profile/extensions`、shared-data `/private/tmp/ai-agents-gui-acceptance-Lq8H0J/profile/shared-data`、Codex Home `/private/tmp/ai-agents-gui-acceptance-Lq8H0J/isolated-home/.codex`。実行前にアプリ、起動receipt、パス、拡張版0.10.0を照合しました。`credentialsCopied=false`で新profileに認証を追加していません。GUIのPlan応答はdeterministic Mockであり、実BackendのGUI結果ではありません。ワークスペース信頼の設定後にテストを続行しました。

このターンのruntime実Backend試験は隔離Codex Homeを使い、`CODEX_API_KEY`／`OPENAI_API_KEY`を環境から外し、Codex CLI/App ServerのChatGPT認証を利用しました。試験報告に含めた値はモデルID・revision・Session同一性などの構造メタデータです。認証ファイルや秘密値を表示・コピーしていません。

### 残る受入項目と判定

- **NOT RUN:** 実Cursor Composer 2.5の現カタログ取得と要求payload確認。
- **NOT RUN:** Light/High Contrast、390px、実IME、300pxでのClipboard Copy、長いコード／Tool出力の水平制約。
- **NOT RUN:** 実BackendのBuild失敗・Stop・To-do進捗を直接GUIで検証。
- **NOT RUN:** live Subagent並列処理とBackground Terminal実プロセス／Reload再接続。
- **FAIL/BLOCKED:** 実画像Retryの安全なローカル起動失敗→手動1回dispatch。前回の手動送信はBackend Turn開始前に停止し、再試行していません。
- **NOT RUN:** 今回変更後の公式GitHub Actions。現HEADからのCommit/Pushが無いためローカル実測とは分けます。

修正実装と現在の回帰チェックは完了しましたが、必須の直接GUI・実Backend項目が未確認です。v1.0.0の受入判定は**NO-GOを維持**します。Commit/Push/Releaseや一時GUI sessionのcleanupは行っていません。

## 実GUI＋実Backend受入 — 2026-10-19 JST

### 環境と境界

開始・終了HEAD `188c892f39695be054b267d2b699453057ebfa64`、拡張 `0.10.0`、macOSのみ。公式VS Code 1.142.0アプリは `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/vscode-cache/local-disposable-app/Visual Studio Code.app`。隔離user-dataは `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/acceptance-20261019/profile/user-data`、extensionsは同profileの `extensions`、shared-dataは同profileの `shared-data`、各workspaceStorageは同profileの `user-data/User/workspaceStorage`。隔離認証済み `CODEX_HOME` は `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/isolated-home/.codex`。GUI表示は `GPT-6-Luna`、Codex App ServerはCLI 0.162.1、要求上のモデルIDは `gpt-6-luna`。短いテキストGUI送信を先に通して実Backend接続を確認した。通常VS Code/Cursor profile、実研究workspace、Linuxは使用していない。認証値は参照・複写していない。test-only CLI wrapper、metadata observer、合成PNG、待機gateは全て `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/acceptance-20261019` 内に置き、`tmp/backend-metadata.jsonl` と `tmp/launcher-events.jsonl` は構造metadata/one-shot markerのみ記録して、prompt本文、credential、画像base64を含まない。test-onlyファイルはextension source/packageへ含めていない。

前回記録の `thread/resume no rollout found` は、プロセス起動後・RPC転送前に故障を注入した試験準備上の誤りと確認した。今回の初回ローカル起動失敗は本物のCLI起動前にone-shot gateがexit 73し、専用markerを1回記録した。wrapperは次回以降のargv/environmentを本物のCodex CLIに渡すだけで、protocol stdoutを変更しない。失敗・Retry試験のlogにはprompt本文、credential、画像base64を保存していない。旧FAIL記録は履歴として残し、本追記が最新の試験条件である。

### 1. 画像Retry／dispatch前失敗

| 試験 | 結果 | GUI・Backend証拠 |
|---|---|---|
| GUIから短い通常text送信 | **PASS — 実GUI＋実Backend** | local conversation `5f47c77b-c7f7-4c66-9cd6-6c19abc823a3`、Backend Session `01a14f8f-e8b8-7b71-b10c-62ade65778bd`、Turn `01a14f8f-e989-7870-bd30-dfc44652aea0`、`gpt-6-luna`。GUIに回答。Usage 13,849 input / 11 output / 13,860 total |
| 画像のみ、armed launcherの最初の起動 | **意図した失敗を1回注入 — GUI＋実Backend起動境界** | conversation `4c80c939-461d-4a99-915a-d4c88933c698`。local failed turn/message `15d1e927-3c66-4b6d-a0d8-e125502993b2`、エラー表示 `c7122e7a-20da-462f-8c97-e415f71b47de`。marker/count=1、exit 73、実CLI child起動なし、Backend `turn/start`受理0 |
| GUIのRetryボタン | **PASS — 実GUI復元** | Retryを1回押すと元画像が同じ会話のComposerへ戻った。Retry自体は自動送信しない設計を確認。本文/添付draftを照合し、別会話から画像を流用していない |
| Retry後のGUI Send | **PASS — 実GUI＋実Backend** | GUI Sendを1回実行。Backend Session `01a14f91-d110-73d2-b907-e4da129f7faa`、受理・完了Turn `01a14f91-d180-7ed0-8790-c3b40e30cc9b`、`gpt-6-luna`。localImageは1件、MIME `image/png`、176 bytes、SHA-256 `c9a7c2bf14f6634983265524f47fcc9b94dc412491f4f4f9f19de66a4369f0f1`。UI final 1件、重複user/turnなし。Usage 13,887 input / 45 output / 13,932 total |
| text＋同じPNG | **PASS — 実GUI＋実Backend** | Session `01a14f92-92a9-7ce3-89ce-db62f4fbc8be`、Turn `01a14f92-930a-72d2-acff-20b2fc1e8451`、`gpt-6-luna`。text 109 chars、上記と同じhashのPNG 1件が受理・完了。Usage 13,907 input / 10 output / 13,917 total |

PNG-onlyとtext+PNGはいずれも同日の別既存GUI会話でもPASSだった。本試験では画像ファイルを実際のAttach file pickerで合成PNGから添付した。Paste/Clipboard貼り付けを行っておらず、Clipboard acceptanceには数えない。失敗時にauto-send、受理済みturnの再送、遅延結果のdraft上書きは見られなかった。Backend Sessionは失敗した起動より後に作られたため、存在しない初回Session IDの一致は要求していない。

### 2. Plan → View Plan → Build完了

実験workspaceは `/private/tmp/ai-agents-gui-acceptance-lZ1xAG/acceptance-20261019/workspace`。README等だけを置き、Build前に成果物 `gui-plan-build-result.txt` が無く、README SHA-256 `59af6cb712e53042b9d616dda82fe967cd5c6efa3891e77b75101c115ebe3fa8` がBuild後も維持されていることを確認した。GUIでPlanを送り、Plan完了時に `Ready to build` で停止した。折りたたみカード、`Plan source: Codex App Server plan item`、`View Plan`、To-doを表示し、同じsidebar内で開閉した。開閉時もunsent draftは保持された。GUIから計画を1回改訂しrevision 2で停止した。View Planにもrevision 2が表示され、その内容はBuild前に対象workspaceを変更しなかった。

| 項目 | 実測 |
|---|---|
| GUI local conversation | `c0e701cd-c82b-4dbb-8ef3-9d5a61aa394e` |
| Backend Session/thread | `01a14f93-3626-76f3-8f93-50154608e408` |
| Plan ID / 有効版 | `ab1283cf-97f1-4084-a675-05c6741c4a7a` / revision 2 |
| Build選択モデル | GUI `GPT-6-Luna`、App Server要求 `gpt-6-luna` |
| 明示Build | GUIボタンを1回押下。Building表示。Build intentは内部Agent modeで、App Server `collaborationMode=default` |
| Build backend Turn | `01a14f94-2052-7370-937b-e8e238e1c6fd`。同一Sessionへ1回accept/start/completed |
| 成果物 | `gui-plan-build-result.txt`、内容 `plan-to-build passed.`、21 bytes、SHA-256 `3dd40677e65807de6b4d821848eea8c731af73bc636749e981bf52f60e08ebe0`。README不変 |
| 完了後 | GUIはBuild finished/implemented、Build無効。Historyから同じ会話を再表示してもBuild可能なreadyへ戻らず、再dispatchなし |

GUI Usage表示と出所：最初のPlan 30,549 input / 275 output / 30,824 total、改訂 16,961 / 78 / 17,039、Plan合計 47,510 / 353 / 47,863。Build 35,805 / 213 / 36,018、Session総計 83,315 / 566 / 83,881。Context token breakdownはGUI/Backendから未取得。Backendの構造化To-do進捗も未報告。Plan文中には `[ ]` checklistが表示されたが、Build後に完了チェックを捏造していない。実Build Turnは一回だけで、Build終了回答・成果物と実装済み表示を確認した。

### 3. 実行中Reload — 3つの独立workspace/conversation

ケースごとに合成READMEと独立したwait gate（deadline 120s、workspaceへ副作用なし）を用意した。実際に `turn/started` と実行中shell commandを観測してから、隔離GUIの `Developer: Reload Window` を実行した。Reload後はHistoryから同じ会話を選び直し、App Server `thread/resume` と状態を照合した。以下の各IDは隔離 `workspaceStorage` のsession index/local conversation IDとApp Server metadataを対応させた。message IDはExtension UI/observerが独立のmessage-ID列として公開しないため、GUIの表示履歴1件とBackend turn/itemの受理・完了イベントを照合している。

| 対象 | Reload前の受理・実行証拠 | Reload後の会話／状態／副作用 | 判定 |
|---|---|---|---|
| 通常Turn | local conversation `b624ac0b-29cf-483b-9f41-d9c7c51517d6`、Backend Session `01a14f9b-49fd-7500-9f56-01ea118633e0`、Turn `01a14f9b-4ab7-7480-9df9-187d87a7a00c`、model `gpt-6-luna`。`turn/started` 15:22:19.732Z後、`python3 .acceptance/wait_gate.py ordinary` 実行中にReload | 旧App Server PID 74462 exit 0 at 15:22:40.990Z。新PID 74671が同Sessionへ `thread/resume`。Turn completed/Finalなし、gate processなし。Historyの1 user row・shell cardを表示し `Run state unknown after reload`、Usage `Not reported`、composer draft空。README hash `fde593b6cee9c47afea717832b13af3f2ea5a94f8d1e31f135276a495b195eee`維持、queueなし | 状態復元 **PASS**、継続・再接続完了 **NOT CONFIRMED** |
| Plan生成 | local conversation `9ce6b16b-5010-4524-b533-d1ab63030c63`、Session `01a14f9e-04b4-7521-bff3-cb75c18dd80f`、Turn `01a14f9e-056e-7ca1-a94b-963f1ecad377`、model `gpt-6-luna`、`collaborationMode=plan`。`turn/started` 15:25:18.607Z後、gate command実行中にReload | PID 75574 exit 0 at 15:25:34.074Z、新PID 75808が同Sessionをresume。same Turn completedなし。UIの部分Assistant文と元User rowを保持し、`Run state unknown after reload`、新Plan ID/revisionなし、Buildなし、Usage未報告。README hash `5e50788ebe6600383fa04997928c510936c1da929ac574a60810a33728e51662`維持、成果物なし | Unknown表示・再Build防止 **PASS**、Plan生成継続 **NOT CONFIRMED** |
| Build実行 | local conversation `fd0e25d0-e04e-4247-b286-5794698e81f1`、Session `01a14f9f-a656-7e30-8073-2c9bc4a7470b`、Plan完了Turn `01a14f9f-a6f7-79a0-b332-928cdd1b4d84`、Plan `9af398d3-26d6-42ac-b43a-7cbf73ec5663` revision 1。Build Turn `01a14fa0-ed8f-7aa0-9327-6eafbbbdde5a`、model `gpt-6-luna`、`collaborationMode=default`。`turn/started` 15:28:29.089Zと `python3 .acceptance/wait_gate.py build` 生存を観測後Reload | PID 76239 exit 0 at 15:28:40.084Z、新PID 76789が同Sessionをresume。Build completed/Final/usageなし、wait gate processは消失。Historyに同一Plan ID/revision 1とBuild commandを表示し `Run state unknown after reload`、Plan state could not be checked、Build無効。README `95edd4d4de965e6a31f5a9c96cd171b9c06ea78d06b96f15f833de37ccd90983`不変、`build-reload-result.txt` absent、queueなし | safe Unknown復元・二重Build防止 **PASS**、Build継続 **NOT CONFIRMED** |

3件ともExtension Host Reloadで旧App Server childが終了した。新App Serverのresume応答はthread IDを返したが、元Turnが続いていることを示す終端イベントは無く、実行継続をPASSとしない。各wait gateはreload後に実プロセスが存在しなかったため外部release markerをtouchしてcleanupした。Reload復元によるprompt/command/Buildの自動再送はなし。最終回答の重複なし。通常/PlanのUsageは未取得、Buildでは事前Plan usage表示のみ残り、Build usageは未報告。User draftは3ケースとも送信後空であり、draft残存の受入は該当しない。Queue、子Agent、Background Terminalはいずれもこの3ケースで作っていないため検証対象外。

この試験は「unknown/disconnectedを推測せず表示」する安全性を確認したが、実行継続・Backend再接続は必須未達として次回受入に残す。安全な表示と処理継続の成功を同じPASSとして扱わない。

### 未受入項目とリリース

次バッチ優先順：1) Reload中にApp ServerのTurn/Plan/Buildを継続し、同一IDの終端状態・tool output・UsageとGUI復元を照合する（現状は継続未確認）。2) Cursor Composer 2.5の現カタログとCursor経路。3) 300/390 CSS px × Dark/Light/High Contrast、実IME、Clipboard copy、長出力。4) live Subagent並列とBackground Terminalのstdout/生存/stop/reconnect。5) live Context breakdown/To-do進捗。今回のBuild中Reloadはlive To-do未取得である。

今回production/package source変更なし。以前の同一sourceに対するmacOS check/build/823 Unit/Webview/coverage/hygiene/Host Integration/package PASSを継承し、同suiteを重複実行していない。今回追加の検証は3つの実GUIシナリオとmetadata、`git diff --check`。VSIX再package対象の変更なし。dirty user changesとMOV/helperを保持し、Commit/Push/Releaseをしていない。v1.0.0は**NO-GO**を維持する。

## 2026-10-19 v1.0.0管理実行の再開手順

現行コードはCodex App Serverのstdio所有をmacOSの管理プロセスへ移した。profile/workspace/conversationの識別、0700 directory/0600 token+Unix socket、単一接続、run ID照合、明示Stop/dispose、10分の無接続cleanup、16MB保持上限を持つ。通常/Plan/Buildのruntime直接試験と7回帰は通過した。実行Unknownのfallbackも保持する。

最新版の固定要件は[V1_ACCEPTANCE.md](V1_ACCEPTANCE.md)。実GUI/最終VSIXの成功とruntime直接試験を混ぜない。現在NO-GO。

1. `dist/release-1.0.0-darwin-arm64/SHA256SUMS`と候補VSIXの一致を確認する。専用app、空profile、専用extensions/shared-data directory、合成workspace、許可済み隔離認証を用いる。通常profileへ戻して解決しない。
2. installed ID/version/path/activeの確認は済んだが、installed Webview readyはfalseで専用appへのComputer Use接続もtimeoutした。このUI接続条件を解決してから直接GUI受入を再開する。試験driverのAPI操作を手動GUIクリックの証拠にしない。
3. 通常Turn/Plan/Buildそれぞれ独立workspace・会話で、Backend受理/command開始と未完了Turnを観測してReloadする。stdout待ちだけではタイミングが取れない場合がある。Reload前後のowner/App Server PID、会話/Session/Turn/message、Plan ID/版、Usage、Queue/draft、ファイルhashとイベント数を照合する。promptやcommandを再送しない。
4. Plan停止→View Plan→モデル設定→明示Build、live子A/B・親Waiting、Terminal初期/追加stdout/終了/Terminate/Stop/Reload、6幅themeセル、実IME/Clipboard、画像/Retry、Usage/Context/To-doを最終bytesで受入する。
5. 隔離Cursor CLI/SDKは未ログイン。SDK catalog取得は認証不足で停止した。ユーザーが隔離認証を完了したらComposer2.5の現ID、既定SDK経路と失敗経路を再開する。API keyへ代替しない。
6. 同梱CLI0.162.1から生成した実schemaにはturn/plan/updatedとtotal/last/modelContextWindowがある。live To-do要求では通知を観測できず、未調査の一般的非対応へ言い換えない。last.totalTokensはContext占有率の証拠に使わない。
7. 旧0.10.0実VSIXを使って更新前の合成会話/draft/Planを作り、対象storageのみをbackupして実更新・失敗時再試行・復旧を試験する。現時点ではNOT RUN。
8. 全suiteの13件は一時Git fixture setupをguardが拒否している。禁止操作を再度許可して通さず、禁止操作を伴わないfixture前提を整える。skipでGOにしない。最初の無guard実行で禁止操作を動かした事実はVerificationの手順違反節に記録した。

生成候補とsource manifest/receiptはローカルのみ。Git/publicationはユーザーが担当する。今回、製品repoのHEAD/branch/stageは維持したが、一時fixture内を含む「禁止Git操作なし」の宣言はできない。

追加の再開対象: 実Subagentのruntime遷移と親Final1件は確認済みなので、同じ条件をinstalled GUIで詳細/折りたたみ/draftを含め受入する。Terminalの同一process再接続・追加出力・Terminateはruntime確認済みだが、初期stdoutが観測したcommand通知/listから欠落した。初期stdoutの正式な取得経路を解決し、自然終了・親Stop・実行中Reloadも確認する。初期stdout FAILを「既知制約」として受入から外さない。


## 2026-10-19 JST 再開後の最終bytes受入（未コミット）

最終VSIXは`ai-agents-1.0.0-darwin-arm64.vsix`、144,142,863 bytes、1,518 entries、SHA-256 `4202d076c1c4b9851c5fa3d7c4b6067a6bf17eb504f6153be31b9645c6b72c90`。
**判定はNO-GO**。以下のPASSで、表の他の必須FAIL/NOT RUNを相殺しない。
資料更新前の候補`28ce83b9…`と、資料更新後のこのbytesを区別した。
資料更新後にインストールし直し、通常/Plan/Buildの実行中GUI Reloadをすべて再試験した。

| 実GUI＋実Backend＋最終VSIX | Session | Backend Turn | owner / App Server PID | Final |
|---|---|---|---|---|
| ordinary PASS | `01a15118-1347-7b71-bc7f-a80bd1543b0b` | `01a15118-1398-7233-af4c-b99a2764abda` | 22145 / 22149（前後同一） | 1 |
| plan PASS | `01a15118-bef9-7cc3-9783-5400ecb7bdb6` | `01a15118-bf36-73c0-a74e-bcf85e7e4f15` | 22476 / 22478（前後同一） | 1 |
| build PASS | `01a15119-d2f3-7602-ac3d-8c501fcbaaa9` | `01a1511a-3ffb-7c02-968e-5c903c39dc4d` | 22848 / 22850（前後同一） | 1 |

各ケースは別の合成workspace・会話。Backend受理と実Python待機プロセスを確認後、完了前にGUIのReload Windowを実行した。
Extension Host PIDは変化し、元のowner・App Server PID・local Turn ID・Backend Turn ID・Sessionを保持した。
復帰時もrunningかつ成果物なし。その後に外部ゲートを解放し、同じTurnがcompletedになった。
通常/Buildの成果物は`installed continuity passed.\n`の29 bytes（SHA-256 `2a94ec653437404acf0709996049833797df02d3e6d175de9f5dea173a00e6bd`）。
Planは成果物なしでready。Buildは同じPlan ID/版のままimplemented、GUIではBuild finished・Build無効。
各Queueは1件を保持し、別Turnの自動dispatchなし。各Composer draftもReload前後で一致した。
Usageの照合値、message ID、プロセス一覧、Plan全状態はreceiptを参照。実在しない子/Terminalの検証はこの3ケースへ含めない。

実装修正: 親のstream deltaに親threadIdをsubagentIdとして渡していた箇所を修正した。親本文とstdoutが存在しない子へ流れない回帰を追加。
Gitを変更していたUnit fixture setupは、実ファイル＋明示的なGit応答mockへ置換した。Git実行ファイルとの統合PASSを主張しない。

Keychain修正: 専用GUIランチャーとHost Integrationに`--use-inmemory-secretstorage`を追加。
古い設定の隔離アプリを終了し、以降の起動/ReloadでCode Keyダイアログなし。通常Keychainの削除・初期化・権限変更はしていない。
`--password-store`による平文保存への切替もしていない。試験用SecretStorageはメモリ内、許可済みCLI認証の内容は出力/複写していない。

最終bytesの0.10.0実VSIXからの更新はPASS。会話/Session、Plan ID/版/ready、完了Turn、Usage、日本語draftを保持。
更新前のUser/storageを13ファイルのhash付きでバックアップし、戻しての1.0.0再試行をPASS。
旧VSIX＋旧バックアップのダウングレードもPASS。1.0.0が新規保存した全状態を0.10.0が読めるという判定ではない。

実macOS Kotoeri日本語入力は、native keyの`nihongo`→未確定`にほんご`→Spaceで`日本語`→Return確定を確認した。
確定Enterで送信・Plan改訂・Usage増加はなし。Shift+Returnで改行、変換中のモデルメニュー、履歴へ戻ってのdraft保持も確認。
既存仕様は「本文draftはComposer全体で保持、画像draftは会話ごと」。新規会話への本文draft保持を仕様変更していない。
本文CopyはGUI Copy→native Command+VでComposerへ同じ本文を貼り付けてPASS。コードCopyと画像ClipboardはNOT RUN。
IME確定/改行/メニュー・本文Copyは資料更新後の最終bytesでも再確認した。

Cursorは隔離CLIのfile credential storeでログインし、現在のカタログID`composer-2.5`を確認。
ACPで2送信・同じSessionの履歴再開・Stop AbortErrorをruntime直接確認した。2送信目の文言は指定した単語だけにならず、応答内容の厳密一致PASSにはしない。
SDK 1.0.37の公開型`SdkLoginOptions`/`SdkLoginResult`/`StoredSdkCredentials`は標準loginがAPIキーを発行する経路である。
CLIログイン後もSDKカタログは未ログインで停止した。今回APIキー発行/課金への切替は実行していない。既定Cursor SDK主経路の必須受入はブロックしたまま。

App Server 0.162.1生成型では`ThreadTokenUsage`はtotal/last/modelContextWindow、内訳は入出力/cached/cache-write/reasoning/total。
Contextの占有量・system/tool等の内訳とは別物で、占有率を作らない。`TurnPlanUpdatedNotification`は存在するが、以前のlive要求では通知0件。
構造化To-doのlive GUI受入は未完了。Terminal初期stdoutも前回の実stream/listでは欠落、completed時にaggregatedOutputへ現れた。
これは未解消のFAILであり、Backend全般の能力欠如という結論へ広げない。

receipt: [../dist/release-1.0.0-darwin-arm64/20261019-final/](../dist/release-1.0.0-darwin-arm64/20261019-final/)。基準HEAD、source入力manifest、lockfile hash、Git差分・stage保持、ツール版、内容監査を同梱する。


### 最終Host検証と試験上の失敗の扱い

メモリ内SecretStorageフラグを加えた最終Host IntegrationはPASS（公式VS Code1.142.0、Host Node24.21.0、macOS arm64、Node22.23.3 launcher）。隔離app/profile/workspaceと全assertion完了のreceiptを取得した。
最初のフラグ追加後runはモデルQuickPick待ちでtimeoutした。同時に別の専用GUIを操作していたためフォーカス干渉が疑われ、GUI操作を重ねない独立runで通過した。確定した製品不具合という判定にはしていない。
最初のinstalled試験はtest runnerがReloadで終了したため、その実行の成功を最終bytesの受入へ流用していない。
資料更新後の最初の起動もVSIX再インストール完了前の試験準備として中止し、別workspaceのordinary-final-v2で再実施した。
採用した最終3ケースはordinary-final-v2 / plan-final / build-finalのみ。

最終check（Node22/26）、831件全suite（Node22/26）、coverage（831件、Statements/Lines99.26%、Branches98.18%、Functions98.06%）、hygiene443、build、packageはPASS。
Node22での再試験はCIのNode22系との整合のために実施。資料追記だけで同じ全suiteを繰り返していない。
今回のguardが拒否したGit fixture起動は、実行成功として数えていない。初回の拒否を確認した後、fixtureをMockへ置き換えて全suiteを完走した。
過去の禁止Git操作違反を記した節は歴史記録として保持する。今回のGit HEAD/branch/stage比較は最終receiptを参照。

### 2026-10-19 Candidate 2: native GUI再試行の結果

対象bytesは`27f1a452cfbde272f9683aa1f9832fef55834401b4b6ef047a56171ab3fed46f`。最終VSIXは`/private/tmp/ai-agents-vsix-final-20261019`配下の専用profileへCLI installし、ID/versionと1515 payload filesの一致を確認した。GUI appはこのprofileで起動しておらず、activation/ready/screenshotは観測していない。

CUAのsurface inventoryでは通常の`Code`と`Cursor`アプリは見えたが、既存の使い捨てVS Code windowをpath別に選択できなかった。`/private/tmp/ai-agents-gui-acceptance-Lq8H0J/vscode-cache/local-disposable-app/Visual Studio Code.app`を直接指定した`getApp`は約5秒後に`server error -10005: timeoutReached`となった。この試行でUI自動化段階の失敗を確認したため、通常Code/Cursorを選択する操作や同じ呼出しの反復は行わず、native GUI項目をBLOCKEDにした。

別の隔離アプローチでは、`/private/tmp/ai-agents-gui-acceptance-yUJXgx`内の使い捨てVS Code 1.142.0を`VSCODE_EXECUTABLE_PATH`でExtension Host Integrationへ使用した。Webview ready handshakeとintegration assertionsはPASSし、profile/workspaceは一時ディレクトリ内で破棄された。これはsource + Host + Mock Backendの結果で、native GUIやlive Backendの証拠ではない。

この実測の間、通常profile、通常Keychain、研究workspaceは操作せず、既存のGUI session processは停止していない。次回は最終VSIX profileをCUAから選択できる状態にしてから、command `AI Agents: Open Sidebar`を実行し、Webview readyを観測する。認証済みBackendが隔離profileにない場合は、GUI smokeから切り離してBLOCKEDのままにする。詳細な最終判定は`docs/V1_ACCEPTANCE.md`のCandidate 2表とreceiptを参照する。

### 2026-10-19 Candidate 2: VSIX payloadのHost activation追試

上記のCUA試行後、同じ候補SHAのCLI install先にある`y3162.ai-agents-1.0.0`を`AI_AGENTS_TEST_EXTENSION_PATH`へ指定し、`npm run test:integration`を実行した。隔離VS Code 1.142.0 / Extension Host Node 24.21.0で拡張がactivateし、sidebar Webviewのready handshakeと統合assertion全件がPASSした。receiptのExtension Host pathは同じ展開済みVSIX payloadを指し、対象SHAは`27f1a452cfbde272f9683aa1f9832fef55834401b4b6ef047a56171ab3fed46f`。ログは`/private/tmp/ai-agents-installed-vsix-host-final.log`。

`test-integration.mjs`はこのpathを`--extensionDevelopmentPath`として渡すため、この結果はVSIX payloadのHost activation証拠として記録し、VS Codeが通常のextensions directoryから導入済み拡張を自動検出して起動する試験とは区別する。試験runnerはGUI統合assertionを実行したが、CUAでの画面表示やnative操作、live Backend、6条件layoutは観測していない。これらの項目は引き続きBLOCKED/NOT RUN。


### 2026-10-19 Candidate 4: installed VSIX native GUI / Mock evidence

対象VSIXはSHA-256 `cd661494fbddfda99887cfa8f0b6d12b1ac0c92dad205bf4bc530bf1a6cd6a2a`。VS Code 1.142.0の使い捨てapp bundle `/private/tmp/ai-agents-gui-acceptance-yUJXgx/vscode-cache/local-disposable-app/Visual Studio Code.app`を使用し、user data、extensions、shared data、workspace、HOME、CODEX_HOME、CURSOR_HOME、TMPDIRは`/private/tmp/ai-agents-vsix-final-20261019-candidate4/`配下へ隔離した。Candidate 4を通常の隔離extensions directoryへCLI installし、installed path `/private/tmp/ai-agents-vsix-final-20261019-candidate4/extensions/y3162.ai-agents-1.0.0`、Webview URLの`extensionId=y3162.ai-agents`、`Ready`状態を観測した。通常Code/Cursor profile、通常Keychain、研究workspaceは使用していない。

最初のGUI試行は`ai-agents.codex.executablePath`をworkspace設定だけへ置いた。VS Codeはmachine-scopeのため無視し、bundled Codex App Serverを選択した。無認証の隔離`CODEX_HOME`上でsynthetic requestが開始されたが、すぐStopし、managed owner status `cancelled`を確認した後、認証済みcontrol socketから`dispose`を要求してownerとApp Serverを終了した。この結果は実Backend受入へ数えていない。再発防止として、同じ隔離VS Code user dataの`User/settings.json`にmachine-scope executable pathを置き、`fixture-bin/codex-app-server`がMock fixtureを呼ぶ設定へ変更した。二度目はnative UIで`app server`のMock応答を表示した。

Installed GUIのMock Terminal fixture `EARLY_TERMINAL_OUTPUT`では、Terminal row `python3 -u script.py · running`、出力`EARLY_READY`、完全性警告を確認した。これはBackend processを起動しないfixtureで、実process IDやstdout bytesのlive受入ではない。TerminateをクリックするとTerminal rowと警告が消えた。

同じMock会話で`MANAGED_RELOAD_GATE`を送り、`managed-dispatches.txt`に`managed-held-turn`が一度記録されたことを確認してから、Developer: Reload Windowを実行した。Reload後はWebview readyとなりNew chatが表示されたため、Historyから元の会話を再選択した。managed worker PID `92845`はReload中も生存し、その後isolated workspaceの`managed-result.txt`には`once`が一度だけ記録された。History再表示では状態`Ready · in 11 / out 3`と最終文`Same execution completed.`を一度確認した。これはInstalled Candidate 4 + native GUI + Mock BackendのReload継続結果であり、live Backendの証拠ではない。

Planモードを選びMock gateを送信する試みも行ったが、Candidate 4 GUI上で確定したView Plan本文とBuild操作を確認できなかった。Plan GUIはPASSとせず、受入表のPARTIALを維持する。Dark themeで画面を視認したが、CSS widthを固定測定せず、6-cellの各指定コンテンツも確認していない。IME、実Clipboard、画像、Queue/Retry、Subagent詳細、Usage/Contextのlive表示は未受入。

隔離VS Code終了後、managed ownerを認証済み`dispose`で停止し、対象processが終了したことを確認した。GUI screenshotはComputer Use画面上で視認したが、receiptへ画像ファイルとして保存していない。CLI install、Host Integration、archive integrityの機械可読ログはCandidate 4 receiptを参照する。
