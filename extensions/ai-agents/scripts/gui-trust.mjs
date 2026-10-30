// Verify trust in the isolated Extension Host, never in the user's profile.
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
const root = await realpath(process.argv[2] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw Error('Disposable session required');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (receipt.sessionRoot !== root || !receipt.paths.workspace.startsWith(`${root}/`) || !receipt.launchArgs.includes('--disable-workspace-trust')) throw Error('Invalid isolated trust configuration');
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    const state = JSON.parse(await readFile(join(root, 'workspace-trust.json'), 'utf8'));
    if (state.workspace !== receipt.paths.workspace) throw Error('Trust verifier reported an unexpected workspace');
    if (state.isTrusted !== true) throw Error('Disposable Extension Host workspace is not trusted');
    console.log(JSON.stringify(state));
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw Error('Timeout waiting for disposable Extension Host trust verification');
