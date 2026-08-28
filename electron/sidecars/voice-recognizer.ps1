# voice-recognizer.ps1 — the engineer's push-to-talk ears.
# -----------------------------------------------------------------------------
# One-shot recognition on command. Blocks on stdin; each LISTEN runs a single
# bounded Recognize() — the microphone is captured only inside that call.
# Grammar JSON path arrives via APEX_ENGINEER_GRAMMAR, the scratch dir for
# free-form clips via APEX_ENGINEER_WAVDIR. Runs synchronously throughout:
# event-handler output does not reliably reach redirected stdout from another
# runspace.
#
# Tier 2 rides the SAME listen, not a second recorder: a DictationGrammar
# (named `free`) is loaded beside the closed grammar, and when it wins the
# result's own retained audio is written out for whisper. One utterance, one
# device owner, and the closed grammar keeps returning THE INSTANT it matches.
#
# Ships as a plain signed script in the app's resources (extraResources) and is
# run with `-File` — never as an encoded command (antivirus-heuristic tell).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
try {
  $defs = Get-Content -Raw -LiteralPath $env:APEX_ENGINEER_GRAMMAR | ConvertFrom-Json
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  foreach ($d in $defs) {
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in $d.phrases) { $choices.Add([string]$p) }
    $exact = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $g1 = New-Object System.Speech.Recognition.Grammar($exact)
    $g1.Name = [string]$d.intent
    $rec.LoadGrammar($g1)
    $wrapped = New-Object System.Speech.Recognition.GrammarBuilder
    $wrapped.AppendWildcard()
    $wrapped.Append($choices)
    $wrapped.AppendWildcard()
    $g2 = New-Object System.Speech.Recognition.Grammar($wrapped)
    $g2.Name = [string]$d.intent
    $rec.LoadGrammar($g2)
  }
  $dict = $null
  try {
    $dict = New-Object System.Speech.Recognition.DictationGrammar
    $dict.Name = 'free'
    $rec.LoadGrammar($dict)
  } catch { $dict = $null }
  $rec.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Out.WriteLine("ERROR`t" + $_.Exception.Message); [Console]::Out.Flush()
  exit 1
}
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
if ($null -ne $dict) { [Console]::Out.WriteLine('DICTOK'); [Console]::Out.Flush() }
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  if ($cmd -notmatch '^LISTEN') { continue }
  $secs = 6
  if ($cmd -match 'LISTEN (\d+)') { $secs = [int]$Matches[1] }
  $r = $rec.Recognize([TimeSpan]::FromSeconds($secs))
  if ($null -eq $r) {
    [Console]::Out.WriteLine('NONE'); [Console]::Out.Flush()
    continue
  }
  $conf = [math]::Round($r.Confidence, 2)
  # Retain the utterance audio for EVERY result, not only dictation ones. A
  # low-confidence grammar match used to arrive with no audio at all, so the
  # app could neither verify it with whisper nor fall through to the cloud —
  # the driver's "tyres" simply died. The wav rides the HEARD line so the app
  # can second-guess SAPI with the better recognizer.
  $saved = ''
  try {
    if ($null -ne $r.Audio) {
      $wav = Join-Path $env:APEX_ENGINEER_WAVDIR ("free-" + [DateTime]::UtcNow.Ticks + ".wav")
      $fsOut = [System.IO.File]::Create($wav)
      try { $r.Audio.WriteToWaveStream($fsOut) } finally { $fsOut.Close() }
      $saved = $wav
    }
  } catch { $saved = '' }
  if ($r.Grammar.Name -ne 'free') {
    [Console]::Out.WriteLine("HEARD`t$($r.Grammar.Name)`t$conf`t$saved`t$($r.Text)")
  } else {
    [Console]::Out.WriteLine("FREE`t$saved`t$conf`t$($r.Text)")
  }
  [Console]::Out.Flush()
}
