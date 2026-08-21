# =============================================================================
# Apex AIO System - shared-memory diagnostic
# -----------------------------------------------------------------------------
# For the machine where Track Limits says NO DATA, the radar and throttle trace
# are blank, and the track map never draws - while Race Control and Standings
# still work. That split means the REST feed is fine and the shared-memory
# buffers are not, and this script finds out why in one run.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less
# scripts in the system ANSI codepage, and one smart dash breaks the parser.
#
# HOW TO RUN (takes under a minute):
#   1. Start Le Mans Ultimate and get IN THE CAR - on track, not in the menus.
#   2. Open a NORMAL PowerShell window (press Start, type "powershell", Enter -
#      do NOT right-click / "Run as administrator").
#   3. Paste this whole file in, press Enter, screenshot the output.
# =============================================================================

$src = @"
using System;
using System.Runtime.InteropServices;
public static class ApexMmf {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr OpenFileMappingW(uint dwDesiredAccess, bool bInheritHandle, string lpName);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@
Add-Type -TypeDefinition $src

Write-Host ""
Write-Host "Apex AIO shared-memory diagnostic" -ForegroundColor Cyan
Write-Host "-------------------------------------"

# --- 1) Is the game running, and does it look elevated? ----------------------
# Reading .Path of another process fails from a non-admin window when that
# process runs elevated - which is exactly the mismatch that breaks the overlay.
$game = Get-Process -Name 'Le Mans Ultimate' -ErrorAction SilentlyContinue
$gameDir = $null
if (-not $game) {
  Write-Host "GAME    : not running. Start LMU, get in the car, run this again." -ForegroundColor Yellow
} else {
  foreach ($p in $game) {
    $path = $null
    try { $path = $p.Path } catch {}
    if ($path) {
      $gameDir = Split-Path $path
      Write-Host ("GAME    : {0} (PID {1}) - running, elevation looks normal" -f $p.ProcessName, $p.Id) -ForegroundColor Green
    } else {
      Write-Host ("GAME    : {0} (PID {1}) - CANNOT READ ITS PATH: the game is probably running AS ADMINISTRATOR" -f $p.ProcessName, $p.Id) -ForegroundColor Red
      Write-Host "          Fix: right-click the game exe > Properties > Compatibility > untick 'Run this program as an administrator'." -ForegroundColor Yellow
    }
  }
}

# --- 2) The two buffers the overlay reads ------------------------------------
foreach ($name in '$rFactor2SMMP_Telemetry$', '$rFactor2SMMP_Scoring$') {
  $h = [ApexMmf]::OpenFileMappingW(4, $false, $name)   # 4 = FILE_MAP_READ
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($h -ne [IntPtr]::Zero) {
    Write-Host "BUFFER  : $name - FOUND and readable" -ForegroundColor Green
    [void][ApexMmf]::CloseHandle($h)
  } elseif ($err -eq 5) {
    Write-Host "BUFFER  : $name - EXISTS BUT ACCESS DENIED (elevation mismatch between game and this window)" -ForegroundColor Red
  } else {
    Write-Host "BUFFER  : $name - NOT FOUND (Win32 error $err): the shared-memory plugin is missing or disabled" -ForegroundColor Red
  }
}

# --- 3) The REST feed, for completeness --------------------------------------
try {
  $null = Invoke-RestMethod 'http://localhost:6397/rest/watch/sessionInfo' -TimeoutSec 3
  Write-Host "REST    : port 6397 answering (this is why Race Control still worked)" -ForegroundColor Green
} catch {
  Write-Host "REST    : port 6397 not answering - is the game actually running?" -ForegroundColor Yellow
}

# --- 4) Is the plugin installed and enabled? ---------------------------------
$guesses = @()
if ($gameDir) { $guesses += $gameDir }
$guesses += @(
  'C:\Program Files (x86)\Steam\steamapps\common\Le Mans Ultimate',
  'D:\SteamLibrary\steamapps\common\Le Mans Ultimate',
  'E:\SteamLibrary\steamapps\common\Le Mans Ultimate',
  'D:\Steam\steamapps\common\Le Mans Ultimate'
)
$dllFound = $false
foreach ($dir in $guesses) {
  $dll = Join-Path $dir 'Plugins\rFactor2SharedMemoryMapPlugin64.dll'
  if (Test-Path $dll) {
    $dllFound = $true
    Write-Host "PLUGIN  : DLL present at $dll" -ForegroundColor Green
    $json = Join-Path $dir 'UserData\player\CustomPluginVariables.JSON'
    if (Test-Path $json) {
      $raw = Get-Content $json -Raw
      # The game writes the key with a leading space: " Enabled":1
      if ($raw -match '"rFactor2SharedMemoryMapPlugin64\.dll"[^}]*"\s?Enabled"\s*:\s*1') {
        Write-Host "PLUGIN  : enabled in CustomPluginVariables.JSON" -ForegroundColor Green
      } else {
        Write-Host "PLUGIN  : DLL present but NOT ENABLED in UserData\player\CustomPluginVariables.JSON" -ForegroundColor Red
        Write-Host '          Fix: edit that file so the plugin entry reads  " Enabled":1  , then restart the game.' -ForegroundColor Yellow
      }
    } else {
      Write-Host "PLUGIN  : CustomPluginVariables.JSON not found next to it - start the game once and re-run" -ForegroundColor Yellow
    }
    break
  }
}
if (-not $dllFound) {
  Write-Host "PLUGIN  : rFactor2SharedMemoryMapPlugin64.dll NOT FOUND in the game Plugins folder" -ForegroundColor Red
  Write-Host "          Fix: close LMU, open Apex AIO System, and use the Telemetry plugin card" -ForegroundColor Yellow
  Write-Host "          on the General tab - it installs and enables the plugin for you." -ForegroundColor Yellow
}

# --- 5) Can the game actually LOAD the plugin? -------------------------------
# The plugin is linked against MSVCR120.dll - the Visual C++ 2013 x64 runtime,
# not the 2015+ one most machines already have. Without it LoadLibrary fails,
# LMU carries on perfectly, and NO buffer is ever created. Every check above
# passes and there is still no telemetry, which is why this section exists.
$rt = Join-Path $env:SystemRoot 'System32\MSVCR120.dll'
if (Test-Path $rt) {
  Write-Host "RUNTIME : MSVCR120.dll present - the plugin can load" -ForegroundColor Green
} else {
  Write-Host "RUNTIME : MSVCR120.dll MISSING - THIS IS THE PROBLEM" -ForegroundColor Red
  Write-Host "          The plugin needs the Visual C++ 2013 Redistributable (x64)." -ForegroundColor Yellow
  Write-Host "          Without it LMU silently skips the plugin and publishes nothing," -ForegroundColor Yellow
  Write-Host "          however correctly the plugin itself is installed." -ForegroundColor Yellow
  Write-Host "          Fix: install https://aka.ms/highdpimfc2013x64 then restart LMU." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done - screenshot everything above and send it back." -ForegroundColor Cyan
