# HOS tenancy specification validation harness. Local throwaway PostgreSQL only. ASCII-only source.
param(
  [string]$Spec = 'd:\HOS\docs\architecture\TENANCY_AND_DATA_CONVENTIONS.md',
  [int]$Port = 55432,
  [string]$Psql = 'N:\Postgre\bin\psql.exe',
  [ValidateSet('superuser', 'rds-emulated')][string]$Bootstrap = 'superuser'
)
$ErrorActionPreference = 'Continue'   # psql writes NOTICEs to stderr; exit codes are checked explicitly
$env:PGOPTIONS = '-c client_min_messages=warning'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $here 'work'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null
Set-Location $work
$env:PGCLIENTENCODING = 'UTF8'
$utf8 = New-Object Text.UTF8Encoding($false)
$admin = if ($Bootstrap -eq 'rds-emulated') { 'rds_sim' } else { 'pgadmin' }
$ids = [ordered]@{
  '{BOOTADMIN}'=$admin
  '{OrgA}'='0a000000-0000-7000-8000-000000000000'; '{OrgB}'='0b000000-0000-7000-8000-000000000000'
  '{A1}'='0a100000-0000-7000-8000-000000000000'; '{A2}'='0a200000-0000-7000-8000-000000000000'; '{B1}'='0b100000-0000-7000-8000-000000000000'
  '{HK1}'='d0a10000-0000-7000-8000-000000000001'; '{MT1}'='d0a10000-0000-7000-8000-000000000002'
  '{HK2}'='d0a20000-0000-7000-8000-000000000001'; '{HKB}'='d0b10000-0000-7000-8000-000000000001'
  '{ACT}'='ac000000-0000-7000-8000-000000000000'; '{COR}'='cc000000-0000-7000-8000-000000000000'
  '{UserA}'='ee0a0000-0000-7000-8000-000000000001'; '{UserB}'='ee0b0000-0000-7000-8000-000000000001'
  '{TaskA1}'='7a5c0000-0000-7000-8000-000000000001'; '{TaskA2}'='7a5c0000-0000-7000-8000-000000000002'
  '{TaskC}'='7a5c0000-0000-7000-8000-000000000003'; '{TaskD}'='7a5c0000-0000-7000-8000-000000000004'
  '{Guest}'='9e000000-0000-7000-8000-000000000001'; '{Guest2}'='9e000000-0000-7000-8000-000000000002'
  '{CFG}'='cf000000-0000-7000-8000-000000000001'; '{REF}'='0e000000-0000-7000-8000-000000000001'
}
function Expand-Tokens([string]$s) { foreach ($k in $ids.Keys) { $s = $s.Replace($k, $ids[$k]) }; $s }
function Write-File([string]$name, [string]$text) { $p = Join-Path $work $name; [IO.File]::WriteAllText($p, $text, $utf8); $p }
function Invoke-Psql([string]$user, [string]$db, [string]$file, [switch]$Single) {
  $a = @('-X', '-q', '-h', 'localhost', '-p', "$Port", '-U', $user, '-d', $db, '-v', 'ON_ERROR_STOP=1', '-f', $file)
  if ($Single) { $a = @('-1') + $a }
  $out = & $Psql @a 2>&1 | Out-String
  @{ Code = $LASTEXITCODE; Out = $out.Trim() }
}
$steps = New-Object System.Collections.ArrayList
function Add-Step([string]$name, $r) { [void]$steps.Add([pscustomobject]@{ Step = $name; Exit = $r.Code; Output = $r.Out }) }

# 1. Reset the throwaway cluster state.
$roles = 'hos_api','hos_worker','hos_migrator','hos_seclog_writer','hos_lookup_tenant','hos_lookup_identity','hos_history_writer','hos_history_reader','hos_history_eraser','hos_app','hos_owner'
$reset = "DROP DATABASE IF EXISTS hos WITH (FORCE);`n" + (($roles | ForEach-Object { "DROP ROLE IF EXISTS $_;" }) -join "`n") + "`nDROP ROLE IF EXISTS rds_sim;`n"
# rds-emulated: a non-superuser administrator with only CREATEROLE and CREATEDB that owns the cell database.
if ($Bootstrap -eq 'rds-emulated') { $reset += "CREATE ROLE rds_sim LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS;`nCREATE DATABASE hos OWNER rds_sim;`n" }
else { $reset += "CREATE DATABASE hos;`n" }
Add-Step 'reset' (Invoke-Psql 'pgadmin' 'postgres' (Write-File 'reset.sql' $reset))

# 2. Extract tagged SQL blocks from the specification.
$specText = [IO.File]::ReadAllText($Spec, [Text.Encoding]::UTF8)
$blocks = @(); $session = $null; $statements = @()
foreach ($m in [regex]::Matches($specText, '(?s)```sql\r?\n(-- \[validated ([^\]]+)\][^\n]*\n.*?)```')) {
  $body = $m.Groups[1].Value; $tag = $m.Groups[2].Value
  if ($tag -match '^(\d\d) (cluster-admin|database-admin|migration): (.+)$') { $blocks += [pscustomobject]@{ N = [int]$Matches[1]; Kind = $Matches[2]; Name = $Matches[3]; Body = $body } }
  elseif ($tag -match '^session: ') { $session = $body }
  elseif ($tag -match '^statement (\w+)\(([^)]*)\)$') { $statements += [pscustomobject]@{ Name = $Matches[1]; Types = $Matches[2]; Body = $body } }
  else { throw "Unrecognised tag: $tag" }
}
$dupes = $blocks | Group-Object N | Where-Object Count -gt 1
if ($dupes) { throw "Duplicate block numbers: $($dupes.Name -join ',')" }
Write-Output ("Bootstrap administrator: {0} ({1})" -f $admin, $Bootstrap)
Write-Output ("Extracted: {0} blocks ({1}), session preamble: {2}, statements: {3}" -f $blocks.Count, (($blocks | Sort-Object N | ForEach-Object { '{0:00}' -f $_.N }) -join ','), [bool]$session, $statements.Count)

# 3. Execute blocks in order, as the role each tag names. Each migration = preamble + block, in one transaction.
foreach ($b in ($blocks | Sort-Object N)) {
  $label = ('block {0:00} [{1}] {2}' -f $b.N, $b.Kind, $b.Name)
  switch ($b.Kind) {
    'cluster-admin'  { $r = Invoke-Psql $admin 'postgres' (Write-File ("block{0:00}.sql" -f $b.N) $b.Body) -Single }
    'database-admin' { $r = Invoke-Psql $admin 'hos' (Write-File ("block{0:00}.sql" -f $b.N) $b.Body) -Single }
    'migration'      { $r = Invoke-Psql 'hos_migrator' 'hos' (Write-File ("block{0:00}.sql" -f $b.N) ($session + "`n" + $b.Body)) -Single }
  }
  Add-Step $label $r
  if ($r.Code -ne 0) { break }
}

# 4. Prepared statements (validates every tagged statement with its parameter types).
$prep = ($statements | ForEach-Object { "PREPARE $($_.Name)($($_.Types)) AS`n" + ($_.Body.Trim() -replace ';\s*$', '') + ";`n" }) -join "`n"
$null = Write-File 'prepare.sql' $prep
Add-Step 'prepare statements (as hos_api)' (Invoke-Psql 'hos_api' 'hos' (Join-Path $work 'prepare.sql'))

# 5. Fixtures and tests.
if (($steps | Where-Object { $_.Exit -ne 0 }).Count -eq 0) {
  Add-Step 'fixtures (admin; tenant rows via hos_api)' (Invoke-Psql 'pgadmin' 'hos' (Write-File 'fixtures.sql' (Expand-Tokens ([IO.File]::ReadAllText((Join-Path $here 'fixtures.sql'))))))
  Add-Step 'tests_admin (admin with SET ROLE)' (Invoke-Psql 'pgadmin' 'hos' (Write-File 'tests_admin.sql' (Expand-Tokens ([IO.File]::ReadAllText((Join-Path $here 'tests_admin.sql'))))))
  Add-Step 'tests_api (login hos_api)' (Invoke-Psql 'hos_api' 'hos' (Write-File 'tests_api.sql' (Expand-Tokens ([IO.File]::ReadAllText((Join-Path $here 'tests_api.sql'))))))
  Add-Step 'tests_migrator (login hos_migrator)' (Invoke-Psql 'hos_migrator' 'hos' (Write-File 'tests_migrator.sql' (Expand-Tokens ([IO.File]::ReadAllText((Join-Path $here 'tests_migrator.sql'))))))
  # Preamble run by a non-migrator login must fail.
  $r = Invoke-Psql 'hos_api' 'hos' (Write-File 'preamble_as_api.sql' $session)
  $ok = if ($r.Code -ne 0) { 'true' } else { 'false' }
  $null = Invoke-Psql 'pgadmin' 'hos' (Write-File 'rec.sql' "SELECT t.check('H-MIG-14 session preamble run as hos_api is refused (psql exit $($r.Code))', $ok);")

  # 6. Two-session concurrency tests.
  $conc = Expand-Tokens ([IO.File]::ReadAllText((Join-Path $here 'concurrency.sql')))
  $parts = @{}; foreach ($m in [regex]::Matches($conc, '(?s)-- @@ (\w+)\r?\n(.*?)(?=-- @@ |\z)')) { $parts[$m.Groups[1].Value] = $m.Groups[2].Value }
  foreach ($pair in @('dept', 'idem_commit', 'idem_rollback', 'idem_timeout')) {
    $fa = Write-File "$pair`_a.sql" $parts["$pair`_a"]; $fb = Write-File "$pair`_b.sql" $parts["$pair`_b"]
    $common = @('-X', '-q', '-h', 'localhost', '-p', "$Port", '-U', 'hos_api', '-d', 'hos', '-f')
    $pa = Start-Process -FilePath $Psql -ArgumentList ($common + $fa) -NoNewWindow -PassThru -WorkingDirectory $work -RedirectStandardOutput "$fa.out" -RedirectStandardError "$fa.err"
    Start-Sleep -Milliseconds 1000
    $pb = Start-Process -FilePath $Psql -ArgumentList ($common + $fb) -NoNewWindow -PassThru -WorkingDirectory $work -RedirectStandardOutput "$fb.out" -RedirectStandardError "$fb.err"
    $pa.WaitForExit(); $pb.WaitForExit()
    $errA = (Get-Content "$fa.err" -Raw); $errB = (Get-Content "$fb.err" -Raw)
    Add-Step "concurrency $pair (two hos_api sessions)" @{ Code = [Math]::Max($pa.ExitCode, $(if ($pair -eq 'idem_timeout') { 0 } else { $pb.ExitCode })); Out = ("A: $errA B: $errB").Trim() }
  }
}

# 7. Report.
Write-Output ''
Write-Output '=== Execution steps ==='
foreach ($s in $steps) { Write-Output ("[exit {0}] {1}" -f $s.Exit, $s.Step); if ($s.Exit -ne 0 -and $s.Output) { Write-Output ("    " + ($s.Output -replace "`n", "`n    ")) } }
$q = "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || test || CASE WHEN ok THEN '' ELSE ' | ' || coalesce(detail, '') END FROM t.results ORDER BY id;"
$res = & $Psql -X -q -A -t -h localhost -p $Port -U pgadmin -d hos -c $q 2>&1
Write-Output ''
Write-Output '=== Test results ==='
$res | ForEach-Object { Write-Output $_ }
$pass = @($res | Where-Object { $_ -like 'PASS*' }).Count; $fail = @($res | Where-Object { $_ -like 'FAIL*' }).Count
$stepFail = @($steps | Where-Object { $_.Exit -ne 0 }).Count
Write-Output ''
Write-Output ("SUMMARY: steps={0} (failed {1}); tests passed={2} failed={3}" -f $steps.Count, $stepFail, $pass, $fail)
if ($stepFail -gt 0 -or $fail -gt 0 -or $pass -eq 0) { exit 1 } else { exit 0 }
