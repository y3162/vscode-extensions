/**
 * Default folder icon associations
 * Keys are icon file basenames (without folder_ prefix)
 */

type FolderIcons = Record<string, {
  folderNames?: Array<string>
}>

// @keep-sorted
const folderIcons: FolderIcons = {
  'adcrawl': {
    folderNames: ['adcrawl', 'ad-crawl', 'ad_crawl'],
  },
  'admin': {
    folderNames: [
      'admin',
      'admins',
      'manager',
      'managers',
      'moderator',
      'moderators',
    ],
  },
  'agents': {
    folderNames: ['.agents'],
  },
  'android': {
    folderNames: ['android', 'android_automaton', 'apk_tools'],
  },
  'animation': {
    folderNames: [
      'anim',
      'anims',
      'animation',
      'animations',
      'animated',
    ],
  },
  'api': {
    folderNames: [
      'api',
      'apis',
      'restapi',
    ],
  },
  'app': {
    folderNames: [
      'app',
      'apps',
    ],
  },
  'apple': {
    folderNames: ['ios', 'ios_automaton', 'ios_automaton_alt', 'ios_patch'],
  },
  'arxiv': {
    folderNames: ['arxiv', '.arxiv'],
  },
  'assets': {
    folderNames: [
      'asset',
      'assets',
      'resources',
    ],
  },
  'audio': {
    folderNames: [
      'aud',
      'auds',
      'audio',
      'audios',
      'music',
      'sound',
      'sounds',
    ],
  },
  'audit': {
    folderNames: [
      'audit',
      'audits',
    ],
  },
  'autotouch': {
    folderNames: ['autotouch'],
  },
  'aws': {
    folderNames: [
      'aws',
      '.aws',
    ],
  },
  'azure-devops': {
    folderNames: ['.azure-devops', '.azuredevops'],
  },
  'azure-pipelines': {
    folderNames: ['.azure-pipelines'],
  },
  'benchmark': {
    folderNames: [
      'benchmark',
      'benchmarks',
      'bench',
      'benches',
      'performance',
      'measure',
      'measures',
      'measurement',
    ],
  },
  'caddy': {
    folderNames: [
      '.caddy',
      '.caddyfiles',
      'caddy',
      'caddyfiles',
    ],
  },
  'cargo': {
    folderNames: [
      '.cargo',
    ],
  },
  'checkpoint': {
    folderNames: ['checkpoint', 'checkpoints', '.checkpoint', '.checkpoints'],
  },
  'chrome': {
    folderNames: ['chrome'],
  },
  'circle-ci': {
    folderNames: ['.circleci'],
  },
  'client': {
    folderNames: [
      'client',
      'clients',
      'frontend',
      'frontends',
      'pwa',
    ],
  },
  'cloud': {
    folderNames: ['cloud'],
  },
  'codex': {
    folderNames: ['.codex'],
  },
  'command': {
    folderNames: [
      'command',
      'commands',
      'cmd',
      'cli',
      'clis',
    ],
  },
  'components': {
    folderNames: [
      'components',
      'widget',
      'widgets',
      'fragments',
    ],
  },
  'composables': {
    folderNames: [
      'composable',
      'composables',
    ],
  },
  'config': {
    folderNames: [
      'cfg',
      'cfgs',
      'conf',
      'confs',
      '.config',
      'config',
      'configs',
      'configuration',
      'configurations',
      'setting',
      '.setting',
      'settings',
      '.settings',
      'META-INF',
      'option',
      'options',
    ],
  },
  'connection': {
    folderNames: [
      'connection',
      'connections',
      'integration',
      'integrations',
      'http',
      'request',
      'socket',
      'websocket',
    ],
  },
  'constant': {
    folderNames: [
      'constant',
      'constants',
    ],
  },
  'content': {
    folderNames: [
      'content',
      'contents',
    ],
  },
  'controllers': {
    folderNames: [
      'controller',
      'controllers',
      'service',
      'services',
      'provider',
      'providers',
      'handler',
      'handlers',
    ],
  },
  'core': {
    folderNames: ['core'],
  },
  'coverage': {
    folderNames: [
      'coverage',
      '.nyc-output',
      '.nyc_output',
      'e2e',
      'it',
      'integration-test',
      'integration-tests',
      '__integration-test__',
      '__integration-tests__',
    ],
  },
  'cursor': {
    folderNames: ['.cursor'],
  },
  'cypress': {
    folderNames: [
      'cypress',
      '.cypress',
    ],
  },
  'database': {
    folderNames: [
      'db',
      'database',
      'databases',
      'sql',
      'android_sqlite3',
      'ios_sqlite3',
      'android_ad_dbs',
      'data',
      '_data',
    ],
  },
  'debug': {
    folderNames: [
      'debug',
      'debugging',
    ],
  },
  'devcontainer': {
    folderNames: ['.devcontainer'],
  },
  'direnv': {
    folderNames: ['.direnv'],
  },
  'dist': {
    folderNames: [
      'dist',
      'dist-newstyle',
      'out',
      'build',
      'release',
      'bin',
      '.output',
    ],
  },
  'docker': {
    folderNames: [
      'docker',
      'dockerfiles',
      '.docker',
    ],
  },
  'docs': {
    folderNames: [
      '_post',
      '_posts',
      'doc',
      'docs',
      'document',
      'documents',
      'documentation',
      'post',
      'posts',
      'article',
      'articles',
    ],
  },
  'dopamine': {
    folderNames: ['dopamine'],
  },
  'download': {
    folderNames: [
      'downloads',
      'download',
    ],
  },
  'drizzle-orm': {
    folderNames: ['drizzle'],
  },
  'examples': {
    folderNames: [
      'demo',
      'demos',
      'example',
      'examples',
      'sample',
      'samples',
      'sample-data',
      'test_data',
    ],
  },
  'facebook': {
    folderNames: ['facebook', 'facebook_ad', 'facebook_native'],
  },
  'fastlane': {
    folderNames: ['fastlane', '.fastlane'],
  },
  'firebase': {
    folderNames: [
      'firebase',
      '.firebase',
    ],
  },
  'fonts': {
    folderNames: [
      'font',
      'fonts',
    ],
  },
  'forgejo': {
    folderNames: ['.forgejo'],
  },
  'frida': {
    folderNames: ['frida', 'ios_frida', 'android_frida', 'frida-envs'],
  },
  'functions': {
    folderNames: [
      'func',
      'funcs',
      'function',
      'functions',
      'lambda',
      'lambdas',
      'logic',
      'math',
      'maths',
      'calc',
      'calcs',
      'calculation',
      'calculations',
    ],
  },
  'fvm': {
    folderNames: ['.fvm'],
  },
  'git': {
    folderNames: [
      '.git',
      'patches',
      'githooks',
      '.githooks',
      'submodules',
      '.submodules',
    ],
  },
  'github': {
    folderNames: [
      '.github',
      'github',
    ],
  },
  'gitlab': {
    folderNames: ['.gitlab'],
  },
  'google': {
    folderNames: ['google'],
  },
  'gradle': {
    folderNames: ['gradle', '.gradle'],
  },
  'graphql': {
    folderNames: ['graphql', 'gql'],
  },
  'gunosy': {
    folderNames: ['gunosy'],
  },
  'hooks': {
    folderNames: ['hook', 'hooks', 'trigger', 'triggers'],
  },
  'husky': {
    folderNames: [
      'husky',
      '.husky',
    ],
  },
  'images': {
    folderNames: [
      '_images',
      '_image',
      '_imgs',
      '_img',
      'images',
      'image',
      'imgs',
      'img',
      'sample_image',
      'sponavi_images',
      'image_template_matching',
      'icons',
      'icon',
      'icos',
      'ico',
      'figures',
      'figure',
      'figs',
      'fig',
      'screenshot',
      'screenshots',
      'screengrab',
      'screengrabs',
      'pic',
      'pics',
      'picture',
      'pictures',
      'photo',
      'photos',
      'photograph',
      'photographs',
    ],
  },
  'include': {
    folderNames: ['include', 'includes'],
  },
  'instagram': {
    folderNames: ['instagram', 'instagram_curl'],
  },
  'intellij': {
    folderNames: ['.idea'],
  },
  'javascript': {
    folderNames: ['js', 'javascript'],
  },
  'kubernetes': {
    folderNames: [
      'kubernetes',
      '.kubernetes',
      'k8s',
      '.k8s',
    ],
  },
  'layouts': {
    folderNames: [
      'layout',
      'layouts',
      '_layouts',
    ],
  },
  'lemon8': {
    folderNames: ['lemon8'],
  },
  'lib': {
    folderNames: [
      'lib',
      'libs',
      'library',
      'libraries',
      '.lib',
      '.libs',
      '.library',
      '.libraries',
    ],
  },
  'line': {
    folderNames: ['line', 'line_blog', 'line_native', 'line_ad_crawler', 'line_news_ad_data'],
  },
  'linux': {
    folderNames: ['linux'],
  },
  'locales': {
    folderNames: [
      'i18n',
      'internationalization',
      'lang',
      'langs',
      'language',
      'languages',
      'locale',
      'locales',
      'l10n',
      'localization',
      'translation',
      'translate',
      'translations',
      '.tx',
    ],
  },
  'log': {
    folderNames: ['log', 'logs', '.log', '.logs'],
  },
  'lua': {
    folderNames: ['lua', 'lua_template'],
  },
  'luau': {
    folderNames: ['luau_packages'],
  },
  'lune': {
    folderNames: ['lune_packages'],
  },
  'macos': {
    folderNames: ['mac', 'macos'],
  },
  'media': {
    folderNames: ['media'],
  },
  'messages': {
    folderNames: ['message', 'messages'],
  },
  'middleware': {
    folderNames: [
      'middleware',
      'middlewares',
    ],
  },
  'mocks': {
    folderNames: [
      '_draft',
      '_drafts',
      'mock',
      'mocks',
      'fixture',
      'fixtures',
      'draft',
      'drafts',
      'concept',
      'concepts',
      'sketch',
      'sketches',
    ],
  },
  'moonrepo': {
    folderNames: ['.moon'],
  },
  'next': {
    folderNames: ['.next'],
  },
  'nix': {
    folderNames: ['nix'],
  },
  'node': {
    folderNames: ['node_modules'],
  },
  'nuxt': {
    folderNames: [
      'nuxt',
      '.nuxt',
    ],
  },
  'packages': {
    folderNames: [
      'package',
      'packages',
      'debs',
      'pkg',
      'pkgs',
      'crate',
      'crates',
    ],
  },
  'pangle': {
    folderNames: ['pangle'],
  },
  'pesde': {
    folderNames: ['.pesde', 'pesde'],
  },
  'pinterest': {
    folderNames: ['pinterest'],
  },
  'plugins': {
    folderNames: [
      'plugin',
      'plugins',
      '_plugins',
      'mod',
      'mods',
      'modding',
      'extension',
      'extensions',
      'addon',
      'addons',
      'module',
      'modules',
    ],
  },
  'pre-commit': {
    folderNames: ['pre-commit-channel'],
  },
  'prisma': {
    folderNames: ['prisma'],
  },
  'private': {
    folderNames: ['private'],
  },
  'proto': {
    folderNames: [
      'protobuf',
      'protobufs',
      'proto',
      'protos',
    ],
  },
  'public': {
    folderNames: [
      '_site',
      'public',
      'www',
      'wwwroot',
      'web',
      'website',
      'site',
      'browser',
      'browsers',
    ],
  },
  'queue': {
    folderNames: [
      'queue',
      'queues',
      'bull',
      'mq',
    ],
  },
  'redux': {
    folderNames: ['redux'],
  },
  'renovate': {
    folderNames: [
      '.renovate',
      'renovate',
    ],
  },
  'roblox': {
    folderNames: [
      'roblox_packages',
      'roblox_server_packages',
    ],
  },
  'rooter': {
    folderNames: ['rooter', 'rooter_inc', 'rooterinc', 'rooterinc.bitbucket.io'],
  },
  'routes': {
    folderNames: [
      'routes',
      'router',
      'routers',
    ],
  },
  'rules': {
    folderNames: ['rules'],
  },
  'safari': {
    folderNames: ['safari'],
  },
  'sass': {
    folderNames: [
      'sass',
      '_sass',
      'scss',
      '_scss',
    ],
  },
  'scripts': {
    folderNames: [
      'script',
      'scripts',
      'scripting',
    ],
  },
  'security': {
    folderNames: ['security'],
  },
  'server': {
    folderNames: [
      'server',
      'servers',
      'backend',
    ],
  },
  'shared': {
    folderNames: [
      'share',
      'shared',
      'common',
      'support',
    ],
  },
  'skills': {
    folderNames: ['skill', 'skills'],
  },
  'smartnews': {
    folderNames: ['smartnews'],
  },
  'speech': {
    folderNames: ['asr', 'se'],
  },
  'spotify': {
    folderNames: ['spotify'],
  },
  'src': {
    folderNames: [
      'src',
      'srcs',
      'source',
      'sources',
      'code',
    ],
  },
  'storybook': {
    folderNames: [
      '.storybook',
      'storybook',
      'stories',
      '__stories__',
    ],
  },
  'styles': {
    folderNames: [
      'css',
      'stylesheet',
      'stylesheets',
      'style',
      'styles',
    ],
  },
  'svg': {
    folderNames: [
      'svg',
      'svgs',
    ],
  },
  'tauri': {
    folderNames: ['src-tauri'],
  },
  'temp': {
    folderNames: [
      'temp',
      '.temp',
      'tmp',
      '.tmp',
      'cached',
      'cache',
      '.cache',
    ],
  },
  'templates': {
    folderNames: [
      'template',
      'templates',
    ],
  },
  'tests': {
    folderNames: [
      'test',
      'tests',
      'testing',
      'unit',
      'feature_test',
      '__tests__',
      '__snapshots__',
      '__mocks__',
      '__fixtures__',
      '__test__',
      'spec',
      'specs',
    ],
  },
  'themes': {
    folderNames: [
      'theme',
      'themes',
    ],
  },
  'theos': {
    folderNames: ['theos', 'theosat', 'autotouch_alt'],
  },
  'threads': {
    folderNames: ['threads'],
  },
  'tiktok': {
    folderNames: ['tiktok', 'tiktok_lite', 'tiktok_swiper'],
  },
  'turbo': {
    folderNames: [
      '.turbo',
    ],
  },
  'tver': {
    folderNames: ['tver', 'tver-androidtv'],
  },
  'twitter': {
    folderNames: ['twitter', 'twitter_cookie_updater'],
  },
  'types': {
    folderNames: [
      'typings',
      '@types',
      'types',
    ],
  },
  'upload': {
    folderNames: [
      'uploads',
      'upload',
    ],
  },
  'utils': {
    folderNames: [
      'util',
      'utils',
      'utility',
      'utilities',
    ],
  },
  'venv': {
    folderNames: ['venv', 'venvs', '.venv', '.venvs', 'virtualenv', 'virtualenvs', '.virtualenv', '.virtualenvs'],
  },
  'vercel': {
    folderNames: [
      'vercel',
      '.vercel',
      'now',
      '.now',
    ],
  },
  'video': {
    folderNames: [
      'vid',
      'vids',
      'video',
      'videos',
      'movie',
      'movies',
    ],
  },
  'views': {
    folderNames: [
      'view',
      'views',
      'screen',
      'screens',
      'page',
      'pages',
      'public_html',
      'webview',
      'html',
    ],
  },
  'vscode': {
    folderNames: [
      '.vscode',
      '.vscode-test',
    ],
  },
  'windows': {
    folderNames: ['windows'],
  },
  'workflows': {
    folderNames: [
      'workflow',
      'workflows',
      'ci',
      '.ci',
    ],
  },
  'wxt': {
    folderNames: ['.wxt'],
  },
  'xcode': {
    folderNames: [
      'xcodeproj',
      'xcworkspace',
      'xcshareddata',
      'xcschemes',
    ],
  },
  'xmake': {
    folderNames: ['xmake', '.xmake'],
  },
  'yahoo': {
    folderNames: ['yahoo', 'yahoo_app', 'yahoo_japan', 'yahoo_news', 'yahoo_weather', 'yahoo_cookie_updater'],
  },
  'yarn': {
    folderNames: ['.yarn'],
  },
  'youtube': {
    folderNames: ['youtube', 'youtubeapp_ad', 'youtube_swiper'],
  },
}

const { folderNames } = Object.entries(folderIcons).reduce(
  ({ folderNames }, [name, icon]) => ({
    folderNames: {
      ...folderNames,
      ...icon.folderNames?.reduce((a, c) => ({ ...a, [c]: `folder_${name}` }), {}),
    },
  }),
  {
    folderNames: {},
  },
)

export { folderIcons, folderNames }
