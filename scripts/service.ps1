param(
  [ValidateSet("start", "restart", "stop", "status", "logs", "list")]
  [string]$Action = "status",

  [ValidateSet("dev", "prod")]
  [string]$Mode = "prod",

  [int]$HealthPort = 3210,

  [int]$HealthTimeoutSeconds = 30,

  [int]$LogLines = 120
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$script = Join-Path $PSScriptRoot "service.mjs"
& node $script $Action --mode $Mode --health-port $HealthPort --health-timeout-seconds $HealthTimeoutSeconds --log-lines $LogLines
if ($LASTEXITCODE -ne 0) {
  throw "service.mjs failed with exit code $LASTEXITCODE"
}
