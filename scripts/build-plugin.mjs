/**
 * build-plugin.mjs — compile the plugin to plain JS for dsh.
 *
 * dsh loads plugins from node_modules, where Node refuses to strip TypeScript
 * types. We compile with tsc, then rewrite `@ue-bridge/contracts/...` specifiers
 * to relative paths so the output runs without a workspace install.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.cwd();

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

rmSync(join(root, 'packages/contracts/dist'), { recursive: true, force: true });
rmSync(join(root, 'packages/dsh-plugin/dist'), { recursive: true, force: true });
rmSync(join(root, 'packages/gateway/dist'), { recursive: true, force: true });

const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function tsc(project) {
  execFileSync(npm, ['tsc', '-p', project], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

tsc('packages/contracts/tsconfig.build.json');
tsc('packages/dsh-plugin/tsconfig.build.json');
tsc('packages/gateway/tsconfig.build.json');

// Both packages are compiled now. The contracts package.json is authored with
// dist exports already, so it is left alone here.
const contractsDir = join(root, 'packages/contracts');

for (const file of walk(join(root, 'packages'))) {
  let code = readFileSync(file, 'utf8');
  const before = code;
  // `@ue-bridge/contracts/<name>` (any suffix) -> relative path into dist.
  code = code.replace(/@ue-bridge\/contracts\/([A-Za-z0-9_.-]+)/g, (_m, name) => {
    const base = name.replace(/\.ts$|\.js$/, '');
    const rel = relative(dirname(file), join(contractsDir, 'dist', `${base}.js`)).replace(/\\/g, '/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  });
  code = code.replace(/\.ts'/g, ".js'").replace(/\.ts"/g, '.js"');
  if (code !== before) writeFileSync(file, code, 'utf8');
}

console.log('build-plugin: ok');
