// Runs the Tauri CLI with path remapping so the built exe doesn't contain the
// builder's local folder names (e.g. C:\Users\<name>\.cargo\...), which Rust
// otherwise embeds for panic messages.
// Usage: node scripts/tauri.mjs <tauri args>   (npm run build / npm run tauri -- ...)
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEP = '\x1f'; // CARGO_ENCODED_RUSTFLAGS separator (handles spaces in paths)
const home = os.homedir();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');
const rustupHome = process.env.RUSTUP_HOME || path.join(home, '.rustup');

// Later entries win when several prefixes match, so the most specific go last.
const remaps = [
  [home, '~'],
  [rustupHome, '/rustup'],
  [cargoHome, '/cargo'],
  [root, '/ttco-plus'],
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

const existing = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split(SEP)
  : (process.env.RUSTFLAGS || '').split(' ').filter(Boolean);
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...existing, ...remaps].join(SEP) };
delete env.RUSTFLAGS;

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const res = spawnSync(`"${bin}"`, process.argv.slice(2), { stdio: 'inherit', env, shell: true, cwd: root });
process.exit(res.status ?? 1);
