param(
  [ValidateSet("dev", "prod")]
  [string]$Mode = "prod"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$script = Join-Path $PSScriptRoot "service.mjs"
& node $script restart --mode $Mode
if ($LASTEXITCODE -ne 0) {
  throw "service.mjs failed with exit code $LASTEXITCODE"
}
