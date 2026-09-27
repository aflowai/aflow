/**
 * Phoenix Icon Name Map
 *
 * Maps stable Phoenix icon names to Phosphor icon component names.
 * App code uses Phoenix names only; the adapter resolves to Phosphor.
 *
 * Custom hand-built icons live in `./custom/` and are merged into the
 * `IconName` union below; the `Icon` component resolves those before
 * falling back to the Phosphor lookup.
 */

import { type CustomIconName } from './custom/index.js';

export const ICON_MAP = {
  // Navigation & UI
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown',
  'arrow-square-out': 'ArrowSquareOut',
  'arrow-square-in': 'ArrowSquareIn',
  'caret-left': 'CaretLeft',
  'caret-right': 'CaretRight',
  'caret-up': 'CaretUp',
  'caret-down': 'CaretDown',
  x: 'X',
  check: 'Check',
  'check-circle': 'CheckCircle',
  bell: 'Bell',
  'tray-arrow-down': 'TrayArrowDown',
  plus: 'Plus',
  minus: 'Minus',
  'dots-three': 'DotsThree',
  'dots-three-vertical': 'DotsThreeVertical',
  list: 'List',
  'list-magnifying-glass': 'ListMagnifyingGlass',
  'magnifying-glass': 'MagnifyingGlass',
  funnel: 'Funnel',
  gear: 'Gear',
  sliders: 'Sliders',

  // Actions
  copy: 'CopySimple',
  trash: 'Trash',
  pencil: 'PencilSimple',
  download: 'DownloadSimple',
  upload: 'UploadSimple',
  share: 'ShareNetwork',
  link: 'LinkSimple',
  'sign-out': 'SignOut',
  'sign-in': 'SignIn',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop', // name-based Icon defaults weight to fill
  refresh: 'ArrowClockwise',
  undo: 'ArrowCounterClockwise',
  sync: 'ArrowsClockwise',
  expand: 'ArrowsOut',

  // Objects & concepts
  chat: 'ChatCircle',
  'chat-dots': 'ChatDots',
  brain: 'Brain',
  robot: 'Robot',
  lightning: 'Lightning',
  cube: 'Cube',
  database: 'Database',
  'hard-drives': 'HardDrives',
  globe: 'Globe',
  lock: 'LockSimple',
  'lock-key': 'LockKey',
  key: 'Key',
  'shield-check': 'ShieldCheck',
  'plugs-connected': 'PlugsConnected',
  flask: 'Flask',
  user: 'User',
  'user-circle': 'UserCircle',
  users: 'Users',
  book: 'Book',
  file: 'File',
  'file-text': 'FileText',
  'file-code': 'FileCode',
  'file-js': 'FileJs',
  'film-strip': 'FilmStrip',
  folder: 'Folder',
  'folder-simple': 'FolderSimple',
  'folder-simple-plus': 'FolderSimplePlus',
  image: 'Image',
  video: 'VideoCamera',
  text: 'TextAa',
  'text-t': 'TextT',
  code: 'Code',
  terminal: 'Terminal',
  home: 'House',
  wrench: 'Wrench',
  'gear-six': 'GearSix',
  plugs: 'Plugs',
  'git-branch': 'GitBranch',
  flag: 'Flag',
  clock: 'Clock',
  calendar: 'Calendar',
  'currency-dollar': 'CurrencyDollar',

  // Status & feedback
  ghost: 'Ghost',
  info: 'Info',
  warning: 'Warning',
  'warning-circle': 'WarningCircle',
  'circle-notch': 'CircleNotch',
  spinner: 'SpinnerGap',
  eye: 'Eye',
  'eye-slash': 'EyeSlash',

  // Layout & display
  sun: 'Sun',
  moon: 'Moon',
  sidebar: 'SidebarSimple',
  'squares-four': 'SquaresFour',
  rows: 'Rows',
  columns: 'Columns',

  // Communication & voice
  mail: 'Envelope',
  microphone: 'Microphone',
  'microphone-slash': 'MicrophoneSlash',
  'microphone-stage': 'MicrophoneStage',
  'speaker-high': 'SpeakerHigh',
  waveform: 'Waveform',

  // Aflow-specific
  flow: 'TreeStructure',
  step: 'ArrowBendDownRight',
  run: 'PlayCircle',
  api: 'Webhook',
  memory: 'BrainCircuit',

  // Cybernetic concept set (Skill is a custom icon — see ./custom/SkillIcon)
  store: 'Storefront', // Store (the place you browse and install from)
  books: 'Books', // Memory
  lightbulb: 'Lightbulb', // Proposal
  buildings: 'Buildings', // Workspace / space
  stethoscope: 'Stethoscope', // Coach (learner)
  scales: 'Scales', // Eval / judge
} as const;

export type IconName = keyof typeof ICON_MAP | CustomIconName;
