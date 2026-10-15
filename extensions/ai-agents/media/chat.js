/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const element = (id) => document.getElementById(id);
  const provider = element('provider');
  const model = element('model');
  const folder = element('folder');
  const prompt = element('prompt');
  const messages = element('messages');
  const nodes = new Map();
  let state;
  let pending = false;
  let signature = '';
  prompt.value = vscode.getState()?.draft ?? '';

  const selection = () => ({ provider: provider.value, cwd: folder.value });
  const saveDraft = () => vscode.setState({ draft: prompt.value });
  const post = (type) => vscode.postMessage({ type, ...selection() });

  function render(data) {
    state = data.state;
    pending = false;
    const stickToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const nextSignature = JSON.stringify(data.folders);
    if (signature !== nextSignature) {
      signature = nextSignature;
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
    model.title = 'モデル一覧から選択';
    folder.value = state.selection.cwd;
    const ids = new Set(state.messages.map((message) => message.id));
    for (const [id, node] of nodes) {
      if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    }
    messages.querySelector('.empty')?.remove();
    if (!state.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'エージェントを選び、質問や変更を依頼してください。会話は続けて送れます。エージェント・モデル・フォルダを切り替えると新しい会話になります。';
      messages.append(empty);
    }
    const labels = { user: 'あなた', assistant: 'エージェント', tool: '実行', status: '状況', error: 'エラー' };
    for (const message of state.messages) {
      let node = nodes.get(message.id);
      if (!node) {
        node = document.createElement('article');
        node.className = `message ${message.role}`;
        const label = document.createElement('strong');
        label.textContent = labels[message.role] ?? message.role;
        node.append(label, document.createElement('pre'));
        nodes.set(message.id, node);
        messages.append(node);
      }
      // All agent output is text: no HTML, scripts, or command links are interpreted.
      const body = node.querySelector('pre');
      if (body.textContent !== message.text) body.textContent = message.text;
    }
    const locked = state.busy;
    for (const id of ['provider', 'model', 'modelDetails', 'folder', 'newChat', 'login', 'apiKey']) element(id).disabled = locked;
    element('send').disabled = locked || !folder.value;
    element('stop').hidden = !locked;
    element('status').textContent = locked ? 'エージェント実行中…' : folder.value ? '準備完了' : '作業フォルダを開いてください';
    if (stickToBottom) messages.scrollTop = messages.scrollHeight;
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data);
    if (data.type === 'error') {
      pending = false;
      element('status').textContent = data.text;
      element('send').disabled = Boolean(state?.busy) || !folder.value;
    }
  });
  provider.addEventListener('change', () => post('select'));
  model.addEventListener('click', () => post('chooseModel'));
  folder.addEventListener('change', () => post('select'));
  for (const id of ['newChat', 'stop', 'login', 'apiKey', 'settings', 'logs', 'modelDetails']) {
    element(id).addEventListener('click', () => post(id));
  }
  element('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state || state.busy || pending || !folder.value || !prompt.value.trim()) return;
    pending = true;
    element('send').disabled = true;
    vscode.postMessage({ type: 'send', ...selection(), prompt: prompt.value });
    prompt.value = '';
    saveDraft();
  });
  prompt.addEventListener('input', saveDraft);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      element('composer').requestSubmit();
    }
  });
  post('ready');
})();
