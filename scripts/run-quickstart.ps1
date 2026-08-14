param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
$agentRoot = Join-Path $ProjectRoot "agent"
$hadPriorApiKey = Test-Path Env:T3N_API_KEY
$priorApiKey = $env:T3N_API_KEY
$key = Read-Host "Paste your T3N API key (input is hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $env:T3N_API_KEY = $plainKey
  Push-Location $agentRoot
  try {
    pnpm exec tsx quickstart.ts
  } finally {
    Pop-Location
  }
} finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  Remove-Variable plainKey -ErrorAction SilentlyContinue
  if ($hadPriorApiKey) {
    $env:T3N_API_KEY = $priorApiKey
  } else {
    Remove-Item Env:T3N_API_KEY -ErrorAction SilentlyContinue
  }
  Remove-Variable priorApiKey -ErrorAction SilentlyContinue
}
