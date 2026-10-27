# vscode-extensions

複数のVS Code拡張機能を管理する、TypeScript + npm workspaces のリポジトリです。

```text
extensions/
└── ai-agents/          # Cursor / Codex を使うサイドバー
    ├── src/            # 拡張機能・SDKアダプター
    ├── media/          # WebviewのJavaScript・CSS
    ├── resources/      # アイコン
    ├── test/           # 単体テスト・VS Code統合テスト
    ├── scripts/        # ビルド・テスト・VSIX作成
    └── dist/           # 生成物（Git管理対象外）
```

## 開発

Node.js 22.13以降、npm、VS Code 1.109以降を利用してください。Cursor SDKの実行にはVS Code内のNode.jsも22.13以降が必要です。古い場合はVS Codeを更新してください。

```sh
npm ci
npm run build
```

このリポジトリをVS Codeで開き、デバッグ構成 **Run AI Agents** を選んで **F5** を押します。起動したExtension Development Hostで作業対象のフォルダを開き、アクティビティバーの **AI Agents** を選択してください。

Codexは既存の `codex login` を利用できます。CursorはSDK用の認証が必要です。詳しくは [AI AgentsのREADME](extensions/ai-agents/README.md) を参照してください。

```sh
npm run watch                 # AI Agentsの変更を監視
npm run check                 # 型チェック・Webview JS構文チェック
npm test                      # 単体テスト（API接続不要。ライブテストは含まない）
npm run test:integration      # VS Code上で起動・SDK接続・停止を確認（API接続不要）
npm run test:protocol         # インストール済み Cursor CLI と同梱 Codex の接続確認
npm run test:live             # 既存ログインでの短い実推論（利用枠を使う）
npm run test:tools            # 一時ディレクトリでの実ツール・承認・拒否
npm run package               # 実行環境のOS/CPU向けVSIXを作成
```

ローカルのVS Codeへビルドしてインストールする場合は、対象拡張の `install.sh` を実行します。AI Agentsは `extensions/ai-agents/install.sh`、File Iconsは `extensions/file-icons/install.sh` です。Cursorを使う場合は `--editor cursor` を付けてください。AI Agentsには Node.js 22.13以降と npm、File Iconsには Node.js 20以降と pnpm（未導入なら corepack）、および対象エディターのCLI（`code` または `cursor`）が必要です。

`npm run test:integration` はmacOSではインストール済みのVS Codeを使用し、それ以外はテスト用VS Codeをダウンロードします。`VSCODE_EXECUTABLE_PATH` でも実行ファイルを指定できます。ユーザー設定・拡張機能と作業ファイルはテスト専用の一時ディレクトリに分離します。

`test:protocol`、`test:live`、`test:tools` は通常の `npm test` では走りません。既存の `codex login` と `agent login`、Cursor SDK のログインを使います。APIキーへは切り替えません。ログインが無い場合は、Codex は `codex login`、Cursor CLI は `agent login`、Cursor SDK はサイドバーのログインを使ってください。SDK のログインと CLI のログインは別です。

```sh
npm run test:coverage          # 行・分岐・関数カバレッジ（認証不要）
npm run test:hygiene           # 生データ、巨大fixture、秘密らしき文字列の追跡を検査
```

単体テストとモックプロトコルは、リポジトリ内のテストコードと小さな合成fixtureだけで再現します。実CLIの会話、スクリーンショット、実行ログは読みません。テストが作る作業ディレクトリとVS Code profileはOSの一時ディレクトリで、終了時に削除します。診断や信頼性検証の出力先は `AI_AGENTS_RELIABILITY_EVIDENCE` で指定し、リポジトリの外にしてください。spikeスクリプトの保存先は既定で一時ディレクトリ、変更する場合は `AI_AGENTS_SPIKE_OUT` です。

推論を行わず、統合テストにモデル一覧だけを足す場合は、これまでどおり `AI_AGENTS_LIVE_MODELS_TEST=1` または `AI_AGENTS_LIVE_CURSOR_MODELS_TEST=1` を付けて `npm run test:integration` を実行します。

## 拡張機能の追加

`extensions/<拡張機能名>/` に独立した `package.json` を置き、必要に応じて `build`・`check`・`test` スクリプトを定義します。ルートのコマンドが各workspaceをまとめて実行します。バージョンとCHANGELOGは拡張機能ごとに管理します。

複数の拡張機能で共有するコードが必要になったら `packages/` を追加します。
