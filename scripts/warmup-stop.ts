import {
  printStatuses,
  stopManaged,
  type ManagedName
} from './warmup-utils.js';

const names: ManagedName[] = [
  'whisper-local',
  'openclaw-worker',
  'openclaw-control',
  'openclaw-gateway',
  'codex-proxy',
  'claude-proxy'
];

printStatuses(names.map(stopManaged));
