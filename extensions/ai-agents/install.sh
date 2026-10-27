#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: extensions/ai-agents/install.sh [--editor vscode|cursor] [--help]

Build the AI Agents VSIX for this machine and install it in the selected editor.
The default editor is VS Code. Its CLI (code or cursor) must be available on PATH.
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
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$repo_root"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 22.13 or newer is required." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)'; then
  echo "Error: Node.js 22.13 or newer is required (found $(node --version))." >&2
  exit 1
fi
if ! command -v "$editor_cli" >/dev/null 2>&1; then
  echo "Error: '$editor_cli' CLI was not found on PATH. Install the editor command-line launcher and retry." >&2
  exit 1
fi

echo "Installing dependencies..."
npm ci

echo "Building the VSIX..."
npm run package --workspace ai-agents

extension_version=$(node --input-type=commonjs -p 'require("./extensions/ai-agents/package.json").version')
target=$(node --input-type=commonjs -p '`${process.platform}-${process.arch}`')
vsix_path="$script_dir/dist/ai-agents-$extension_version-$target.vsix"
if [ ! -f "$vsix_path" ]; then
  echo "Error: expected VSIX was not created: $vsix_path" >&2
  exit 1
fi

echo "Installing $vsix_path into $editor..."
"$editor_cli" --install-extension "$vsix_path"
echo "Done. Reload $editor if it is already running."
