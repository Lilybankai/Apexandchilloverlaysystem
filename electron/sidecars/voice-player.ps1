# voice-player.ps1 — the engineer's audio player sidecar.
# -----------------------------------------------------------------------------
# Plays WAV paths from stdin synchronously, deleting each file after playback.
# The PLAYED lines it prints are the speech queue's clock in engineer.js.
#
# Ships as a plain signed script in the app's resources (extraResources) and is
# run with `-File` — never as an encoded command. Encoded PowerShell is a
# classic antivirus-heuristic tell, and everything this app spawns has to look
# as unremarkable as it is (v0.79.x Norton field reports).

$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -and (Test-Path -LiteralPath $line)) {
    try { (New-Object System.Media.SoundPlayer $line).PlaySync() } catch { }
    try { Remove-Item -LiteralPath $line -Force } catch { }
    [Console]::Out.WriteLine('PLAYED'); [Console]::Out.Flush()
  }
}
