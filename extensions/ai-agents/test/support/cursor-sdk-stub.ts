export interface CursorLoginOptions {
  signal?: AbortSignal;
  openBrowser?: (url: string) => Promise<void>;
  apiKeyName?: string;
}

export const cursorAuth = {
  loginCalls: [] as CursorLoginOptions[],
  statusCalls: 0,
  loginImpl: (async () => {
    throw new Error('cursor sdk stub: login was not configured');
  }) as (options: CursorLoginOptions) => Promise<void>,
  statusImpl: (async () => {
    throw new Error('cursor sdk stub: status must not be called');
  }) as () => Promise<{ status: string }>,
};

export const Cursor = {
  auth: {
    async login(options: CursorLoginOptions): Promise<void> {
      cursorAuth.loginCalls.push(options);
      await cursorAuth.loginImpl(options);
    },
    async status(): Promise<{ status: string }> {
      cursorAuth.statusCalls += 1;
      return cursorAuth.statusImpl();
    },
  },
};
