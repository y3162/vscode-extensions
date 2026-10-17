import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const stubPath = fileURLToPath(new URL('./cursor-sdk-stub.js', import.meta.url));

// Imported only by the extension test. Other test processes never install this hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cursor/sdk') return nextResolve(stubPath, context);
    return nextResolve(specifier, context);
  },
});
