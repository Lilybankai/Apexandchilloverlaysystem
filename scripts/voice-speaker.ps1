# scripts/voice-speaker.ps1 — local TTS sidecar.
# -----------------------------------------------------------------------------
# Reads one line per utterance from stdin and speaks it with the default SAPI
# voice, synchronously (so overlapping answers queue instead of talking over
# each other). Kept as a persistent process because SpeechSynthesizer takes the
# better part of a second to construct — a per-utterance `powershell -Command`
# would put that on every radio reply.
#
# This is the spike voice, not the shipping one: the plan's P3 upgrades to a
# Windows 11 Natural voice or Piper, and bookends with the synthesized radio
# squelch the overlay already has. SAPI here proves the plumbing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 1

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line) {
    try { $s.Speak($line) } catch { }
    [Console]::Out.WriteLine("SPOKE")
    [Console]::Out.Flush()
  }
}
