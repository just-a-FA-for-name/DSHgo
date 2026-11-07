# Prints every web port the desktop app listens on (one per line, sorted).
#
# Why every host process and not just the first one: this plugin starts its own
# `dsh web` cookie-minter, which is also a DeepSeek Harness process whose command
# line contains "desktop-host". Taking `Select-Object -First 1` therefore
# sometimes picked the *minter* (a bare base+web-app profile with none of the
# user's plugins) instead of the real desktop host, and the phone then showed the
# wrong app: no plugins, only the built-in models, empty session state, and a 404
# on /phone-remote/state.
#
# So: enumerate all of them and let the caller probe each port for a response
# that actually contains the composed profile (the caller checks for
# `__DSH_BOOT__`), then keep the root that answers.
$procs = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'desktop-host' }

$ids = @($procs | ForEach-Object { $_.ProcessId })
if ($ids.Count -eq 0) { exit 0 }

$table = @(netstat -ano | Select-String 'LISTENING')
$found = New-Object System.Collections.Generic.List[int]
foreach ($id in $ids) {
  foreach ($row in $table) {
    if ($row.Line -match ('\sLISTENING\s+' + $id + '\s*$')) {
      $cols = ($row.Line.Trim() -split '\s+')
      $local = $cols[1]
      $port = [int](($local -split ':')[-1])
      if ($port -gt 0 -and -not $found.Contains($port)) { $found.Add($port) }
    }
  }
}
$found | Sort-Object
