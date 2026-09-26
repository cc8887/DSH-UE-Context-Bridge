#!/bin/sh
# Negative control.
#
# Runs the real test first so a failure here means the environment broke, then
# removes the host-owned dependency links and re-checks the load. A test that
# cannot fail proves nothing; this asserts that step 5 actually depends on the
# links install.mjs creates.
#
# If the second load still succeeds, step 5 is not testing what it claims and
# the whole suite is decoration.
set -e

PROFILE=ue-bridge
NM="$DSH_HOME/profiles/$PROFILE/node_modules"
IDX="$NM/@ue-bridge/dsh-plugin/dist/index.js"

load() {
  node -e "
const u = require('url').pathToFileURL(process.argv[1]).href;
import(u).then(()=>{console.log('  loaded')}).catch(e=>{console.log('  FAILED: '+e.code)});
" "$IDX"
}

echo "=== baseline (links present) ==="
/work/run-test.sh > /tmp/base.log 2>&1 && echo "  OK baseline passed" || { echo "  baseline broke:"; tail -20 /tmp/base.log; exit 1; }

echo
echo "=== remove host-owned links, then re-load ==="
rm -rf "$NM/@deepseek-ai/dsh-tools" "$NM/@deepseek-ai/cordis"
load

echo
echo "=== remove vendored get-port, then re-load ==="
rm -rf "$NM/get-port"
load

echo
echo "=== done (failures above are the expected outcome) ==="
