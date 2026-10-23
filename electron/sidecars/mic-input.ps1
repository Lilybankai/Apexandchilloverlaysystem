# mic-input.ps1 - which microphone the engineer's ears listen on.
# -----------------------------------------------------------------------------
# Dot-sourced by voice-recognizer.ps1 (the push-to-talk listener) and
# voice-mics.ps1 (the panel's device scan and mic test), so the test hears
# exactly what a press would.
#
# System.Speech's public API can only listen on "the default audio device",
# and even that is not what a driver thinks it is: SetInputToDefaultAudioDevice
# reads the SAPI DefaultTokenId (HKCU\Software\Microsoft\Speech\AudioInput),
# which the old Speech Recognition control panel can pin to ONE device. Pin it
# to a webcam years ago, unplug the webcam, and every System.Speech app on the
# PC has no microphone while the headset sits there as Windows' default.
#
# So the input is set the way SetInputToDefaultAudioDevice does it inside
# (System.Speech 4.0, the same on every Windows 10/11 .NET Framework 4.8):
# build a SAPI object token for the device, hand it to the engine's
# SapiRecognizer.SetInput(token, true), refresh the cached audio format. Only
# methods are invoked - no private field is written. The public call runs
# first, so the engine's own "has an input" bookkeeping is always set by
# System.Speech itself; when even that fails (no default device at all), an
# empty stream stands in for the bookkeeping and the token swap does the rest.
#
# Tokens: <category>\TokenEnums\MMAudioIn\{endpoint id} for one device, and
# the bare ...\MMAudioIn\ token for "whatever Windows' default recording device
# is when the mic opens" - that bare token is what "System default" means here.

$script:MicCategory = 'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\AudioInput'
$script:MicDefaultToken = 'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\AudioInput\TokenEnums\MMAudioIn\'

# One line, no tabs: everything printed rides a tab-separated protocol.
function Format-MicText([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace "[`t`r`n]+", ' ').Trim()
}

# Every audio input SAPI can open, as @{ id; name }.
function Get-MicDevices {
  $cat = New-Object -ComObject SAPI.SpObjectTokenCategory
  $cat.SetId($script:MicCategory, $false)
  $list = @()
  foreach ($t in $cat.EnumerateTokens()) {
    $list += [pscustomobject]@{ id = [string]$t.Id; name = (Format-MicText ([string]$t.GetDescription(0))) }
  }
  return ,$list
}

# A token's display name, or $null when there is no such device right now.
function Get-MicName([string]$id) {
  try {
    $t = New-Object -ComObject SAPI.SpObjectToken
    $t.SetId($id, '', $false)
    return (Format-MicText ([string]$t.GetDescription(0)))
  } catch {
    return $null
  }
}

# Point the engine at one token. '' on success, else the reason.
function Set-MicToken($rec, [string]$id) {
  try {
    $bf = [Reflection.BindingFlags]'Instance,NonPublic,Public'
    $asm = [System.Speech.Recognition.SpeechRecognitionEngine].Assembly
    $tokType = $asm.GetType('System.Speech.Internal.SapiInterop.SpObjectToken')
    $tokIface = $asm.GetType('System.Speech.Internal.SapiInterop.ISpObjectToken')
    $baseField = [System.Speech.Recognition.SpeechRecognitionEngine].GetField('_recognizerBase', $bf)
    if ($null -eq $tokType -or $null -eq $tokIface -or $null -eq $baseField) { return 'picker unavailable on this Windows' }
    $tok = [Activator]::CreateInstance($tokType)
    $null = $tokIface.GetMethod('SetId').Invoke($tok, [object[]]@($null, $id, $false))
    $base = $baseField.GetValue($rec)
    $sapi = $base.GetType().GetProperty('SapiRecognizer', $bf).GetValue($base, $null)
    $null = $sapi.GetType().GetMethod('SetInput', $bf).Invoke($sapi, [object[]]@($tok, $true))
    $null = $base.GetType().GetMethod('UpdateAudioFormat', $bf).Invoke($base, [object[]]@($null))
    return ''
  } catch {
    $e = $_.Exception
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    $msg = Format-MicText $e.Message
    if ($msg -eq '') { $msg = 'could not open the device' }
    return $msg
  }
}

# Choose the input for $rec. $micId '' = System default. Returns
#   @{ ok; source = picked|default|fallback; name; why }
# where fallback means the saved device could not be used (why says how) and
# the system default is listening instead.
function Set-MicInput($rec, [string]$micId) {
  $publicOk = $false
  $publicErr = ''
  try {
    $rec.SetInputToDefaultAudioDevice()
    $publicOk = $true
  } catch {
    $publicErr = Format-MicText $_.Exception.Message
    try {
      $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $rec.SetInputToAudioStream((New-Object System.IO.MemoryStream), $fmt)
    } catch {}
  }

  $why = ''
  if ($micId -ne '') {
    $name = Get-MicName $micId
    if ($null -eq $name) {
      $why = 'missing'
    } else {
      $err = Set-MicToken $rec $micId
      if ($err -eq '') { return @{ ok = $true; source = 'picked'; name = $name; why = '' } }
      $why = $err
    }
  }

  $source = 'default'
  if ($why -ne '') { $source = 'fallback' }
  $defName = Get-MicName $script:MicDefaultToken
  $err = Set-MicToken $rec $script:MicDefaultToken
  if ($err -eq '') {
    if ($null -eq $defName) { $defName = '' }
    return @{ ok = $true; source = $source; name = $defName; why = $why }
  }
  # The token route failed; the public default (if it worked) is still set.
  if ($publicOk) {
    if ($null -eq $defName) { $defName = '' }
    return @{ ok = $true; source = $source; name = $defName; why = $why }
  }
  $reason = $publicErr
  if ($reason -eq '') { $reason = $err }
  return @{ ok = $false; source = ''; name = ''; why = $reason }
}

# The protocol line for a Set-MicInput result:
#   MIC<tab>source<tab>name<tab>why      (why only for fallback)
#   NOMIC<tab>reason
function Format-MicLine($r) {
  if ($r.ok) { return "MIC`t$($r.source)`t$($r.name)`t$(Format-MicText $r.why)" }
  return "NOMIC`t$(Format-MicText $r.why)"
}
