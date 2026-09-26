#!/bin/sh
# Zero-base install verification inside the container.
#
# Each step is checked and the script exits non-zero on the first failure, so a
# broken release cannot pass by printing a warning.
set -e

BUNDLE=/work/bundle.tgz
PROFILE=ue-bridge
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
NM="$PROFILE_DIR/node_modules"

echo "=== env ==="
node --version
echo "dsh: $(command -v dsh)"
echo "DSH_HOME: $DSH_HOME"

echo
echo "=== step 1: dsh plugin add (from local tarball) ==="
dsh plugin --profile "$PROFILE" add "$BUNDLE"

echo
echo "=== step 2: install.mjs ==="
node "$NM/@ue-bridge/bundle/install.mjs" --profile "$PROFILE"

echo
echo "=== step 3: packages present ==="
for p in @ue-bridge/dsh-plugin @ue-bridge/contracts @ue-bridge/gateway get-port; do
  if [ -d "$NM/$p" ]; then
    echo "  OK   $p"
  else
    echo "  FAIL $p missing"
    exit 1
  fi
done

echo
echo "=== step 4: host-owned deps resolved ==="
for p in @deepseek-ai/dsh-tools @deepseek-ai/cordis; do
  if [ -e "$NM/$p" ]; then
    echo "  OK   $p -> $(readlink -f "$NM/$p")"
  else
    echo "  FAIL $p missing"
    exit 1
  fi
done

echo
echo "=== step 5: load plugin (the step that used to fail) ==="
node -e "
const u = require('url').pathToFileURL(process.argv[1]).href;
import(u)
  .then((m) => {
    if (typeof m.apply !== 'function') throw new Error('no apply export');
    console.log('  OK   loaded, exports: ' + Object.keys(m).join(', '));
  })
  .catch((e) => {
    console.error('  FAIL load error: ' + e.code + ' | ' + String(e.message).split('\n')[0]);
    process.exit(1);
  });
" "$NM/@ue-bridge/dsh-plugin/dist/index.js"

echo
echo "=== step 6: gateway starts ==="
# The gateway blocks on stdin, so give it a moment and then close it. A clean
# 'ready' line means the compiled gateway and its vendored SDK both resolve.
timeout 10 node "$NM/@ue-bridge/gateway/dist/main.js" > /tmp/gw.log 2>&1 || true
cat /tmp/gw.log
if grep -q "ready" /tmp/gw.log; then
  echo "  OK   gateway ready"
else
  echo "  FAIL gateway did not report ready"
  exit 1
fi

echo
echo "=== ALL CHECKS PASSED ==="
