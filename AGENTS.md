# Repository guidance

- This repository contains two extensions. AI Agents uses the root npm workspace; File Icons is independent and uses pnpm in `extensions/file-icons`.
- For AI Agents, run the relevant checks from the root: `npm run check`, `npm test`, `npm run test:coverage`, and `npm run test:hygiene`. The CI also runs build, integration tests, and packaging. Integration tests require VS Code; live tests require authentication and may consume usage.
- For File Icons, run `pnpm lint`, `pnpm typecheck`, `pnpm integrity`, and `pnpm build` from `extensions/file-icons`. Preview generation additionally needs Chrome and Catwalk.
- Keep credentials, local machine settings, generated artifacts, and real conversation data out of Git. See `.codex/README.md` for agent configuration.
- When changing workflows, inspect the relevant job's permissions and triggers, and preserve the intended automation rather than suppressing failures.
