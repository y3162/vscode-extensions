#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: extensions/file-icons/install.sh [--editor vscode|cursor] [--help]

Build the File Icons VSIX and install it in the selected editor.
The default editor is VS Code. Its CLI (code or cursor) must be available on PATH.
Requires Node.js 20 or newer. Uses pnpm on PATH, or corepack when pnpm is absent.
EOF
}

editor=vscode
while [ "$#" -gt 0 ]; do
  case "$1" in
    --editor)
      if [ "$#" -lt 2 ]; then
        echo "Error: --editor requires vscode or cursor." >&2
        usage >&2
        exit 2
      fi
      editor=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$editor" in
  vscode) editor_cli=code ;;
  cursor) editor_cli=cursor ;;
  *)
    echo "Error: unsupported editor: $editor (choose vscode or cursor)." >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20 or newer is required." >&2
  exit 1
fi
if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd() { command pnpm "$@"; }
elif command -v corepack >/dev/null 2>&1; then
  echo "pnpm was not found on PATH. Using corepack to run the declared pnpm@10.18.2."
  pnpm_cmd() { corepack pnpm "$@"; }
else
  echo "Error: pnpm is required (this extension declares pnpm@10.18.2). Install pnpm, or install Node.js with corepack." >&2
  exit 1
fi
if ! node --input-type=commonjs -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 20) process.exit(1)'; then
  echo "Error: Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi
if ! command -v "$editor_cli" >/dev/null 2>&1; then
  echo "Error: '$editor_cli' CLI was not found on PATH. Install the editor command-line launcher and retry." >&2
  exit 1
fi

echo "Installing dependencies..."
pnpm_cmd install --frozen-lockfile

echo "Building the VSIX..."
pnpm_cmd run build

extension_name=$(node --input-type=commonjs -p 'require("./package.json").name')
extension_version=$(node --input-type=commonjs -p 'require("./package.json").version')
vsix_path="$script_dir/$extension_name-$extension_version.vsix"
if [ ! -f "$vsix_path" ]; then
  echo "Error: expected VSIX was not created: $vsix_path" >&2
  exit 1
fi

echo "Installing $vsix_path into $editor..."
"$editor_cli" --install-extension "$vsix_path"
echo "Done. Reload $editor if it is already running."
