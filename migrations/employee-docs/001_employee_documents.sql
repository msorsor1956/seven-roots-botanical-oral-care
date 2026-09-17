BEGIN;
CREATE TABLE IF NOT EXISTS employee_documents (id uuid PRIMARY KEY, employee_id text NOT NULL, verification_submission_id text NOT NULL, doc_type text NOT NULL, storage_key text UNIQUE NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, sha256 text NOT NULL, captured_at timestamptz, expires_at timestamptz, review_status text NOT NULL DEFAULT 'PENDING', reviewed_by text, reviewed_at timestamptz, review_notes text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS employee_document_sha256_idx ON employee_documents(sha256);
CREATE TABLE IF NOT EXISTS verification_audit (id uuid PRIMARY KEY, actor_id text NOT NULL, employee_id text NOT NULL, action text NOT NULL, document_id text, metadata jsonb NOT NULL DEFAULT '{}', ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS document_access_log (id uuid PRIMARY KEY, actor_id text NOT NULL, employee_id text NOT NULL, document_id text NOT NULL, action text NOT NULL, ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
COMMIT;
