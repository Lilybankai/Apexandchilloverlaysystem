# scripts/voice-recorder.ps1 — bounded WAV capture for the whisper spike.
# -----------------------------------------------------------------------------
# Records the default input device for N seconds (the same listen window the
# app uses) to a 16 kHz 16-bit mono WAV, then prints the path. MCI waveaudio
# is built into Windows — no extra SDK, matching the other voice sidecars.
#
#   powershell -File scripts/voice-recorder.ps1 -OutPath C:\tmp\ask.wav -Seconds 6
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Seconds = 6
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Mci {
  [DllImport("winmm.dll", CharSet = CharSet.Auto)]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr hwndCallback);
}
'@

function Mci-Send([string]$cmd) {
  $buf = New-Object System.Text.StringBuilder 256
  $code = [Mci]::mciSendString($cmd, $buf, $buf.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) { throw "MCI failed ($code): $cmd" }
}

$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
}
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

# 16 kHz / 16-bit / mono — whisper.cpp's native PCM shape, so the spike does
# not have to resample a live capture.
Mci-Send 'open new type waveaudio alias rec'
try {
  Mci-Send 'set rec bitspersample 16 channels 1 samplespersec 16000 alignment 2 bytespersec 32000'
  Mci-Send 'record rec'
  Start-Sleep -Seconds $Seconds
  Mci-Send 'stop rec'
  Mci-Send ("save rec `"$OutPath`"")
} finally {
  try { Mci-Send 'close rec' } catch { }
}

if (-not (Test-Path -LiteralPath $OutPath)) { throw "recorder wrote nothing to $OutPath" }
[Console]::Out.WriteLine($OutPath)
[Console]::Out.Flush()
