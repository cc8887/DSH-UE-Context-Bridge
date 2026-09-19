/**
 * Verify the registry actually avoids UDP collisions.
 *
 * The editor binds UDP, but get-port only probes TCP, so this checks that the
 * UDP confirmation layer works: an occupied UDP port must never be handed out.
 */

import dgram from 'node:dgram';
import { EditorRegistry, isUdpPortFree } from '../packages/dsh-plugin/src/editor-registry.ts';

const HOLD = 6785;
const sock = dgram.createSocket({ type: 'udp4' });
await new Promise<void>((r) => sock.bind(HOLD, '127.0.0.1', () => r()));
console.log(`occupied UDP ${HOLD}`);

console.log(`isUdpPortFree(${HOLD}) -> ${await isUdpPortFree(HOLD, '127.0.0.1')} (expect false)`);
console.log(`isUdpPortFree(6790) -> ${await isUdpPortFree(6790, '127.0.0.1')} (expect true)`);

const registry = new EditorRegistry({ portRangeStart: 6780, portRangeEnd: 6790 });

// Occupy the port this project would otherwise prefer.
const projects = ['<PROJ_A>', '<PROJ_B>', '<PROJ_C>'];
console.log('--- allocation while a UDP port is held ---');
const ports = new Set<number>();
for (const p of projects) {
  const inst = await registry.register(p);
  ports.add(inst.endpoint.port);
  console.log(`  ${inst.projectName} -> ${inst.endpoint.port} [${inst.provisioned}]`);
}

console.log(`distinct: ${ports.size}/${projects.length}`);
if (ports.size !== projects.length) {
  console.log('FAIL: collision');
  process.exit(1);
}
if (ports.has(HOLD)) {
  console.log(`FAIL: handed out the occupied port ${HOLD}`);
  process.exit(1);
}

console.log('--- stability ---');
const again = await registry.register(projects[0]);
const first = registry.get(projects[0]);
console.log(`  stable across lookups: ${again.endpoint.port === first?.endpoint.port}`);
if (again.endpoint.port !== first?.endpoint.port) {
  console.log('FAIL: not stable');
  process.exit(1);
}

sock.close();
console.log('DONE');
