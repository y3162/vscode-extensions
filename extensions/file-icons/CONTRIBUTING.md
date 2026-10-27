# File Icons の開発

Node.js 20 以降と pnpm を用意し、`pnpm install --frozen-lockfile` を実行します。

- ファイルアイコンの対応付け: `src/defaults/fileIcons.ts`
- フォルダーアイコンの対応付け: `src/defaults/folderIcons.ts`
- SVG: `icons/css-variables/` と各配色ディレクトリ

フォルダーアイコンには通常状態と `_open` の両方を用意します。既存のアイコンと同様、16×16 のキャンバスを基本にしてください。配色と単色設定に対応できるよう、色は可能な限り CSS 変数と既存のパレットを使います。

変更後は `pnpm integrity`、`pnpm typecheck`、`pnpm build` で確認します。ビルドは `dist/` と VSIX を生成します。
