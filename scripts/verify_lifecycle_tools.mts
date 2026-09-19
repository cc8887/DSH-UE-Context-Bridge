/**
 * End-to-end check of the three merged lifecycle tools.
 *
 * Uses a fake Context that captures registrations, then invokes each tool the
 * way the model would. Confirms:
 * - tools register under the expected names
 * - start decides build-vs-launch internally and returns the outcome
 * - failures come back as values, never thrown
 * - state is retained in the session between calls
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { registerEditorTools } from '../packages/dsh-plugin/src/tools.ts';
import { PROJECT_ROOT, ENGINE_ROOT, requireRealPath } from './paths.mts';

type Registered = { name: string; execute: (a: unknown, e: unknown) => Promise<unknown> };
const registered: Registered[] = [];
const ctx = {
  tools: {
    register(t: unknown) {
      const tool = t as { name?: string; execute?: (a: unknown, e: unknown) => Promise<unknown> };
      if (tool.name && tool.execute) {
        registered.push({ name: tool.name, execute: (a, e) => tool.execute!(a, e) });
      }
      return () => undefined;
    },
  },
};

const projectRoot = requireRealPath('UE_BRIDGE_REPO or UE_PROJECT_ROOT', PROJECT_ROOT);
const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);
const session = new EditorSession({
  projectRoot,
  projectName: 'DshUeBridgeProject',
  engineRoot,
});

registerEditorTools(ctx as never, session);
console.log('--- registered ---');
for (const r of registered) console.log(`  ${r.name}`);
const want = ['ue_editor_status', 'ue_editor_start', 'ue_editor_stop'];
for (const w of want) {
  if (!registered.some((r) => r.name === w)) {
    console.log(`FAIL: ${w} not registered`);
    process.exit(1);
  }
}

const exec = { signal: undefined };

console.log('--- status (before any start) ---');
const s0 = (await registered.find((r) => r.name === 'ue_editor_status')!.execute({}, exec)) as Record<string, unknown>;
console.log(`  phase=${s0.phase} usable=${s0.usable} endpoint=${s0.endpoint} provisioned=${s0.provisioned}`);
if (s0.phase !== 'stopped') {
  console.log('FAIL: expected stopped');
  process.exit(1);
}

console.log('--- start (dsh decides; build fails here) ---');
const start = registered.find((r) => r.name === 'ue_editor_start')!;
const r1 = (await start.execute({}, exec)) as Record<string, unknown>;
console.log(`  ok=${r1.ok} action=${r1.action} built=${r1.built}`);
const build = r1.build as
  | { ok: boolean; error_count: number; errors: Array<{ code: string; location: string; message: string }> }
  | undefined;
if (build) {
  console.log(`  build ok=${build.ok} errors=${build.error_count}`);
  for (const e of build.errors.slice(0, 3)) {
    console.log(`    ${e.code} @ ${e.location} :: ${e.message.slice(0, 70)}`);
  }
}
console.log(`  note=${String(r1.note).slice(0, 90)}`);
if (r1.action === 'build_failed' && !build?.errors.length) {
  console.log('FAIL: build failed but no errors surfaced');
  process.exit(1);
}

// New semantics: UBT is asked first. A failing build must never start the
// editor, so a broken project yields build_failed rather than a launch guess.
console.log('--- status (after start attempt) ---');
const s1 = (await registered.find((r) => r.name === 'ue_editor_status')!.execute({}, exec)) as Record<string, unknown>;
console.log(`  phase=${s1.phase} provisioned=${s1.provisioned} remote_ready=${s1.remote_ready}`);
const lb = s1.last_build as { up_to_date?: boolean; compiled?: boolean; error_count?: number } | undefined;
if (lb) console.log(`  last_build up_to_date=${lb.up_to_date} compiled=${lb.compiled} errors=${lb.error_count}`);

if (r1.action === 'build_failed') {
  if (s1.phase !== 'stopped') {
    console.log('FAIL: a failed build must not leave the editor starting');
    process.exit(1);
  }
  console.log('  (project has real build errors; no-launch-on-failure verified)');
} else {
  console.log(`  started: phase=${s1.phase} remote_ready=${s1.remote_ready}`);
  if (s1.provisioned === 'unprovisioned' && s1.remote_ready) {
    console.log('FAIL: unprovisioned editor not flagged as remote-unready');
    process.exit(1);
  }
}

console.log('--- stop (running) ---');
const stop = registered.find((r) => r.name === 'ue_editor_stop')!;
const r2 = (await stop.execute({}, exec)) as Record<string, unknown>;
console.log(`  ok=${r2.ok} was_running=${r2.was_running} phase=${r2.phase}`);
if (r2.phase !== 'stopped') {
  console.log(`FAIL: expected stopped after stop, got ${r2.phase}`);
  process.exit(1);
}

console.log('--- status (after stop) ---');
const s2 = (await registered.find((r) => r.name === 'ue_editor_status')!.execute({}, exec)) as Record<string, unknown>;
console.log(`  phase=${s2.phase} usable=${s2.usable}`);
if (s2.phase !== 'stopped' || s2.usable !== false) {
  console.log('FAIL: status not reset after stop');
  process.exit(1);
}

session.dispose();
console.log('DONE');
