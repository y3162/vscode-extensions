// Synthetic Extension Host surrogate for an actual owner-client process death.
import { createManagedSession } from '../../src/providers/managed-session.js';
import { readFile, writeFile } from 'node:fs/promises';
const [configFile, action] = process.argv.slice(2);
const options = JSON.parse(await readFile(configFile, 'utf8'));
const session = await createManagedSession(options);
try {
  const emit = () => undefined;
  if (action === 'start') {
    await session.run('MANAGED_RELOAD_GATE', new AbortController().signal, emit, undefined, {
      executionId: 'local-retained-run', intent: options.mode === 'plan' ? 'plan' : 'chat', mode: options.mode, selection: options,
    });
  } else {
    const attached = await session.recoverRun('local-retained-run', new AbortController().signal, emit, () => undefined);
    if (!attached) throw new Error('Original execution missing.');
    await writeFile(`${options.cwd}/managed-recovered.txt`, JSON.stringify({ sessionId: session.sessionId, turnId: session.latestBackendTurnId() }));
  }
} finally { await session.dispose(); }
