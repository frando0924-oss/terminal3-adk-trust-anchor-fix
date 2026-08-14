param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
$agentRoot = Join-Path $ProjectRoot "agent"
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
  Remove-Item Env:T3N_API_KEY -ErrorAction SilentlyContinue
}
