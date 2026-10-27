# File Icons

VS Code と VSCodium 用のファイル・フォルダーアイコンテーマです。4種類の配色に対応し、開発や機械学習で使うファイルやフォルダーを識別できます。

## インストール

`pnpm install --frozen-lockfile` の後、`pnpm build` で VSIX を生成します。VS Code のコマンドパレットから **Extensions: Install from VSIX...** を選び、生成した `file-icons-1.26.0.vsix` を指定してください。

VS Code または Cursor の CLI が利用できる場合は、リポジトリのルートから `extensions/file-icons/install.sh` を実行する方法もあります。Cursor の場合は `--editor cursor` を指定してください。

インストール後、**Preferences: File Icon Theme** から File Icons の配色を選択します。

## 設定

- `file-icons.hidesExplorerArrows`: フォルダーの開閉矢印を非表示にする。
- `file-icons.specificFolders`: フォルダーごとの専用アイコンを使う。
- `file-icons.monochrome`: アイコンを文字色の単色で表示する。
- `file-icons.associations.languages`、`extensions`、`files`、`folders`: 言語・拡張子・ファイル名・フォルダー名ごとのアイコンを変更する。

設定変更時はテーマの再生成とウィンドウの再読み込みが必要な場合があります。`File Icons: Factory reset settings` で設定を初期化できます。

## 開発

Node.js 20 以降と pnpm を使用します。

```sh
pnpm install --frozen-lockfile
pnpm integrity
pnpm typecheck
pnpm build
```

アイコンの追加方法は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

本拡張機能は MIT License のもとで配布される既存のアイコンテーマを基にしています。著作権表示とライセンス全文は [LICENSE](LICENSE) を参照してください。配色の実装には `@catppuccin/palette` を使用しています。
