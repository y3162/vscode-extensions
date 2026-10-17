import path from 'node:path';

export interface Disposable { dispose(): void }

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class Selection extends Range {
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
  }
}

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}

export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}

export class Uri {
  scheme: string;
  fsPath: string;
  path: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
  }

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      const uri = new Uri(url.protocol.replace(/:$/, ''), url.pathname);
      uri.path = `${url.hostname}${url.pathname}`;
      uri.fsPath = value;
      return uri;
    } catch {
      return Uri.file(value);
    }
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...segments));
  }

  toString(): string {
    return this.scheme === 'file' ? this.fsPath : `${this.scheme}:${this.path}`;
  }
}

export class EventEmitter<T> {
  readonly fired: T[] = [];
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(value: T): void {
    this.fired.push(value);
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class QuickPick<T extends object> {
  title = '';
  placeholder = '';
  value = '';
  busy = false;
  ignoreFocusOut = false;
  matchOnDescription = false;
  matchOnDetail = false;
  items: T[] = [];
  activeItems: T[] = [];
  selectedItems: T[] = [];
  buttons: unknown[] = [];
  shown = false;
  disposed = false;
  private readonly acceptListeners = new Set<() => void>();
  private readonly hideListeners = new Set<() => void>();
  private readonly activeListeners = new Set<(items: readonly T[]) => void>();
  private readonly buttonListeners = new Set<(button: unknown) => void>();

  onDidAccept(listener: () => void): Disposable {
    this.acceptListeners.add(listener);
    return { dispose: () => { this.acceptListeners.delete(listener); } };
  }

  onDidHide(listener: () => void): Disposable {
    this.hideListeners.add(listener);
    return { dispose: () => { this.hideListeners.delete(listener); } };
  }

  onDidChangeActive(listener: (items: readonly T[]) => void): Disposable {
    this.activeListeners.add(listener);
    return { dispose: () => { this.activeListeners.delete(listener); } };
  }

  onDidTriggerButton(listener: (button: unknown) => void): Disposable {
    this.buttonListeners.add(listener);
    return { dispose: () => { this.buttonListeners.delete(listener); } };
  }

  show(): void { this.shown = true; }

  hide(): void {
    this.shown = false;
    for (const listener of [...this.hideListeners]) listener();
  }

  accept(): void {
    for (const listener of [...this.acceptListeners]) listener();
  }

  activate(items: readonly T[]): void {
    this.activeItems = [...items];
    for (const listener of [...this.activeListeners]) listener(this.activeItems);
  }

  triggerButton(button: unknown = this.buttons[0]): void {
    for (const listener of [...this.buttonListeners]) listener(button);
  }

  dispose(): void {
    this.disposed = true;
    this.acceptListeners.clear();
    this.hideListeners.clear();
    this.activeListeners.clear();
    this.buttonListeners.clear();
  }
}

export interface OutputChannel {
  name: string;
  lines: string[];
  shown: boolean;
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface Terminal {
  name: string;
  options?: unknown;
  shown: number;
  disposed: number;
  sent: string[];
  show(): void;
  dispose(): void;
  sendText(text: string): void;
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
  cancel(): void;
}

export interface ProgressInvocation {
  options: unknown;
  token: CancellationToken;
}

interface WarningChoice { value: string | undefined }
interface InputChoice { value: string | undefined }

function disposableList(list: unknown[], item: unknown): Disposable {
  return { dispose: () => {
    const index = list.indexOf(item);
    if (index >= 0) list.splice(index, 1);
  } };
}

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const TerminalLocation = { Panel: 1, Editor: 2 };
export const QuickInputButtons = { Back: { iconPath: new ThemeIcon('arrow-left'), tooltip: 'Back' } };

export const window = {
  errorMessages: [] as string[],
  informationMessages: [] as string[],
  warningMessages: [] as string[],
  warningQueue: [] as WarningChoice[],
  inputQueue: [] as InputChoice[],
  quickPickQueue: [] as unknown[],
  quickPickOffers: [] as unknown[],
  openDialogQueue: [] as Array<Uri[] | undefined>,
  quickPicks: [] as QuickPick<object>[],
  outputChannels: [] as OutputChannel[],
  terminals: [] as Terminal[],
  webviewProviders: [] as { viewId: string; provider: unknown; options: unknown }[],
  progress: [] as ProgressInvocation[],
  progressCancelled: false,
  activeTextEditor: undefined as {
    document: {
      uri: Uri;
      getText: (range?: Range) => string;
      lineCount: number;
      lineAt: (line: number) => { text: string };
    };
    selection: { isEmpty: boolean; start: { line: number; character: number }; end: { line: number; character: number } };
  } | undefined,
  visibleEditors: [] as Array<{ document: { uri: Uri; lineCount: number; lineAt: (line: number) => { text: string } }; selection?: Selection; revealed: Range[] }>,
  activeColorTheme: { kind: ColorThemeKind.Dark },
  closeListeners: [] as Array<(terminal: Terminal) => void>,
  shellListeners: [] as Array<(event: { exitCode: number | undefined; execution: { commandLine: { value?: string } | string } }) => void>,
  onDidEndTerminalShellExecution: undefined as undefined | ((listener: (event: { exitCode: number | undefined; execution: { commandLine: { value?: string } | string } }) => void) => Disposable),

  createOutputChannel(name: string): OutputChannel {
    const channel: OutputChannel = {
      name,
      lines: [],
      shown: false,
      appendLine(line: string) { channel.lines.push(line); },
      show() { channel.shown = true; },
      dispose() {},
    };
    window.outputChannels.push(channel);
    return channel;
  },

  registerWebviewViewProvider(viewId: string, provider: unknown, options?: unknown): Disposable {
    const entry = { viewId, provider, options };
    window.webviewProviders.push(entry);
    return disposableList(window.webviewProviders, entry);
  },

  showErrorMessage(message: string): Thenable<undefined> {
    window.errorMessages.push(message);
    return Promise.resolve(undefined);
  },

  showInformationMessage(message: string): Thenable<undefined> {
    window.informationMessages.push(message);
    return Promise.resolve(undefined);
  },

  showWarningMessage(message: string, ..._rest: unknown[]): Thenable<string | undefined> {
    window.warningMessages.push(message);
    return Promise.resolve(window.warningQueue.shift()?.value);
  },

  showInputBox(..._args: unknown[]): Thenable<string | undefined> {
    return Promise.resolve(window.inputQueue.shift()?.value);
  },

  showQuickPick(items: unknown): Thenable<unknown> {
    window.quickPickOffers.push(items);
    return Promise.resolve(window.quickPickQueue.shift());
  },

  showOpenDialog(..._args: unknown[]): Thenable<Uri[] | undefined> {
    return Promise.resolve(window.openDialogQueue.shift());
  },

  async withProgress(options: unknown, task: (progress: { report: () => void }, token: CancellationToken) => Promise<unknown>): Promise<unknown> {
    const listeners = new Set<() => void>();
    const token: CancellationToken = {
      isCancellationRequested: window.progressCancelled,
      onCancellationRequested(listener: () => void) {
        listeners.add(listener);
        if (token.isCancellationRequested) listener();
        return { dispose: () => { listeners.delete(listener); } };
      },
      cancel() {
        token.isCancellationRequested = true;
        for (const listener of [...listeners]) listener();
      },
    };
    const invocation = { options, token };
    window.progress.push(invocation);
    return task({ report() {} }, token);
  },

  createQuickPick<T extends object>(): QuickPick<T> {
    const picker = new QuickPick<T>();
    window.quickPicks.push(picker as unknown as QuickPick<object>);
    return picker;
  },

  createTerminal(nameOrOptions: string | { name?: string }): Terminal {
    const terminal: Terminal = {
      name: typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name ?? '',
      options: typeof nameOrOptions === 'string' ? undefined : nameOrOptions,
      shown: 0,
      disposed: 0,
      sent: [],
      show() { terminal.shown += 1; },
      dispose() { terminal.disposed += 1; },
      sendText(text: string) { terminal.sent.push(text); },
    };
    window.terminals.push(terminal);
    return terminal;
  },

  onDidCloseTerminal(listener: (terminal: Terminal) => void): Disposable {
    window.closeListeners.push(listener);
    return disposableList(window.closeListeners, listener);
  },

  fireCloseTerminal(terminal: Terminal): void {
    for (const listener of [...window.closeListeners]) listener(terminal);
  },

  async showTextDocument(uri: Uri): Promise<{ document: { uri: Uri; lineCount: number; lineAt: (line: number) => { text: string } }; selection?: Selection; revealed: Range[] }> {
    const editor = {
      document: {
        uri,
        lineCount: 4,
        lineAt: (line: number) => ({ text: `line-${line}` }),
      },
      selection: undefined as Selection | undefined,
      revealed: [] as Range[],
      revealRange(range: Range) { editor.revealed.push(range); },
    };
    window.visibleEditors.push(editor);
    return editor;
  },
};

export const workspace = {
  isTrusted: true,
  workspaceFolders: [] as Array<{ name: string; uri: Uri; index: number }>,
  textDocuments: [] as unknown[],
  configuration: {} as Record<string, Record<string, unknown>>,
  configurationUpdates: [] as Array<{ section: string; key: string; value: unknown; target: unknown }>,
  findFilesResult: [] as Uri[],
  findFilesCalls: [] as Array<{ include: unknown; exclude: unknown; max: unknown }>,
  files: new Map<string, Uint8Array>(),
  configListeners: [] as Array<(event: { affectsConfiguration: (section: string) => boolean }) => void>,
  textListeners: [] as Array<(event: unknown) => void>,
  folderListeners: [] as Array<() => void>,

  getConfiguration(section: string) {
    return {
      get(key: string, fallback?: unknown) {
        const bag = workspace.configuration[section] ?? {};
        return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : fallback;
      },
      async update(key: string, value: unknown, target?: unknown) {
        workspace.configuration[section] ??= {};
        workspace.configuration[section][key] = value;
        workspace.configurationUpdates.push({ section, key, value, target });
      },
    };
  },

  async findFiles(include: unknown, exclude?: unknown, max?: unknown): Promise<Uri[]> {
    workspace.findFilesCalls.push({ include, exclude, max });
    return workspace.findFilesResult;
  },

  onDidChangeConfiguration(listener: (event: { affectsConfiguration: (section: string) => boolean }) => void): Disposable {
    workspace.configListeners.push(listener);
    return disposableList(workspace.configListeners, listener);
  },

  onDidChangeTextDocument(listener: (event: unknown) => void): Disposable {
    workspace.textListeners.push(listener);
    return disposableList(workspace.textListeners, listener);
  },

  onDidChangeWorkspaceFolders(listener: () => void): Disposable {
    workspace.folderListeners.push(listener);
    return disposableList(workspace.folderListeners, listener);
  },

  fireConfiguration(affectsConfiguration: (section: string) => boolean): void {
    for (const listener of [...workspace.configListeners]) listener({ affectsConfiguration });
  },

  fireWorkspaceFolders(): void {
    for (const listener of [...workspace.folderListeners]) listener();
  },

  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const bytes = workspace.files.get(uri.fsPath);
      if (!bytes) throw Object.assign(new Error(`ENOENT: ${uri.fsPath}`), { code: 'ENOENT' });
      return bytes;
    },
    async writeFile(uri: Uri, contents: Uint8Array): Promise<void> {
      workspace.files.set(uri.fsPath, contents);
    },
  },
};

export const commands = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as Array<{ command: string; args: unknown[] }>,
  failures: new Map<string, () => Error>(),

  registerCommand(name: string, callback: (...args: unknown[]) => unknown): Disposable {
    commands.handlers.set(name, callback);
    return { dispose: () => { if (commands.handlers.get(name) === callback) commands.handlers.delete(name); } };
  },

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    commands.executed.push({ command, args });
    const failure = commands.failures.get(command);
    if (failure) throw failure();
    const handler = commands.handlers.get(command);
    if (handler) return handler(...args);
    return undefined;
  },
};

export const env = {
  language: 'en',
  opened: [] as Uri[],
  clipboard: {
    text: '',
    fail: false,
    async writeText(text: string): Promise<void> {
      if (env.clipboard.fail) throw new Error('clipboard failed');
      env.clipboard.text = text;
    },
  },
  async openExternal(uri: Uri): Promise<boolean> {
    env.opened.push(uri);
    return true;
  },
};

export const languages = {
  entries: [] as Array<[Uri, Array<{ severity: number; message: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>]>,
  getDiagnostics() { return languages.entries; },
};

export const extensions = {
  all: [] as Array<{ extensionUri: Uri; packageJSON?: { contributes?: { iconThemes?: unknown } } }>,
};

export interface Memento {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
  readonly values: Map<string, string>;
}

function createMemento(): Memento {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback?: T): T {
      return (values.has(key) ? values.get(key) : fallback) as T;
    },
    async update(key: string, value: unknown) { values.set(key, value); },
    keys() { return [...values.keys()]; },
  };
}

function createSecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) { return values.get(key); },
    async store(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  };
}

export class ExtensionContext {
  readonly subscriptions: Disposable[] = [];
  readonly secrets: SecretStore;
  readonly workspaceState: Memento;
  readonly globalState: Memento;
  readonly storageUri: Uri;
  readonly globalStorageUri: Uri;
  readonly extensionUri: Uri;

  constructor(root: string) {
    this.secrets = createSecrets();
    this.workspaceState = createMemento();
    this.globalState = createMemento();
    this.storageUri = Uri.file(path.join(root, 'storage'));
    this.globalStorageUri = Uri.file(path.join(root, 'global'));
    this.extensionUri = Uri.file(path.join(root, 'extension'));
  }
}

export function createExtensionContext(root: string): ExtensionContext {
  return new ExtensionContext(root);
}

function defaultConfiguration(): Record<string, Record<string, unknown>> {
  return {
    'ai-agents': {
      defaultProvider: 'codex',
      'codex.backend': 'sdk',
      'cursor.backend': 'sdk',
      'codex.model': '',
      'cursor.model': 'auto',
      autoApprove: false,
      'history.enabled': true,
      maxBackgroundSessions: 3,
      'codex.executablePath': '',
      'cursor.agentPath': 'agent',
    },
    workbench: { iconTheme: '' },
  };
}

export function resetVscode(): void {
  window.errorMessages.length = 0;
  window.informationMessages.length = 0;
  window.warningMessages.length = 0;
  window.warningQueue.length = 0;
  window.inputQueue.length = 0;
  window.quickPickQueue.length = 0;
  window.quickPickOffers.length = 0;
  window.openDialogQueue.length = 0;
  window.quickPicks.length = 0;
  window.outputChannels.length = 0;
  window.terminals.length = 0;
  window.webviewProviders.length = 0;
  window.progress.length = 0;
  window.progressCancelled = false;
  window.activeTextEditor = undefined;
  window.visibleEditors.length = 0;
  window.activeColorTheme = { kind: ColorThemeKind.Dark };
  window.closeListeners.length = 0;
  window.shellListeners.length = 0;
  window.onDidEndTerminalShellExecution = (listener) => {
    window.shellListeners.push(listener);
    return disposableList(window.shellListeners, listener);
  };
  workspace.isTrusted = true;
  workspace.workspaceFolders = [];
  workspace.textDocuments = [];
  workspace.configuration = defaultConfiguration();
  workspace.configurationUpdates.length = 0;
  workspace.findFilesResult = [];
  workspace.findFilesCalls.length = 0;
  workspace.files.clear();
  workspace.configListeners.length = 0;
  workspace.textListeners.length = 0;
  workspace.folderListeners.length = 0;
  commands.handlers.clear();
  commands.executed.length = 0;
  commands.failures.clear();
  env.language = 'en';
  env.opened.length = 0;
  env.clipboard.text = '';
  env.clipboard.fail = false;
  languages.entries.length = 0;
  extensions.all.length = 0;
}

resetVscode();
