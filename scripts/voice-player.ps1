# scripts/voice-player.ps1 — plays Piper's WAV output.
# -----------------------------------------------------------------------------
# Reads one WAV path per line from stdin, plays it synchronously (so answers
# queue rather than overlap), then deletes the file — Piper writes one WAV per
# utterance into a temp dir and someone has to sweep up. Persistent for the
# same reason as voice-speaker.ps1: no per-utterance process spin-up.
$ErrorActionPreference = 'Stop'

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -and (Test-Path -LiteralPath $line)) {
    try {
      $p = New-Object System.Media.SoundPlayer $line
      $p.PlaySync()
    } catch { }
    try { Remove-Item -LiteralPath $line -Force } catch { }
    [Console]::Out.WriteLine("PLAYED")
    [Console]::Out.Flush()
  }
}
