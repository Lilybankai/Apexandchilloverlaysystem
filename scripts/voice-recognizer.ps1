# scripts/voice-recognizer.ps1 — offline grammar-based speech recognition.
# -----------------------------------------------------------------------------
# Sidecar for spike-voice-engineer.js. Loads a small fixed grammar (the same
# trick CrewChief uses via Microsoft.Speech: a closed phrase list makes the
# recognizer near-perfect, because it only has to pick between ~20 things you
# could have said) and prints one tab-separated line per recognition:
#
#   HEARD<TAB><intent><TAB><confidence 0..1><TAB><text as heard>
#
# The grammar comes in as JSON: [{ "intent": "gapAhead", "phrases": ["gap ahead", ...] }, ...]
# Written by the Node side to a temp file so there is exactly one phrase table.
#
# Recognition runs SYNCHRONOUSLY in a loop rather than via events — an event
# action's output lives in another runspace and does not reliably reach
# redirected stdout, which cost this spike its first half hour.
param(
  [Parameter(Mandatory = $true)][string]$GrammarPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$defs = Get-Content -Raw -LiteralPath $GrammarPath | ConvertFrom-Json

try {
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
} catch {
  [Console]::Out.WriteLine("ERROR`tNo speech recognizer installed: $($_.Exception.Message)")
  exit 1
}

# Two grammars per intent: the bare phrase, and the phrase embedded in a
# sentence (wildcards absorb whatever surrounds it — "mate, what's the gap
# ahead right now" still hits gapAhead). Both are loaded because a wildcard
# grammar wants speech around the keyword; the bare one keeps the terse
# radio-style ask working. Confidence rides on the result either way, and the
# Node side applies the threshold.
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

try {
  $rec.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Out.WriteLine("ERROR`tNo microphone / default input device: $($_.Exception.Message)")
  exit 1
}

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
  $r = $rec.Recognize()   # blocks until a phrase (or silence timeout -> $null)
  if ($null -ne $r) {
    $conf = [math]::Round($r.Confidence, 2)
    [Console]::Out.WriteLine("HEARD`t$($r.Grammar.Name)`t$conf`t$($r.Text)")
    [Console]::Out.Flush()
  }
}
