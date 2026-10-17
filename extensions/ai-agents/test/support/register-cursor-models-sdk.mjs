import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const stubPath = fileURLToPath(new URL('./cursor-models-sdk-stub.js', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cursor/sdk') return nextResolve(stubPath, context);
    return nextResolve(specifier, context);
  },
});
