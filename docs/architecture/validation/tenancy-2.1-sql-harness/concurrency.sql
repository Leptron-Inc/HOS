-- Concurrency session scripts. The harness splits this file on '-- @@ name' markers.
-- @@ dept_a
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE task_lock('{TaskC}', '{OrgA}');
SELECT pg_sleep(3);
EXECUTE task_complete('{TaskC}', '{OrgA}', '{HK1}', 1, '{ACT}');
SELECT t.check('H-DEPT-05 session 1 completes the task it locked (one row)', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
COMMIT;
-- @@ dept_b
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE task_reassign('{TaskC}', '{OrgA}', '{HK1}', '{MT1}', 1, '{ACT}');
SELECT t.check('H-DEPT-05 concurrent reassignment affects 0 rows after the lock is released', :ROW_COUNT = 0, 'rows=' || :ROW_COUNT);
SELECT t.check('H-DEPT-05 the reassignment waited for the lock', clock_timestamp() - now() > interval '1 second', (clock_timestamp() - now())::text);
COMMIT;
-- @@ idem_commit_a
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-c', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-04 session 1 acquires the key', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
SELECT pg_sleep(3);
EXECUTE idem_complete('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-c', 201, '{}', '{"id": "c"}');
COMMIT;
-- @@ idem_commit_b
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-c', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-04 session 2 gets no row once session 1 commits', :ROW_COUNT = 0, 'rows=' || :ROW_COUNT);
SELECT t.check('H-IDEM-04 session 2 waited for session 1', clock_timestamp() - now() > interval '1 second', (clock_timestamp() - now())::text);
EXECUTE idem_lookup('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-c') \gset lk_
SELECT t.check('H-IDEM-04 session 2 finds session 1''s committed response', :'lk_response_status' = '201', :'lk_response_status');
COMMIT;
-- @@ idem_rollback_a
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-r', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT pg_sleep(3);
ROLLBACK;
-- @@ idem_rollback_b
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-r', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT t.check('H-IDEM-05 after session 1 rolls back, session 2 owns the key', :ROW_COUNT = 1, 'rows=' || :ROW_COUNT);
SELECT t.check('H-IDEM-05 session 2 waited for session 1', clock_timestamp() - now() > interval '1 second', (clock_timestamp() - now())::text);
COMMIT;
-- @@ idem_timeout_a
\set ON_ERROR_STOP 1
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-t', decode(repeat('ab', 32), 'hex'), '24 hours');
SELECT pg_sleep(4);
COMMIT;
-- @@ idem_timeout_b
\set ON_ERROR_STOP 0
\i prepare.sql
BEGIN;
SELECT t.ctx('{OrgA}', 'all', '{}');
SET LOCAL lock_timeout = '1s';
EXECUTE idem_acquire('{OrgA}', '{ACT}', 'POST /v1/tasks', 'key-t', decode(repeat('ab', 32), 'hex'), '24 hours');
ROLLBACK;
\set ON_ERROR_STOP 1
SELECT t.check('H-IDEM-06 a waiting request times out with 55P03 (idempotency_in_progress)',
  :'LAST_ERROR_SQLSTATE' = '55P03', :'LAST_ERROR_SQLSTATE');
