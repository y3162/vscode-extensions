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
npm test                      # 単体テスト（API接続不要）
npm run test:integration       # VS Code上で起動・SDK接続・停止を確認（API接続不要）
npm run package               # 実行環境のOS/CPU向けVSIXを作成
```

`npm run test:integration` はmacOSではインストール済みのVS Codeを使用し、それ以外はテスト用VS Codeをダウンロードします。`VSCODE_EXECUTABLE_PATH` でも実行ファイルを指定できます。ユーザー設定・拡張機能と作業ファイルはテスト専用の一時ディレクトリに分離します。

実際のCodexへの接続とファイル読み書きを確認する場合は、ログイン後に実行します（通常のSDK利用料金・利用枠が適用されます）。

```sh
AI_AGENTS_LIVE_TEST=1 npm run test:integration
```

推論を行わず、実際のCodexからのモデル一覧取得だけを追加確認する場合は `AI_AGENTS_LIVE_MODELS_TEST=1 npm run test:integration` を使います。

## 拡張機能の追加

`extensions/<拡張機能名>/` に独立した `package.json` を置き、必要に応じて `build`・`check`・`test` スクリプトを定義します。ルートのコマンドが各workspaceをまとめて実行します。バージョンとCHANGELOGは拡張機能ごとに管理します。

複数の拡張機能で共有するコードが必要になったら `packages/` を追加します。
