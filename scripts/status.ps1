$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$script = Join-Path $PSScriptRoot "service.mjs"
& node $script status
if ($LASTEXITCODE -ne 0) {
  throw "service.mjs failed with exit code $LASTEXITCODE"
}
