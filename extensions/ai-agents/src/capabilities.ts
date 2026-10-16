import type { AgentMode, Backend, ModelApplyMode, Provider } from './types.js';

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderCapabilities {
  provider: Provider;
  backend: Backend;
  modes: Choice[];
  sandbox: Choice[];
  approval: Choice[];
  webSearch: Choice[];
  images: boolean;
  sessionList: boolean;
  resume: boolean;
  fork: boolean;
  compact: boolean;
  steer: boolean;
  interactiveApproval: boolean;
  planApproval: boolean;
  questions: boolean;
  review: boolean;
  usage: boolean;
  rateLimits: boolean;
  mcp: boolean;
  skills: boolean;
  rules: boolean;
  todos: boolean;
  subagents: boolean;
  networkToggle: boolean;
  additionalDirectories: boolean;
  modelSettings: ModelApplyMode;
}

export interface AgentControls {
  mode: AgentMode;
  sandbox: string;
  approval: string;
  backend: Backend;
  network: boolean;
  webSearch: string;
  additionalDirectories: string[];
}

const agentPlan: Choice[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'plan', label: 'Plan' },
];

export function capabilitiesFor(provider: Provider, backend: Backend): ProviderCapabilities {
  if (provider === 'cursor' && backend === 'acp') {
    return {
      provider, backend,
      modes: [...agentPlan, { id: 'ask', label: 'Ask' }],
      sandbox: [
        { id: 'enabled', label: 'Sandbox', description: 'Cursor CLI のサンドボックスを有効にして起動します。' },
        { id: 'disabled', label: 'Off', description: 'CLI の --sandbox disabled で起動します。保護は弱くなります。' },
      ],
      approval: [],
      webSearch: [],
      images: true,
      sessionList: true,
      resume: true,
      fork: false,
      compact: false,
      steer: false,
      interactiveApproval: true,
      planApproval: true,
      questions: true,
      review: false,
      usage: false,
      rateLimits: false,
      mcp: true,
      skills: true,
      rules: true,
      todos: true,
      subagents: true,
      networkToggle: false,
      additionalDirectories: false,
      modelSettings: 'unsupported',
    };
  }
  if (provider === 'cursor') {
    return {
      provider, backend: 'sdk',
      modes: agentPlan,
      sandbox: [
        { id: 'enabled', label: 'Sandbox', description: 'local.sandboxOptions.enabled を有効にします。範囲外の操作は対話確認できず拒否されます。' },
        { id: 'disabled', label: 'Off', description: 'サンドボックスを無効にします。ローカルSDKは確認なしで操作を実行します。' },
      ],
      approval: [],
      webSearch: [],
      images: true,
      sessionList: true,
      resume: true,
      fork: false,
      compact: false,
      steer: false,
      interactiveApproval: false,
      planApproval: false,
      questions: false,
      review: false,
      usage: true,
      rateLimits: false,
      mcp: true,
      skills: true,
      rules: true,
      todos: true,
      subagents: true,
      networkToggle: false,
      additionalDirectories: true,
      modelSettings: 'next-send',
    };
  }
  if (backend === 'app-server') {
    return {
      provider: 'codex', backend,
      modes: [
        { id: 'agent', label: 'Default' },
        { id: 'plan', label: 'Plan' },
      ],
      sandbox: [
        { id: 'read-only', label: 'Read-only' },
        { id: 'workspace-write', label: 'Workspace write' },
        { id: 'danger-full-access', label: 'Full access', description: 'サンドボックスを無効にします。' },
      ],
      approval: [
        { id: 'untrusted', label: 'Untrusted' },
        { id: 'on-request', label: 'On request' },
        { id: 'never', label: 'Never' },
      ],
      webSearch: [
        { id: '', label: 'Default' },
        { id: 'disabled', label: 'Disabled' },
        { id: 'cached', label: 'Cached' },
        { id: 'live', label: 'Live' },
      ],
      images: true,
      sessionList: true,
      resume: true,
      fork: true,
      compact: true,
      steer: true,
      interactiveApproval: true,
      planApproval: true,
      questions: true,
      review: true,
      usage: true,
      rateLimits: true,
      mcp: true,
      skills: true,
      rules: true,
      todos: true,
      subagents: true,
      networkToggle: true,
      additionalDirectories: true,
      modelSettings: 'new-session',
    };
  }
  return {
    provider: 'codex', backend: 'sdk',
    modes: [{ id: 'agent', label: 'Agent' }],
    sandbox: [
      { id: 'read-only', label: 'Read-only' },
      { id: 'workspace-write', label: 'Workspace write' },
      { id: 'danger-full-access', label: 'Full access', description: 'サンドボックスを無効にします。' },
    ],
    approval: [
      { id: 'never', label: 'Never', description: 'SDK の exec は対話承認を受け取れません。' },
    ],
    webSearch: [
      { id: '', label: 'Default' },
      { id: 'disabled', label: 'Disabled' },
      { id: 'cached', label: 'Cached' },
      { id: 'live', label: 'Live' },
    ],
    images: true,
    sessionList: true,
    resume: true,
    fork: false,
    compact: false,
    steer: false,
    interactiveApproval: false,
    planApproval: false,
    questions: false,
    review: false,
    usage: true,
    rateLimits: false,
    mcp: true,
    skills: true,
    rules: true,
    todos: true,
    subagents: false,
    networkToggle: true,
    additionalDirectories: true,
    modelSettings: 'new-session',
  };
}

export function modelApplyMode(provider: Provider, backend: Backend): ModelApplyMode {
  return capabilitiesFor(provider, backend).modelSettings;
}

export function defaultControls(provider: Provider, backend: Backend): AgentControls {
  return {
    mode: 'agent',
    sandbox: provider === 'cursor' ? 'enabled' : 'workspace-write',
    approval: 'never',
    backend,
    network: false,
    webSearch: '',
    additionalDirectories: [],
  };
}

export function normalizeControls(provider: Provider, controls: AgentControls): AgentControls {
  const capabilities = capabilitiesFor(provider, controls.backend);
  const mode = capabilities.modes.some((choice) => choice.id === controls.mode) ? controls.mode : 'agent';
  const sandbox = capabilities.sandbox.some((choice) => choice.id === controls.sandbox)
    ? controls.sandbox
    : defaultControls(provider, controls.backend).sandbox;
  const approval = capabilities.approval.some((choice) => choice.id === controls.approval) || capabilities.approval.length === 0
    ? (capabilities.approval.length === 0 ? 'never' : controls.approval)
    : 'never';
  const webSearch = capabilities.webSearch.some((choice) => choice.id === controls.webSearch) ? controls.webSearch : '';
  return {
    ...controls,
    mode,
    sandbox,
    approval: capabilities.approval.some((choice) => choice.id === approval) ? approval : 'never',
    webSearch,
    network: capabilities.networkToggle ? controls.network : false,
    additionalDirectories: capabilities.additionalDirectories ? controls.additionalDirectories : [],
  };
}
