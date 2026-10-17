import type { Post } from './cards.js';
import { Composer } from './composer.js';
import { createDom } from './dom.js';
import { Header, type Page } from './header.js';
import { HistoryPanel } from './history.js';
import type { HostToWebview, MessageDiff, ViewMessage, ViewShell, VsCodeApi } from '../protocol.js';
import { Menu } from './popover.js';
import { SettingsPanel } from './settings.js';
import { strings, type Locale } from './strings.js';
import { usageText } from '../usage.js';
import { Transcript } from './transcript.js';

interface Persisted { draft?: string; expanded?: string[]; stick?: boolean; page?: Page }

class MessageLog {
  private readonly byId = new Map<string, ViewMessage>();
  order: string[] = [];
  version = 0;

  reset(): void {
    this.byId.clear();
    this.order = [];
    this.version += 1;
  }

  apply(diff: MessageDiff): void {
    for (const id of diff.removed) this.byId.delete(id);
    for (const message of diff.upserts) this.byId.set(message.id, message);
    this.order = diff.order;
    this.version += 1;
  }

  list(): ViewMessage[] {
    return this.order.flatMap((id) => {
      const message = this.byId.get(id);
      return message ? [message] : [];
    });
  }
}

export function createApp(vscode: VsCodeApi, options?: { document?: Document }): { destroy(): void; flush(): void } {
  const document = options?.document ?? globalThis.document;
  const dom = createDom(document);
  const root = document.getElementById('app') ?? document.body;
  root.classList.add('shell');
  const saved = vscode.getState() as Persisted | null;
  let page: Page = saved?.page === 'chat' ? 'chat' : 'home';
  const headerHost = dom.el('div');
  const stage = dom.el('div', 'stage');
  const thread = dom.el('main', 'thread');
  thread.setAttribute('role', 'log');
  const jump = dom.button('jump', 'Latest', 'arrow-down');
  jump.hidden = true;
  const dock = dom.el('footer', 'dock');
  const usagePanel = dom.el('details', 'usage-panel');
  const usageSummary = dom.el('summary');
  const usageDetail = dom.el('pre');
  usagePanel.append(usageSummary, usageDetail);
  dock.append(usagePanel);
  const alert = dom.el('p', 'host-error');
  alert.hidden = true;
  alert.setAttribute('role', 'alert');
  stage.append(alert, thread, jump);
  root.append(headerHost, stage, dock);

  const log = new MessageLog();
  let shell: ViewShell | null = null;
  let locale: Locale = document.documentElement.lang === 'en' ? 'en' : 'ja';
  let copy = strings(locale);
  let stick = true;
  let scheduled = false;
  let painted = '';

  const post: Post = (message) => {
    vscode.postMessage(shell ? { provider: shell.provider, cwd: shell.cwd, ...(shell.conversationId ? { conversationId: shell.conversationId } : {}), ...message } : message);
  };
  const menu = new Menu(dom, root);
  let show = (_panel: 'history' | 'settings' | 'chat') => {};
  const header = new Header(dom, headerHost, copy, (anchor) => {
    if (!shell) return;
    menu.open(anchor, [
      { id: 'note', label: copy.switchNote },
      ...shell.providers.map((item) => ({
        id: item.id, label: item.label, description: item.detail, checked: item.id === shell?.provider,
        onSelect: () => post({ type: 'select', provider: item.id }),
      })),
    ]);
  }, () => { post({ type: 'newChat' }); show('chat'); }, () => show('settings'), () => show('history'), (anchor) => {
    if (!shell) return;
    menu.open(anchor, shell.terminals.map((terminal) => ({
      id: terminal.processId, label: terminal.command || terminal.processId,
      onSelect: () => post({ type: 'openTerminal', processId: terminal.processId }),
    })));
  });
  const history = new HistoryPanel(dom, stage, (id) => openSession(id));
  const settings = new SettingsPanel(dom, stage, post, () => { settings.close(); paint(); });
  const composer = new Composer(dom, dock, post, menu, (panel) => show(panel));
  const transcript = new Transcript(dom, thread, post, (text, retryId) => { composer.editDraft(text, retryId); save(); }, (anchor) => composer.openBuildModel(anchor),
    (turnId, editedText) => post({ type: 'rewind', turnId, editedText }));

  function openSession(id: string): void {
    if (!shell) return;
    if (id === shell.sessionId) { show('chat'); return; }
    alert.hidden = true;
    post({ type: 'restoreSession', id });
    show('chat');
  }

  show = (panel) => {
    alert.hidden = true;
    alert.textContent = '';
    menu.close(false);
    composer.closeMenus();
    if (panel === 'settings') {
      settings.open();
      paint();
      return;
    }
    settings.close();
    page = panel === 'history' ? 'home' : 'chat';
    if (page === 'home') post({ type: 'refreshSessions' });
    save();
    paint();
    if (page === 'chat') composer.focus();
  };

  if (saved?.draft) composer.draft = saved.draft;
  if (saved?.expanded) transcript.restoreExpanded(saved.expanded);
  if (saved?.stick === false) stick = false;

  const save = () => vscode.setState({ draft: composer.draft, expanded: transcript.expandedIds(), stick, page });
  composer.onInput(save);

  const applyChrome = () => {
    root.dataset.page = page;
    root.classList.toggle('page-home', page === 'home');
    root.classList.toggle('page-chat', page === 'chat');
    thread.hidden = page !== 'chat';
    dock.hidden = page !== 'chat';
    history.element.hidden = page !== 'home';
  };

  const paint = () => {
    applyChrome();
    if (!shell) return;
    copy = strings(shell.locale);
    locale = shell.locale;
    document.documentElement.lang = locale === 'ja' ? 'ja' : 'en';
    header.render(shell, copy, page);
    history.render(shell, copy);
    settings.render(shell, copy);
    composer.render(shell, copy);
    usageSummary.textContent = usageText(shell.usage, shell.backend === 'acp' ? 'Token Usage: 非対応 / Unsupported' : 'Token Usage: 未取得 / Not reported');
    const usage = shell.usage;
    usageDetail.textContent = usage ? [
      'Session · ' + usageText(usage),
      `Cache read: ${usage.cachedInputTokens ?? '—'} · Cache write: ${usage.cacheWriteInputTokens ?? '—'}`,
      `Reasoning: ${usage.reasoningTokens ?? '—'} (included in Output)`,
      usage.inputIncludesCache === false ? 'Input excludes cache; cache is included in Total.' : 'Cached tokens are included in Input.',
      usage.contextWindow && usage.contextTokens !== undefined ? `Context: ${usage.contextTokens} / ${usage.contextWindow} (${(100 * usage.contextTokens / usage.contextWindow).toFixed(1)}%)` : 'Context: 未取得 / Not reported',
    ].join('\n') : 'No token estimate or cost estimate.';
    const messages = log.list();
    transcript.render(messages, shell, copy);
    const last = [...messages].reverse().find((message) => message.role === 'user');
    composer.notePrompt(last?.text ?? '');
    const jumpLabel = jump.querySelector('.btn-label');
    if (jumpLabel) jumpLabel.textContent = copy.latest;
    jump.title = copy.latest;
    const marker = `${page}:${log.version}:${shell.statusText}:${history.hidden}:${settings.hidden}`;
    if (marker !== painted && stick && page === 'chat') thread.scrollTop = thread.scrollHeight;
    painted = marker;
    jump.hidden = page !== 'chat' || stick || thread.scrollHeight <= thread.clientHeight + 80;
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const raf = document.defaultView?.requestAnimationFrame?.bind(document.defaultView);
    if (raf) raf(() => { scheduled = false; paint(); });
    else { scheduled = false; paint(); }
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as HostToWebview | { type: 'probeResult' };
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'state') {
      if (data.full) log.reset();
      log.apply(data.messages);
      shell = data.shell;
      schedule();
      return;
    }
    if (data.type === 'retryPrepared') {
      if (shell && data.provider === shell.provider && data.cwd === shell.cwd && data.conversationId === shell.conversationId) composer.restoreRetry(data.id, data.text, data.images, data.attachments);
      return;
    }
    if (data.type === 'copyResult') { transcript.copied(data.requestId, data.ok); return; }
    if (data.type === 'error') { alert.hidden = false; alert.textContent = data.text; return; }
    if (data.type === 'modelCatalog') { composer.setCatalog(data); return; }
    if (data.type === 'suggestions') { composer.setSuggestions(data.requestId, data.items); return; }
    if (data.type === 'insert') { composer.insert(data.text, data.label); save(); return; }
    if (data.type === 'inspector') { settings.showInspector(data.title, data.text); return; }
    if (data.type === 'navigate') { show(data.panel); return; }
    if (data.type === 'probe') {
      paint();
      vscode.postMessage({
        type: 'probeResult',
        turns: thread.querySelectorAll('.turn').length,
        pending: Boolean(thread.querySelector('.pending-card')),
        history: page === 'home',
        settings: !settings.hidden,
      });
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || menu.isOpen) return;
    if (!settings.hidden) { settings.close(); paint(); }
  };
  thread.addEventListener('scroll', () => {
    const distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    stick = thread.clientHeight === 0 || distance < 60;
    jump.hidden = page !== 'chat' || stick || thread.scrollHeight <= thread.clientHeight + 80;
    save();
  });
  jump.addEventListener('click', () => { stick = true; thread.scrollTop = thread.scrollHeight; jump.hidden = true; save(); });
  const view = document.defaultView ?? globalThis;
  view.addEventListener('keydown', onKey);
  view.addEventListener('message', onMessage);
  applyChrome();
  vscode.postMessage({ type: 'ready' });
  if (page === 'home') post({ type: 'refreshSessions' });

  return {
    flush: paint,
    destroy() {
      view.removeEventListener('keydown', onKey);
      view.removeEventListener('message', onMessage);
    },
  };
}
