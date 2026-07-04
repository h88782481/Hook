[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [Parameter(Mandatory = $true)]
    [string]$Tag,

    [switch]$Force,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedExePath = [System.IO.Path]::GetFullPath($ExePath)
$resolvedOutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$assetName = "hook-windows-x64-$Tag.zip"
$zipPath = Join-Path $resolvedOutputDir $assetName

if ($DryRun) {
    [ordered]@{
        exePath = $resolvedExePath
        outputDir = $resolvedOutputDir
        assetName = $assetName
        zipPath = $zipPath
    } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not (Test-Path -LiteralPath $resolvedExePath -PathType Leaf)) {
    throw "Missing Hook executable for release packaging: $resolvedExePath"
}

if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
    New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
}

if ((Test-Path -LiteralPath $zipPath -PathType Leaf) -and -not $Force) {
    throw "Release zip already exists. Re-run with -Force to replace it: $zipPath"
}

if (Test-Path -LiteralPath $zipPath -PathType Leaf) {
    Remove-Item -LiteralPath $zipPath -Force
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("hook-release-" + [System.Guid]::NewGuid().ToString("N"))
$stagingFile = Join-Path $stagingRoot "hook.exe"

try {
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    Copy-Item -LiteralPath $resolvedExePath -Destination $stagingFile -Force
    Compress-Archive -LiteralPath $stagingFile -DestinationPath $zipPath -CompressionLevel Optimal
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

Write-Host "[hook-release-package] Created:"
Write-Host "  $zipPath"
