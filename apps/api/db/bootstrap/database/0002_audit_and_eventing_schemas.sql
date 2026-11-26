-- HOS bootstrap, database revision 0002: the audit and eventing schemas (B-03) and CONNECT for the
-- cluster revision 0002 login roles. Same pattern as revision 0001 (C-23): one transaction, and the
-- temporary SET-only membership is removed before it ends.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hos_relay, hos_monitor', current_database());
END $$;
GRANT hos_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
CREATE SCHEMA audit    AUTHORIZATION hos_owner;
CREATE SCHEMA eventing AUTHORIZATION hos_owner;
REVOKE hos_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
