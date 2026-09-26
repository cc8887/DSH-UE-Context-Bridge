# One-shot container test for the release bundle.
#
# Runs the zero-base install inside a container so the host's node_modules
# cannot silently satisfy a dependency that is actually missing from the
# tarball. Then runs the negative control, which deletes the links install.mjs
# creates and asserts the load breaks -- without that, the first run passing
# proves nothing.
#
# Prerequisites: podman machine running, dist-release/ue-bridge-bundle-<v>.tgz built.
# Usage: pwsh tests/container/run.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)

$version = (Get-Content (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$tarball = Join-Path $repo "dist-release/ue-bridge-bundle-$version.tgz"

if (-not (Test-Path $tarball)) {
    Write-Error "no tarball at $tarball; run: node scripts/pack-release.mjs"
}

# Copied rather than mounted: the image must be self-contained, and a mount
# would let the container read from the repo and mask a missing file.
Copy-Item $tarball (Join-Path $here 'ue-bridge-bundle-0.1.0.tgz') -Force

Write-Host '=== building test image ===' -ForegroundColor Cyan
podman build -t ue-bridge-install-test $here
if ($LASTEXITCODE -ne 0) { Write-Error 'image build failed' }

Write-Host '=== zero-base install test ===' -ForegroundColor Cyan
podman run --rm ue-bridge-install-test
$mainOk = $LASTEXITCODE -eq 0

Write-Host '=== negative control (must report failures) ===' -ForegroundColor Cyan
podman build -t ue-bridge-negative -f (Join-Path $here 'Dockerfile.negative') $here | Out-Null
podman run --rm ue-bridge-negative
$negOk = $LASTEXITCODE -eq 0

Write-Host ''
if ($mainOk -and $negOk) {
    Write-Host 'RESULT: install verified, and the test is proven able to fail' -ForegroundColor Green
} else {
    Write-Host "RESULT: FAILED (install=$mainOk, negative=$negOk)" -ForegroundColor Red
    exit 1
}
