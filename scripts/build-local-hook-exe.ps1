[CmdletBinding()]
param(
    [string]$OutputDir = "release\Hook\portable",
    [switch]$Force,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hookRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $hookRoot $OutputDir))
$releaseExe = Join-Path $hookRoot "src-tauri\target\release\hook.exe"

function Ensure-OutputDirectory {
    param(
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path
        if (-not $item.PSIsContainer) {
            throw "Output path exists but is not a directory: $Path"
        }
        return
    }

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

if ($DryRun) {
    [ordered]@{
        hookRoot = $hookRoot
        outputDir = $outputRoot
        releaseExe = $releaseExe
        buildCommand = "npm run tauri build -- --no-bundle"
    } | ConvertTo-Json -Depth 5
    exit 0
}

Ensure-OutputDirectory -Path $outputRoot

Push-Location -LiteralPath $hookRoot
try {
    & cmd.exe /d /c "npm run tauri build -- --no-bundle"
    if ($LASTEXITCODE -ne 0) {
        throw "Hook Tauri build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
    throw "Expected built executable is missing: $releaseExe"
}

if ($Force -and (Test-Path -LiteralPath (Join-Path $outputRoot "hook.exe") -PathType Leaf)) {
    Remove-Item -LiteralPath (Join-Path $outputRoot "hook.exe") -Force
}

Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $outputRoot "hook.exe") -Force
Write-Host "[hook-ci-build] Built exe:"
Write-Host "  $(Join-Path $outputRoot "hook.exe")"
