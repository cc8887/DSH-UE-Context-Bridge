// Crash-context parsing, as a unit test.
//
// readCrashContext looks trivial until you meet the real file: the engine
// writes CrashContext.runtime-xml as UTF-16LE with a BOM, and repeats some
// tags. Both were found against actual crash output from a provoked crash,
// where a UTF-8 read silently produced undefined for every field.
//
// These tests pin that behaviour with fixtures written the way the engine
// writes them, so a regression fails here instead of in a crash report.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCrashContext } from '../../packages/dsh-plugin/src/editor-lifecycle.ts';

const temps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Write a crash context exactly as the engine does: UTF-16LE + BOM. */
function writeUtf16(dir, xml) {
  const body = Buffer.from(xml, 'utf16le');
  writeFileSync(join(dir, 'CrashContext.runtime-xml'), Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
}

test('reads the engine verdict from a UTF-16LE crash context', () => {
  const dir = tempDir('ue-ctx-utf16-');
  writeUtf16(
    dir,
    `<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext>
<RuntimeProperties>
<CrashVersion>3</CrashVersion>
<CrashGUID>UECC-Windows-52BB633E4427072622713599B4550CF5_0000</CrashGUID>
<CrashType>Assert</CrashType>
<ErrorMessage>Abort signal received</ErrorMessage>
</RuntimeProperties>
</FGenericCrashContext>`,
  );

  const meta = readCrashContext(dir);
  assert.equal(meta.crashType, 'Assert');
  assert.equal(meta.errorMessage, 'Abort signal received');
  assert.equal(meta.crashGuid, 'UECC-Windows-52BB633E4427072622713599B4550CF5_0000');
});

test('a UTF-8 read would produce mojibake, so the BOM must be honoured', () => {
  // Guard against "simplify" to a plain utf8 read: without BOM handling the
  // decoded text is mostly replacement characters and every field is lost.
  const dir = tempDir('ue-ctx-bom-');
  writeUtf16(dir, '<CrashType>Assert</CrashType><ErrorMessage>Abort signal received</ErrorMessage>');
  const meta = readCrashContext(dir);
  assert.equal(meta.crashType, 'Assert', 'BOM detection must select utf-16le');
  assert.ok(!meta.crashType?.includes('\uFFFD'), 'no replacement characters expected');
});

test('repeated tags do not swallow later fields', () => {
  // CrashReporterMessage occurs twice in real output. A greedy regex would
  // match from the first opening tag to the last closing one, dragging
  // unrelated content into the value.
  const dir = tempDir('ue-ctx-dup-');
  writeUtf16(
    dir,
    `<RuntimeProperties>
<CrashReporterMessage></CrashReporterMessage>
<CrashType>GPUCrash</CrashType>
<CrashReporterMessage>Unattended</CrashReporterMessage>
<ErrorMessage>GPU fault</ErrorMessage>
</RuntimeProperties>`,
  );
  const meta = readCrashContext(dir);
  assert.equal(meta.crashType, 'GPUCrash');
  assert.equal(meta.errorMessage, 'GPU fault');
});

test('accepts a UTF-8 context without a BOM', () => {
  // Not all writers use UTF-16; the reader must not assume a BOM is present.
  const dir = tempDir('ue-ctx-utf8-');
  writeFileSync(
    join(dir, 'CrashContext.runtime-xml'),
    '<CrashType>Crash</CrashType><ErrorMessage>Access violation</ErrorMessage>',
    'utf8',
  );
  const meta = readCrashContext(dir);
  assert.equal(meta.crashType, 'Crash');
  assert.equal(meta.errorMessage, 'Access violation');
});

test('a missing or empty context yields no fields rather than throwing', () => {
  // A crash may be reported before the XML is written, or the directory may
  // only hold a minidump. That must degrade, not crash the reporter.
  const empty = tempDir('ue-ctx-none-');
  const none = readCrashContext(empty);
  assert.equal(none.crashType, undefined, 'no file at all');
  assert.equal(none.errorMessage, undefined, 'no file at all');

  const dir = tempDir('ue-ctx-empty-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CrashContext.runtime-xml'), '', 'utf8');
  const blank = readCrashContext(dir);
  assert.equal(blank.crashType, undefined, 'empty file');
  assert.equal(blank.errorMessage, undefined, 'empty file');
});
