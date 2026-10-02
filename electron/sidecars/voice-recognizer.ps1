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
# Rejected utterances keep their audio too. Without desktop dictation (absent
# on many Windows installs) nothing can win an off-list sentence, so
# Recognize() returns null — and "what's my average" used to die as NONE,
# "Say again?", never reaching whisper (field report, 2026-10-01). The engine
# still raises SpeechRecognitionRejected with the utterance's audio. That
# event is QUEUED, not handled — Register-ObjectEvent with no -Action runs no
# script on the engine's thread — and the main loop collects it after
# Recognize() returns, writes the wav and prints REJECTED. NONE now means
# what it says: no usable speech in the window at all.
#
# Lines out: READY, DICTOK, ERROR<tab>msg, and exactly one per LISTEN —
#   HEARD<tab>intent<tab>conf<tab>wav<tab>text
#   FREE<tab>wav<tab>conf<tab>text
#   REJECTED<tab>wav<tab>conf<tab>text      (text is SAPI's low-grade guess)
#   NONE
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
  # A driver's question has a breath in it ("what's my... average"). With the
  # wildcard grammars every partial match is AMBIGUOUS, so this is the pause
  # that ends the utterance; the 0.5 s default cut sentences mid-thought and
  # whisper only ever heard the first half. Babble timeout stays disabled (0):
  # it would cut exactly the long sentences Tier 2 exists for.
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(750)
  $rec.BabbleTimeout = [TimeSpan]::Zero
  $null = Register-ObjectEvent -InputObject $rec -EventName SpeechRecognitionRejected -SourceIdentifier 'apexRejected'
  $null = Register-ObjectEvent -InputObject $rec -EventName SpeechDetected -SourceIdentifier 'apexDetected'
  $rec.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Out.WriteLine("ERROR`t" + $_.Exception.Message); [Console]::Out.Flush()
  exit 1
}

# Write one result's retained audio for whisper; '' when there is none.
function Save-Clip($result) {
  try {
    if ($null -eq $result -or $null -eq $result.Audio) { return '' }
    $wav = Join-Path $env:APEX_ENGINEER_WAVDIR ("free-" + [DateTime]::UtcNow.Ticks + ".wav")
    $fsOut = [System.IO.File]::Create($wav)
    try { $result.Audio.WriteToWaveStream($fsOut) } finally { $fsOut.Close() }
    return $wav
  } catch { return '' }
}

# Drop anything an earlier listen left in the queue.
function Clear-Queued {
  Get-Event -SourceIdentifier 'apexRejected' -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier 'apexDetected' -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}

# The listen ended with no winner: was it silence, or speech nothing matched?
function Get-RejectedLine {
  try {
    $rej = @(Get-Event -SourceIdentifier 'apexRejected' -ErrorAction SilentlyContinue)
    if ($rej.Count -eq 0) {
      # Speech was detected but its rejection is not queued yet — give the
      # engine's thread a moment rather than call it silence.
      $heard = @(Get-Event -SourceIdentifier 'apexDetected' -ErrorAction SilentlyContinue)
      if ($heard.Count -eq 0) { return 'NONE' }
      $null = Wait-Event -SourceIdentifier 'apexRejected' -Timeout 1
      $rej = @(Get-Event -SourceIdentifier 'apexRejected' -ErrorAction SilentlyContinue)
      if ($rej.Count -eq 0) { return 'NONE' }
    }
    $res = $rej[$rej.Count - 1].SourceEventArgs.Result
    $saved = Save-Clip $res
    if ($saved -eq '') { return 'NONE' }
    $conf = [math]::Round($res.Confidence, 2)
    $text = ([string]$res.Text) -replace "[`t`r`n]", ' '
    return "REJECTED`t$saved`t$conf`t$text"
  } catch {
    return 'NONE'
  } finally {
    Clear-Queued
  }
}

[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
if ($null -ne $dict) { [Console]::Out.WriteLine('DICTOK'); [Console]::Out.Flush() }
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  if ($cmd -notmatch '^LISTEN') { continue }
  $secs = 6
  if ($cmd -match 'LISTEN (\d+)') { $secs = [int]$Matches[1] }
  Clear-Queued
  $r = $rec.Recognize([TimeSpan]::FromSeconds($secs))
  if ($null -eq $r) {
    [Console]::Out.WriteLine((Get-RejectedLine)); [Console]::Out.Flush()
    continue
  }
  Clear-Queued
  $conf = [math]::Round($r.Confidence, 2)
  # Retain the utterance audio for EVERY result, not only dictation ones. A
  # low-confidence grammar match used to arrive with no audio at all, so the
  # app could neither verify it with whisper nor fall through to the cloud —
  # the driver's "tyres" simply died. The wav rides the HEARD line so the app
  # can second-guess SAPI with the better recognizer.
  $saved = Save-Clip $r
  if ($r.Grammar.Name -ne 'free') {
    [Console]::Out.WriteLine("HEARD`t$($r.Grammar.Name)`t$conf`t$saved`t$($r.Text)")
  } else {
    [Console]::Out.WriteLine("FREE`t$saved`t$conf`t$($r.Text)")
  }
  [Console]::Out.Flush()
}
