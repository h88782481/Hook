[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$tag = $Tag.Trim()
if ($tag -notmatch '^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$') {
    throw "Invalid release tag/version: $Tag (expected vX.Y.Z or X.Y.Z)"
}

$version = $Matches[1]
$hookRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-TextNoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Set-JsonTopLevelVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing JSON file: $Path"
    }

    # Prefer Node so we keep valid UTF-8 JSON without PowerShell ConvertTo-Json / BOM issues.
    # argv: [0]=node [1]=script [2]=jsonPath [3]=version
    $nodeScript = @'
const fs = require("fs");
const targetPath = process.argv[2];
const version = process.argv[3];
const raw = fs.readFileSync(targetPath, "utf8");
const json = JSON.parse(raw);
if (typeof json.version !== "string") {
  throw new Error(`No top-level string version in ${targetPath}`);
}
json.version = version;
fs.writeFileSync(targetPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
'@
    $tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("hook-sync-version-" + [System.Guid]::NewGuid().ToString("N") + ".js")
    try {
        Write-TextNoBom -Path $tempScript -Content $nodeScript
        & node $tempScript $Path $Version
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to sync version in $Path"
        }
    } finally {
        if (Test-Path -LiteralPath $tempScript) {
            Remove-Item -LiteralPath $tempScript -Force
        }
    }

    $verify = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
    if ([string]::IsNullOrWhiteSpace($verify)) {
        throw "Version sync left empty file: $Path"
    }
    $null = $verify | ConvertFrom-Json
}

function Set-CargoPackageVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    $content = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
    $updated = [regex]::Replace(
        $content,
        '(?m)^version\s*=\s*"[^"]+"',
        "version = `"$Version`"",
        1
    )
    if ($updated -eq $content) {
        throw "Failed to update Cargo.toml version in $Path"
    }
    Write-TextNoBom -Path $Path -Content $updated
}

$packageJson = Join-Path $hookRoot "package.json"
$tauriConf = Join-Path $hookRoot "src-tauri\tauri.conf.json"
$cargoToml = Join-Path $hookRoot "src-tauri\Cargo.toml"

Set-JsonTopLevelVersion -Path $packageJson -Version $version
Set-JsonTopLevelVersion -Path $tauriConf -Version $version
Set-CargoPackageVersion -Path $cargoToml -Version $version

Write-Host "[hook-ci-version] Synced release version to $version (from tag $tag)"
Write-Host "[hook-ci-version] package.json exists=$(Test-Path -LiteralPath $packageJson)"
