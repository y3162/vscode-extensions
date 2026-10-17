import { registerHooks } from 'node:module';

const stubUrl = new URL('./vscode-stub.ts', import.meta.url).href;

// Node 26's module.register() is deprecated. tsx also loads these tests as
// CommonJS require(), which that legacy hook thread never observes.
// registerHooks is the node:module resolver that runs for both, and it still
// forwards every specifier through nextResolve.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return nextResolve(stubUrl, context);
    return nextResolve(specifier, context);
  },
});
