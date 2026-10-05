$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeOutput = Join-Path $projectRoot 'release/native-build'
$projectFile = Join-Path $projectRoot 'native/WinUtils.AlwaysActiveHook/WinUtils.AlwaysActiveHook.csproj'
& dotnet publish $projectFile -c Release -r win-x64 -o $nativeOutput
if ($LASTEXITCODE -ne 0) { throw 'Native hook compilation failed.' }
$library = Join-Path $nativeOutput 'WinUtils.AlwaysActiveHook.dll'
if (-not (Test-Path -LiteralPath $library)) { throw 'Native hook output is missing.' }
Copy-Item -LiteralPath $library -Destination (Join-Path $projectRoot 'resources/native/WinUtils.AlwaysActiveHook.dll') -Force
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($library))).Replace('-', '') }
finally { $hasher.Dispose() }
Write-Host "Staged native hook: $hash"
