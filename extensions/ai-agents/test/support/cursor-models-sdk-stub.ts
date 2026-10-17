export interface CursorModelsOptions { apiKey?: string }

export const cursorModelsStub = {
  statusCalls: 0,
  listCalls: [] as CursorModelsOptions[],
  statusImpl: async (): Promise<{ status: string }> => { throw new Error('Cursor status was not configured'); },
  listImpl: async (_options: CursorModelsOptions): Promise<unknown[]> => { throw new Error('Cursor models were not configured'); },
};

export const Cursor = {
  auth: {
    async status(): Promise<{ status: string }> {
      cursorModelsStub.statusCalls += 1;
      return cursorModelsStub.statusImpl();
    },
  },
  models: {
    async list(options: CursorModelsOptions): Promise<unknown[]> {
      cursorModelsStub.listCalls.push(options);
      return cursorModelsStub.listImpl(options);
    },
  },
};
