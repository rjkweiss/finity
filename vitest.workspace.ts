import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  { test: { name: 'engine', root: './packages/engine' } },
  { test: { name: 'agents', root: './packages/agents' } },
  { test: { name: 'recorder', root: './packages/recorder' } },
  { test: { name: 'server', root: './server' } },
  './packages/client/vite.config.ts',
]);
