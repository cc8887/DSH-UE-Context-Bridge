/**
 * apply.ts — local-plugin entry for dsh.
 *
 * dsh loads a local plugin through cordis-plugin-include, which imports the
 * module and calls its default export / `apply`. We re-export the real plugin
 * here so the loader gets a plain function.
 */

export { apply as default } from './index.ts';
export { apply } from './index.ts';
