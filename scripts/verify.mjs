import { spawnSync } from 'node:child_process';

const steps = [
  ['typecheck'],
  ['test'],
  ['build'],
  ['check:secrets'],
];

const hasPnpm =
  spawnSync('pnpm', ['--version'], { shell: process.platform === 'win32' }).status === 0;
const [command, prefix] = hasPnpm ? ['pnpm', []] : ['corepack', ['pnpm']];

for (const args of steps) {
  const result = spawnSync(command, [...prefix, ...args], {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
