# Webview visual and interaction fixtures

This harness loads the production `dist/webview` bundle and supplies synthetic Host protocol messages. It never starts a provider, reads credentials, or uses a normal VS Code profile.

From the repository root:

```sh
npm run test:ui
```

Requires Node with the built-in WebSocket client and a locally installed Chrome/Chromium. On macOS the default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; elsewhere it is `chromium`. Override with `CHROME_PATH`.

The command builds the extension, serves the fixture on loopback, creates a disposable Chrome profile, captures the matrix, performs independent browser interaction checks, and closes that profile. Evidence defaults to `extensions/ai-agents/docs/evidence/ui-redesign/after/` (ignored by Git).

The default matrix is 22 scenes × 3 widths × 3 themes × 2 languages = 396 screenshots at 800px height. Each scene has a contact sheet. `index.html` links to the original PNGs. `report.json` records runtime errors, frame widths, horizontal overflow, controls outside the viewport, and sampled text contrast. `functional.json` records browser checks separately. A detected layout/contrast/runtime failure or failed interaction exits nonzero. This is a diagnostic baseline, not a perceptual screenshot diff or complete accessibility audit.

Configuration:

| Variable | Default / purpose |
|---|---|
| `UI_CAPTURE_OUTPUT` | Ignored evidence directory |
| `UI_CAPTURE_SCENES` | Comma-separated scene names |
| `UI_CAPTURE_WIDTHS` | `300,390,520` |
| `UI_CAPTURE_THEMES` | `dark,light,hc` |
| `UI_CAPTURE_LANGUAGES` | `ja,en` |
| `UI_CAPTURE_HEIGHT` | `800` |
| `UI_CAPTURE_SHEETS=0` | Skip contact sheets |
| `UI_CAPTURE_FUNCTIONAL=0` | Skip browser interaction checks |
| `UI_CAPTURE_BUNDLE` | Alternative local bundle directory for Before captures |

For a focused run:

```sh
UI_CAPTURE_SCENES=approval,model-list UI_CAPTURE_WIDTHS=300 UI_CAPTURE_OUTPUT="$PWD/tmp/ui-preview-check" npm run test:ui
```

For manual exploration, serve the repository with a local HTTP server and open `extensions/ai-agents/test/ui-preview/index.html`. Query parameters: `scene`, `width`, `height`, `theme`, `lang`, and `stress=1` for long session/model labels. Supported scenes are listed in `preview.js` and `capture-ui.mjs`. `empty` is an empty Chat; `empty-home` has no history. Model and mode menus are opened by the harness through the actual production controls. `previewPosts` records outgoing mock Host messages; it is available only in this test harness.

The Dark/Light/HC colors are representative browser theme fixtures. Native VS Code themes, OS IME composition, screen readers, real provider authentication, and live inference require separate validation. Do not interpret synthetic composition events as an OS IME test.
