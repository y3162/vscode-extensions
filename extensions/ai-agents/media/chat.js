/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const element = (id) => document.getElementById(id);
  const lang = document.documentElement.lang === 'en' ? 'en' : 'ja';
  const copy = lang === 'ja' ? {
    you: 'あなた', agent: 'エージェント', tool: '実行', status: '状況', error: 'エラー',
    ready: '準備完了', running: '実行中…', approval: '承認待ち', folder: '作業フォルダを開いてください',
    empty: '質問や変更を依頼できます。@ でファイル、/ でコマンドです。',
    send: '送信', queue: 'キューに追加', stop: '停止', allow: '許可', session: 'このセッションでは許可', deny: '拒否',
    approve: '承認', reject: '却下', sendNow: '今すぐ送る', steer: '実行中に追加', remove: '削除',
    changes: '変更', revert: '戻す', open: '開く', history: '履歴', none: 'なし',
    copy: 'コピー', answer: '回答',
  } : {
    you: 'You', agent: 'Agent', tool: 'Tool', status: 'Status', error: 'Error',
    ready: 'Ready', running: 'Running…', approval: 'Waiting for approval', folder: 'Open a workspace folder',
    empty: 'Ask for a change or a question. Use @ for files and / for commands.',
    send: 'Send', queue: 'Queue', stop: 'Stop', allow: 'Allow', session: 'Allow for session', deny: 'Deny',
    approve: 'Approve', reject: 'Reject', sendNow: 'Send now', steer: 'Steer', remove: 'Remove',
    changes: 'Changes', revert: 'Revert', open: 'Open', history: 'History', none: 'None',
    copy: 'Copy', answer: 'Answer',
  };
  const provider = element('provider');
  const model = element('model');
  const folder = element('folder');
  const prompt = element('prompt');
  const messages = element('messages');
  const nodes = new Map();
  let state;
  let capabilities;
  let controls;
  let pendingSend = false;
  let signature = '';
  let rendering = false;
  let suggestions = [];
  let suggestionIndex = 0;
  let suggestionRequest = 0;
  let suggestionToken;
  const images = [];
  prompt.value = vscode.getState()?.draft ?? '';

  const selection = () => ({ provider: provider.value, cwd: folder.value });
  const saveDraft = () => vscode.setState({ draft: prompt.value });
  const post = (type, extra = {}) => vscode.postMessage({ type, ...selection(), ...extra });
  const labels = { user: copy.you, assistant: copy.agent, tool: copy.tool, status: copy.status, error: copy.error };

  function fillSelect(select, choices, selected) {
    const next = JSON.stringify(choices);
    if (select.dataset.signature === next && select.value === selected) return;
    select.dataset.signature = next;
    select.replaceChildren();
    for (const choice of choices ?? []) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = choice.label;
      if (choice.description) option.title = choice.description;
      select.append(option);
    }
    if (selected) select.value = selected;
  }

  function inline(parent, text) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
    const parts = text.split(pattern);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`')) {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        parent.append(code);
      } else if (part.startsWith('**') && part.endsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = part.slice(2, -2);
        parent.append(strong);
      } else if (part.startsWith('[')) {
        const match = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (!match) parent.append(part);
        else {
          const link = document.createElement('a');
          link.href = match[2];
          link.textContent = match[1];
          link.rel = 'noreferrer noopener';
          parent.append(link);
        }
      } else parent.append(part);
    }
  }

  function renderRich(parent, text) {
    parent.replaceChildren();
    const lines = text.split('\n');
    let index = 0;
    const appendParagraph = (paragraph) => {
      if (!paragraph.length) return;
      const node = document.createElement('p');
      inline(node, paragraph.join('\n'));
      parent.append(node);
    };
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line.startsWith('```')) {
        const code = [];
        const language = line.slice(3).trim();
        index += 1;
        while (index < lines.length && !(lines[index] ?? '').startsWith('```')) code.push(lines[index++] ?? '');
        if (index < lines.length) index += 1;
        const block = document.createElement('pre');
        block.className = 'code';
        if (language) block.dataset.lang = language;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy secondary';
        button.textContent = copy.copy;
        button.addEventListener('click', () => navigator.clipboard?.writeText(code.join('\n')).catch(() => undefined));
        const body = document.createElement('code');
        body.textContent = code.join('\n');
        block.append(button, body);
        parent.append(block);
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        const node = document.createElement(heading[1].length === 1 ? 'h2' : 'h3');
        node.textContent = heading[2];
        parent.append(node);
        index += 1;
        continue;
      }
      if (!line.trim()) { index += 1; continue; }
      const paragraph = [];
      while (index < lines.length && (lines[index] ?? '').trim() && !(lines[index] ?? '').startsWith('```') && !/^(#{1,3})\s+/.test(lines[index] ?? '')) {
        paragraph.push(lines[index++] ?? '');
      }
      appendParagraph(paragraph);
    }
  }

  function renderMessage(message) {
    let node = nodes.get(message.id);
    if (!node) {
      node = document.createElement('article');
      node.className = `message ${message.role}`;
      const label = document.createElement('strong');
      label.textContent = labels[message.role] ?? message.role;
      const body = document.createElement('div');
      body.className = 'body';
      node.append(label, body);
      nodes.set(message.id, node);
      messages.append(node);
    }
    const body = node.querySelector('.body');
    if (body.dataset.text === message.text) return;
    body.dataset.text = message.text;
    if (message.role === 'assistant') renderRich(body, message.text);
    else if (message.role === 'tool' || message.meta?.type === 'thinking') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = message.text.split('\n')[0]?.slice(0, 180) || message.role;
      const rest = document.createElement('pre');
      rest.textContent = message.text;
      details.append(summary, rest);
      details.open = message.text.length < 240;
      body.replaceChildren(details);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = message.text;
      body.replaceChildren(pre);
    }
  }

  function button(label, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  }

  function renderPending() {
    const host = element('pending');
    host.replaceChildren();
    const permission = state?.pendingPermission;
    const plan = state?.pendingPlan;
    const question = state?.pendingQuestion;
    if (!permission && !plan && !question) { host.hidden = true; return; }
    host.hidden = false;
    const card = document.createElement('section');
    card.className = 'card';
    if (permission) {
      const title = document.createElement('h3');
      title.textContent = permission.title;
      const detail = document.createElement('pre');
      detail.textContent = permission.detail;
      card.append(title, detail, button(copy.allow, () => post('resolvePermission', { id: permission.id, decision: 'allow-once' })),
        button(copy.session, () => post('resolvePermission', { id: permission.id, decision: 'allow-session' })),
        button(copy.deny, () => post('resolvePermission', { id: permission.id, decision: 'deny' })));
    } else if (plan) {
      const title = document.createElement('h3');
      title.textContent = plan.name || 'Plan';
      const body = document.createElement('div');
      renderRich(body, `${plan.overview ? `${plan.overview}\n\n` : ''}${plan.plan}`);
      card.append(title, body, button(copy.approve, () => post('resolvePlan', { id: plan.id, decision: 'accepted' })),
        button(copy.reject, () => post('resolvePlan', { id: plan.id, decision: 'rejected' })));
    } else if (question) {
      const title = document.createElement('h3');
      title.textContent = question.title || copy.answer;
      card.append(title);
      for (const item of question.questions) {
        const label = document.createElement('p');
        label.textContent = item.prompt;
        card.append(label);
        for (const option of item.options) {
          card.append(button(option.label, () => post('resolveQuestion', { id: question.id, answers: { [item.id]: [option.id] } })));
        }
      }
    }
    host.append(card);
  }

  function renderLists() {
    const history = element('historyList');
    const changes = element('changeList');
    history.replaceChildren();
    changes.replaceChildren();
    const sessions = state?.sessions ?? [];
    if (!sessions.length) history.textContent = copy.none;
    for (const session of sessions) {
      history.append(button(session.title || session.id, () => post('restoreSession', { id: session.id })));
    }
    const files = state?.changes ?? [];
    if (!files.length) changes.textContent = copy.none;
    for (const change of files) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      const name = change.path.split(/[\\/]/).pop();
      row.append(button(`${change.kind} ${name}`, () => post('openFile', { path: change.path })));
      row.append(button(copy.open, () => post('openDiff', { path: change.path })));
      if (change.canRevert) row.append(button(copy.revert, () => post('revertFile', { path: change.path })));
      changes.append(row);
    }
    element('changes').textContent = files.length ? `${copy.changes} (${files.length})` : copy.changes;
  }

  function renderQueue() {
    const tray = element('queueTray');
    tray.replaceChildren();
    for (const item of state?.queue ?? []) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      const label = document.createElement('span');
      label.textContent = item.text;
      row.append(label, button(copy.sendNow, () => post('sendNow', { id: item.id })), button(copy.remove, () => post('removeQueued', { id: item.id })));
      if (capabilities?.steer && state?.busy) row.append(button(copy.steer, () => post('steer', { id: item.id })));
      tray.append(row);
    }
  }

  function renderImages() {
    const tray = element('attachmentTray');
    tray.replaceChildren();
    for (const [index, image] of images.entries()) {
      const imageNode = document.createElement('img');
      imageNode.className = 'thumb';
      imageNode.alt = image.name || 'image';
      imageNode.src = `data:${image.mimeType};base64,${image.data}`;
      const remove = button('×', () => { images.splice(index, 1); renderImages(); });
      const wrap = document.createElement('span');
      wrap.className = 'chip';
      wrap.append(imageNode, remove);
      tray.append(wrap);
    }
  }

  function render(data) {
    state = data.state;
    capabilities = data.capabilities;
    controls = data.controls;
    pendingSend = false;
    rendering = true;
    const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const folders = JSON.stringify(data.folders);
    if (signature !== folders) {
      signature = folders;
      folder.replaceChildren();
      for (const item of data.folders) {
        const option = document.createElement('option');
        option.value = item.path;
        option.textContent = item.name;
        option.title = item.path;
        folder.append(option);
      }
    }
    provider.value = state.selection.provider;
    model.textContent = `${data.modelLabel} ▾`;
    folder.value = state.selection.cwd;
    fillSelect(element('mode'), capabilities?.modes, controls?.mode);
    fillSelect(element('sandbox'), capabilities?.sandbox, controls?.sandbox);
    fillSelect(element('approval'), capabilities?.approval, controls?.approval);
    fillSelect(element('backend'), provider.value === 'cursor'
      ? [{ id: 'sdk', label: 'SDK' }, { id: 'acp', label: 'ACP' }]
      : [{ id: 'sdk', label: 'SDK' }, { id: 'app-server', label: 'App Server' }], controls?.backend);
    fillSelect(element('webSearch'), capabilities?.webSearch, controls?.webSearch || '');
    element('network').checked = Boolean(controls?.network);
    element('network').disabled = !capabilities?.networkToggle;
    element('webSearch').disabled = !(capabilities?.webSearch?.length);
    element('approval').disabled = !(capabilities?.approval?.length);
    element('autoApprove').setAttribute('aria-pressed', String(Boolean(state.autoApprove)));
    const ids = new Set(state.messages.map((message) => message.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    messages.querySelector('.empty')?.remove();
    if (!state.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = copy.empty;
      messages.append(empty);
    }
    for (const message of state.messages) renderMessage(message);
    const locked = state.busy;
    for (const id of ['provider', 'model', 'modelDetails', 'folder', 'newChat', 'login', 'apiKey', 'backend', 'sandbox', 'approval', 'mode']) element(id).disabled = locked;
    element('send').disabled = !folder.value;
    element('send').textContent = locked ? copy.queue : copy.send;
    element('stop').hidden = !locked;
    const status = state.pendingPermission || state.pendingPlan || state.pendingQuestion ? copy.approval
      : locked ? copy.running : folder.value ? copy.ready : copy.folder;
    const usage = state.usage ? ` · in ${state.usage.inputTokens} / out ${state.usage.outputTokens}` : '';
    element('status').textContent = status + usage;
    element('connection').textContent = state.status || '';
    renderPending();
    renderLists();
    renderQueue();
    rendering = false;
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  function configured(extra) {
    if (rendering) return;
    post('configure', {
      mode: element('mode').value, sandbox: element('sandbox').value, approval: element('approval').value,
      backend: element('backend').value, network: element('network').checked, webSearch: element('webSearch').value, ...extra,
    });
  }

  function addImages(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/') || images.length >= 4) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const source = String(reader.result || '');
        const data = source.slice(source.indexOf(',') + 1);
        images.push({ mimeType: file.type === 'image/jpg' ? 'image/jpeg' : file.type, data, name: file.name });
        renderImages();
      };
      reader.readAsDataURL(file);
    }
  }

  function refreshSuggestions() {
    const token = caretToken(prompt.value, prompt.selectionStart);
    suggestionToken = token;
    if (!token) { element('suggest').hidden = true; return; }
    const requestId = ++suggestionRequest;
    setTimeout(() => {
      if (requestId !== suggestionRequest) return;
      post('suggest', { kind: token.kind, query: token.query, requestId });
    }, 120);
  }

  function caretToken(value, caret) {
    const until = value.slice(0, caret);
    const file = until.match(/(^|\s)@([^\s@]*)$/);
    if (file) return { kind: 'file', query: file[2], start: until.length - file[2].length - 1 };
    const slash = until.match(/(^|\n)\/([\w-]*)$/);
    if (slash) return { kind: 'slash', query: slash[2], start: until.length - slash[2].length - 1 };
    return undefined;
  }

  function applySuggestion(item) {
    if (!suggestionToken || !item) return;
    const caret = prompt.selectionStart;
    const insert = suggestionToken.kind === 'file' ? `@${item.token.includes(' ') ? `"${item.token}"` : item.token} ` : `/${item.token} `;
    prompt.value = `${prompt.value.slice(0, suggestionToken.start)}${insert}${prompt.value.slice(caret)}`;
    element('suggest').hidden = true;
    saveDraft();
    prompt.focus();
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data);
    if (data.type === 'error') {
      pendingSend = false;
      element('status').textContent = data.text;
    }
    if (data.type === 'suggestions' && data.requestId === suggestionRequest) {
      suggestions = data.items ?? [];
      suggestionIndex = 0;
      const menu = element('suggest');
      menu.replaceChildren();
      menu.hidden = !suggestions.length;
      for (const [index, item] of suggestions.entries()) {
        const node = button(`${item.label}${item.description ? `  ${item.description}` : ''}`, () => applySuggestion(item));
        if (index === 0) node.classList.add('active');
        menu.append(node);
      }
    }
    if (data.type === 'inspector') {
      const panel = element('inspector');
      panel.hidden = false;
      element('inspectorTitle').textContent = data.title || '';
      element('inspectorBody').textContent = data.text || '';
    }
    if (data.type === 'insert') {
      prompt.value = `${prompt.value}${prompt.value && !prompt.value.endsWith('\n') ? '\n' : ''}${data.text || ''}`;
      saveDraft();
      prompt.focus();
    }
  });

  provider.addEventListener('change', () => { if (!rendering) post('select'); });
  folder.addEventListener('change', () => { if (!rendering) post('select'); });
  for (const id of ['mode', 'sandbox', 'approval', 'backend', 'webSearch']) element(id).addEventListener('change', () => configured());
  element('network').addEventListener('change', () => configured());
  model.addEventListener('click', () => post('chooseModel'));
  for (const id of ['newChat', 'stop', 'login', 'apiKey', 'settings', 'logs', 'modelDetails', 'diagnose', 'usage', 'instructions']) {
    element(id).addEventListener('click', () => post(id));
  }
  element('autoApprove').addEventListener('click', () => post('toggleAutoApprove'));
  element('history').addEventListener('click', () => { element('historyList').hidden = !element('historyList').hidden; if (!element('historyList').hidden) post('refreshSessions'); });
  element('changes').addEventListener('click', () => { element('changeList').hidden = !element('changeList').hidden; });
  element('attach').addEventListener('click', () => element('imageInput').click());
  element('imageInput').addEventListener('change', () => { addImages(element('imageInput').files || []); element('imageInput').value = ''; });
  for (const [id, kind] of [['activeFile', 'file'], ['selectionBtn', 'selection'], ['problems', 'problems'], ['git', 'git'], ['terminalBtn', 'terminal']]) {
    element(id).addEventListener('click', () => post('attach', { kind }));
  }
  element('inspectorClose').addEventListener('click', () => { element('inspector').hidden = true; });
  prompt.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  });
  element('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state || pendingSend || !folder.value || (!prompt.value.trim() && !images.length)) return;
    pendingSend = true;
    element('send').disabled = true;
    post(state.busy ? 'enqueue' : 'send', { prompt: prompt.value, images });
    prompt.value = '';
    images.length = 0;
    renderImages();
    saveDraft();
  });
  prompt.addEventListener('input', () => { saveDraft(); refreshSuggestions(); });
  prompt.addEventListener('keydown', (event) => {
    if (!element('suggest').hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab')) {
      event.preventDefault();
      suggestionIndex = event.key === 'ArrowUp' ? Math.max(0, suggestionIndex - 1) : Math.min(suggestions.length - 1, suggestionIndex + 1);
      [...element('suggest').children].forEach((node, index) => node.classList.toggle('active', index === suggestionIndex));
      if (event.key === 'Tab') applySuggestion(suggestions[suggestionIndex]);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      if (!element('suggest').hidden && suggestions[suggestionIndex]) {
        event.preventDefault();
        applySuggestion(suggestions[suggestionIndex]);
        return;
      }
      event.preventDefault();
      element('composer').requestSubmit();
    }
  });
  post('ready');
})();
