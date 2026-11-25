# Tenancy specification revision 2.1: SQL validation harness

This folder preserves the **exact** harness that validated the SQL in [TENANCY_AND_DATA_CONVENTIONS.md](../../TENANCY_AND_DATA_CONVENTIONS.md) revision 2.1, together with the logs of its final runs. It is validation evidence for the approved baseline. It is not application code, and it is not yet part of CI.

## Provenance

- The six harness files are byte-for-byte copies of the files that produced the logs in [evidence/](evidence/). They were last modified on 2026-11-26 between 01:10 and 01:29 local time (IST); the logged runs started at 01:40:26 (superuser bootstrap) and 01:40:42 (non-superuser bootstrap).
- The specification used by those runs was byte-identical to revision 2.1 as approved. The later approval edit changed status wording and §12 only; no SQL block was changed.
- This README was written afterwards, when the harness was moved into the repository. No instructions file existed before; the steps below describe how the logged runs were executed.

| File | SHA-256 |
|---|---|
| `run_harness.ps1` | `9FB59006FEFCD20741560A31BBF7573387B553363792ABBDB15E2346D5440352` |
| `fixtures.sql` | `9C97A2D0FE57CBFDA661206EDC8A8F4ADCC95089A41F451E208D0A235FEEB3B5` |
| `tests_admin.sql` | `309E3585FB6D81E482289DAFB6727B96BE64A8FE09CCCB6BFBBC9E86A3971593` |
| `tests_api.sql` | `6C72A143C19682C7224AC50A675055DA2BB3A7D6571BC5E2E7688BD431097B43` |
| `tests_migrator.sql` | `430C319C22671712A1A7F637E642AA2C5B570C9C51527EC06BDB1D8E6044DE57` |
| `concurrency.sql` | `F7C42D270C2A10C19CA14310539F1CD6DD0E2BC62E98AAADEDBBAF67F07C378F` |
| `evidence/validation_sql_superuser.txt` | `BB7FAB925840519056D31ECE5376D4D8B5FFC28B3606EEFB7E3F9E8A8E92A46A` |
| `evidence/validation_sql_rds-emulated.txt` | `14E0920FE0BB700C0956625AA8C82D6F16B0951A204300A3BD6A8DCDA6D6886D` |

## Recorded results

| Bootstrap mode | Bootstrap administrator | Steps | Tests |
|---|---|---|---|
| `superuser` | `pgadmin` (superuser) | 21 of 21 exit 0 | **165 passed, 0 failed** |
| `rds-emulated` | `rds_sim` (non-superuser, `CREATEROLE` and `CREATEDB` only, owns the database) | 21 of 21 exit 0 | **165 passed, 0 failed** |

Server: PostgreSQL 18.4 (x86_64-windows), a temporary local instance. No AWS resources were used.

## What the harness does

1. Resets a throwaway database `hos` and the `hos_*` roles (and `rds_sim` in `rds-emulated` mode).
2. Extracts every `-- [validated …]` SQL block from the specification and runs it **as written**: blocks 01–02 as the bootstrap administrator, each migration block as `hos_migrator` after the session preamble, each in one transaction.
3. Prepares every `-- [validated statement …]` block with its parameter types.
4. Loads test fixtures (`fixtures.sql`) and runs the tests as the real login roles: `tests_admin.sql` (administrator session using `SET ROLE`), `tests_api.sql` (logged in as `hos_api`), `tests_migrator.sql` (logged in as `hos_migrator`), and the two-session concurrency pairs in `concurrency.sql`.
5. Prints each step's exit code, every test as PASS or FAIL, and a summary. The script exits 0 only if every step and every test passed.

## Re-running

**Prerequisites:** Windows PowerShell 5.1; PostgreSQL 16 or later client and server binaries; a **throwaway** local cluster. Never point it at a real database: it drops and recreates the `hos` database and the `hos_*` roles.

1. Create and start a throwaway cluster with a trusted local superuser named `pgadmin` on port 55432 (trust authentication is acceptable only for a disposable, localhost-only cluster):
   ```
   initdb -D <temp-dir>\data -U pgadmin --auth=trust -E UTF8 --locale=C
   pg_ctl -D <temp-dir>\data -o "-p 55432 -c listen_addresses=localhost" -l <temp-dir>\log.txt start
   ```
2. **Copy this folder to a location outside the repository**, because the harness writes generated files into a `work` folder next to itself.
3. Run, once per bootstrap mode, pointing `-Psql` at your `psql` and `-Spec` at the specification:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File run_harness.ps1 -Bootstrap superuser    -Spec <repo>\docs\architecture\TENANCY_AND_DATA_CONVENTIONS.md -Psql <path>\psql.exe
   powershell -NoProfile -ExecutionPolicy Bypass -File run_harness.ps1 -Bootstrap rds-emulated -Spec <repo>\docs\architecture\TENANCY_AND_DATA_CONVENTIONS.md -Psql <path>\psql.exe
   ```
   The defaults for `-Spec`, `-Psql` and `-Port` are the paths of the machine where the logged runs happened; override them elsewhere.
4. Stop and delete the throwaway cluster: `pg_ctl -D <temp-dir>\data -m fast stop`.

## Limitations

- **`rds-emulated` is an approximation, not Amazon RDS.** It uses a non-superuser administrator with only `CREATEROLE` and `CREATEDB`. Real RDS behaviour (`rds_superuser`, parameter permissions such as `session_replication_role`, `pgaudit`, log export) is unverified (specification §12).
- **Only PostgreSQL 18.4 was tested.** The specification's minimum version is 16.
- **SQL level only.** Tests marked *application test* in specification §8, the TypeScript examples and performance are not covered.
- **Limitation tests.** H-HIST-11 and H-HIST-12 pass by demonstrating that a superuser and the table owner **can** bypass the history guard. They do not show protection against privileged administrators (specification E-44, E-46).
- **Not part of CI.** Moving these tests into the project's test framework is a later task, which depends on the tooling decisions in specification §11.
- **Windows-specific runner.** The script uses Windows PowerShell and Windows paths. The SQL files are portable.
- **Documentation and Git checks** that ran alongside these tests used a separate local script that is not preserved here.
