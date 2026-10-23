# voice-mics.ps1 - the Engineer tab's microphone scan and mic test.
# -----------------------------------------------------------------------------
# One-shot, spawned by the app on demand (never at launch), so enumerating
# devices can never hold up the Electron main process: a USB device that stops
# answering once froze main for ~10 s inside DirectInput (2026-08-28). Here it
# can only make this child slow, and the app kills it on a timeout.
#
# APEX_MIC_MODE=list  (default) one JSON line:
#   {"devices":[{"id","name"}],"defaultName","speechDefault",
#    "privacy":{"device","user","desktop"}}
# - devices are SAPI's audio-input tokens, the only inputs the listener can
#   open; defaultName is the device behind "System default" right now;
#   privacy is Windows' three microphone switches, read from the consent store
#   ('Allow' / 'Deny' / null when Windows has never written one).
#
# APEX_MIC_MODE=test  listens for APEX_MIC_SECONDS (default 4) on APEX_MIC_ID
# ('' = System default), choosing the device exactly as the listener does
# (mic-input.ps1). Lines out:
#   MIC<tab>source<tab>name<tab>why   or   NOMIC<tab>reason (then exit)
#   LEVEL<tab>0-100                    SAPI's input level, ~10 a second
#   SPEECH                             SAPI detected speech
#   MICERR<tab>message                 the device would not open
#   DONE<tab>peak<tab>speech(0|1)
#
# Ships beside the other sidecars, signed, run with -File.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
. (Join-Path $PSScriptRoot 'mic-input.ps1')

function Out-Line([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

function Get-Consent([string]$path) {
  try {
    $v = (Get-ItemProperty -LiteralPath $path -Name Value -ErrorAction Stop).Value
    return [string]$v
  } catch {
    return $null
  }
}

$mode = [string]$env:APEX_MIC_MODE
if ($mode -eq '') { $mode = 'list' }

if ($mode -eq 'list') {
  try {
    $devices = Get-MicDevices
    $defName = Get-MicName $script:MicDefaultToken
    if ($null -eq $defName) { $defName = '' }
    $speechDefault = ''
    try {
      $speechDefault = [string](Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Speech\AudioInput' -Name DefaultTokenId -ErrorAction Stop).DefaultTokenId
    } catch {}
    $consent = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
    $out = [ordered]@{
      devices = [object[]]$devices
      defaultName = $defName
      speechDefault = $speechDefault
      privacy = [ordered]@{
        device = Get-Consent "HKLM:\$consent"
        user = Get-Consent "HKCU:\$consent"
        desktop = Get-Consent "HKCU:\$consent\NonPackaged"
      }
    }
    Out-Line ($out | ConvertTo-Json -Compress -Depth 4)
  } catch {
    Out-Line (@{ error = (Format-MicText $_.Exception.Message) } | ConvertTo-Json -Compress)
  }
  exit 0
}

# ---- test -------------------------------------------------------------------
$secs = 4
if ([string]$env:APEX_MIC_SECONDS -match '^\d+$') { $secs = [Math]::Max(1, [Math]::Min(10, [int]$env:APEX_MIC_SECONDS)) }
try {
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  # A grammar is required to run at all; nothing here acts on a match.
  $choices = New-Object System.Speech.Recognition.Choices
  $choices.Add('radio check')
  $rec.LoadGrammar((New-Object System.Speech.Recognition.Grammar((New-Object System.Speech.Recognition.GrammarBuilder($choices)))))
  $pick = Set-MicInput $rec ([string]$env:APEX_MIC_ID)
  Out-Line (Format-MicLine $pick)
  if (-not $pick.ok) { exit 0 }
  $null = Register-ObjectEvent -InputObject $rec -EventName AudioLevelUpdated -SourceIdentifier 'apexLevel'
  $null = Register-ObjectEvent -InputObject $rec -EventName SpeechDetected -SourceIdentifier 'apexSpeech'
  $null = Register-ObjectEvent -InputObject $rec -EventName RecognizeCompleted -SourceIdentifier 'apexDone'
  $rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
} catch {
  $e = $_.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  Out-Line ("MICERR`t" + (Format-MicText $e.Message))
  exit 0
}

$peak = 0
$speech = 0
$lastSent = [DateTime]::MinValue
$end = [DateTime]::UtcNow.AddSeconds($secs)
while ([DateTime]::UtcNow -lt $end) {
  $ev = Wait-Event -Timeout 1
  if ($null -eq $ev) { continue }
  $id = $ev.SourceIdentifier
  $args0 = $ev.SourceEventArgs
  Remove-Event -EventIdentifier $ev.EventIdentifier
  if ($id -eq 'apexLevel') {
    $lvl = [int]$args0.AudioLevel
    if ($lvl -gt $peak) { $peak = $lvl }
    $now = [DateTime]::UtcNow
    if (($now - $lastSent).TotalMilliseconds -ge 80) { Out-Line ("LEVEL`t$lvl"); $lastSent = $now }
  } elseif ($id -eq 'apexSpeech') {
    if ($speech -eq 0) { Out-Line 'SPEECH' }
    $speech = 1
  } elseif ($id -eq 'apexDone') {
    # Recognition ended early: the device failed under it.
    if ($null -ne $args0.Error) {
      $e = $args0.Error
      while ($null -ne $e.InnerException) { $e = $e.InnerException }
      Out-Line ("MICERR`t" + (Format-MicText $e.Message))
      exit 0
    }
    break
  }
}
try { $rec.RecognizeAsyncCancel() } catch {}
Out-Line ("DONE`t$peak`t$speech")
