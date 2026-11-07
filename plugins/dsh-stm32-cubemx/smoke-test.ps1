# Smoke test for dsh-stm32-cubemx
# Verifies: Node syntax, manifest JSON, CubeMX install, JVM args, and a read-only
# CubeMX CLI `config load` round trip against a sample .ioc.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-test.ps1 [-Ioc <path>]
param(
    [string]$Ioc = "E:\STM32CLION\PID_Car\PID_Car.ioc",
    [string]$PluginDir = $PSScriptRoot,
    [string]$MxHome = $(if ($env:CUBEMX_HOME) { $env:CUBEMX_HOME } else { "C:\Program Files\STMicroelectronics\STM32Cube\STM32CubeMX" })
)

$ErrorActionPreference = "Stop"
$failures = @()

function Check($name, $condition, $detail) {
    if ($condition) {
        Write-Host ("PASS  " + $name)
    } else {
        Write-Host ("FAIL  " + $name + "  " + $detail)
        $script:failures += $name
    }
}

Write-Host "== dsh-stm32-cubemx smoke test =="

# 1. plugin files
$index = Join-Path $PluginDir "index.js"
Check "index.js exists" (Test-Path $index) $index
Check "manifest exists" (Test-Path (Join-Path $PluginDir "package.json")) "package.json"
Check "patch exists" (Test-Path (Join-Path $PluginDir "cordis.patch.yml")) "cordis.patch.yml"

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node --check $index 2>$null
    Check "index.js syntax" ($LASTEXITCODE -eq 0) "node --check failed"
} else {
    Write-Host "SKIP  node not on PATH"
}

try {
    $manifest = Get-Content (Join-Path $PluginDir "package.json") -Raw | ConvertFrom-Json
    Check "manifest name" ($manifest.name -eq '@local/dsh-stm32-cubemx') "unexpected package name"
} catch {
    Check "manifest JSON" $false $_.Exception.Message
}

# 2. CubeMX install
$mxExe = Join-Path $MxHome "STM32CubeMX.exe"
$java = Join-Path $MxHome "jre\bin\java.exe"
Check "STM32CubeMX.exe" (Test-Path $mxExe) $mxExe
Check "bundled java" (Test-Path $java) $java

$jvmArgs = @()
$ini = Join-Path $MxHome "STM32CubeMX.l4j.ini"
if (Test-Path $ini) {
    foreach ($line in Get-Content $ini) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
        foreach ($token in ($trimmed -split '\s+')) { $jvmArgs += $token }
    }
}

# 3. read-only CLI round trip
Check "sample .ioc" (Test-Path $Ioc) $Ioc
if ((Test-Path $mxExe) -and (Test-Path $java) -and (Test-Path $Ioc)) {
    $work = Join-Path $env:TEMP ("cubemx-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $script = Join-Path $work "script.txt"
    $out = Join-Path $work "out.txt"
    # Quote the path: CubeMX splits script arguments on spaces.
    $lines = @("config load `"$Ioc`"", "get mcu name", "exit")
    [System.IO.File]::WriteAllText($script, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    $argList = $jvmArgs + @("-jar", $mxExe, "-q", $script)
    # Java writes warnings to stderr; keep Stop from turning that into a terminating error.
    $ErrorActionPreference = "Continue"
    $text = (& $java @argList 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    Check "CLI exit code" ($exitCode -eq 0) ("exit " + $exitCode)
    Check "CLI loaded project" ($text -match "STM32F103" -or $text -match "STM32") "no MCU name in output"
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. cross-version guard: a fake old .ioc must be rejected fast, without launching CubeMX
if (Get-Command node -ErrorAction SilentlyContinue) {
    $guardDir = Join-Path $env:TEMP ("cubemx-guard-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $guardDir | Out-Null
    $guardIoc = Join-Path $guardDir "old.ioc"
    $guardText = @(
        "#MicroXplorer Configuration settings - do not modify",
        "MxCube.Version=1.2.3",
        "ProjectManager.FirmwarePackage=STM32Cube FW_F9 V9.9.9"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($guardIoc, $guardText, (New-Object System.Text.UTF8Encoding($false)))

    $probe = Join-Path $guardDir "probe.mjs"
    $probeCode = @'
import { pathToFileURL } from "node:url"
const plugin = await import(pathToFileURL(process.env.SMOKE_PLUGIN).href)
const tools = new Map()
plugin.apply({ tools: { register: (t) => tools.set(t.name, t) }, inject() {} }, { mxHome: process.env.SMOKE_MX, allowAnyPath: true })
const started = Date.now()
try {
  await tools.get("stm32_cubemx_inspect").execute({ iocPath: process.env.SMOKE_IOC }, {})
  console.log("NO_ERROR", Date.now() - started)
} catch (error) {
  console.log("REJECTED", Date.now() - started, error.message.split("\n")[0])
}
'@
    [System.IO.File]::WriteAllText($probe, $probeCode, (New-Object System.Text.UTF8Encoding($false)))
    $env:SMOKE_PLUGIN = (Join-Path $PluginDir "index.js")
    $env:SMOKE_MX = $MxHome
    $env:SMOKE_IOC = $guardIoc
    $guardOut = (& node $probe 2>&1 | Out-String).Trim()
    $guardMs = if ($guardOut -match "REJECTED (\d+)") { [int]$Matches[1] } else { -1 }
    Check "version guard rejects old .ioc" ($guardOut -match "REJECTED") $guardOut
    Check "version guard is fast (no CubeMX launch)" ($guardMs -ge 0 -and $guardMs -lt 5000) ("took " + $guardMs + " ms")
    Remove-Item $guardDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "SKIP  version guard (node not on PATH)"
}

Write-Host ""
if ($failures.Count -eq 0) {
    Write-Host "RESULT: PASS"
    exit 0
}
Write-Host ("RESULT: FAIL (" + $failures.Count + ")")
exit 1
