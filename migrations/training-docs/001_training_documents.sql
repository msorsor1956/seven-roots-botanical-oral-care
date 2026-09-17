BEGIN;
CREATE TABLE IF NOT EXISTS training_selfies (id uuid PRIMARY KEY, employee_id text NOT NULL, storage_key text UNIQUE NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, sha256 text NOT NULL, captured_at timestamptz NOT NULL, ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS training_signatures (id uuid PRIMARY KEY, employee_id text NOT NULL, submission_id text, module_id text, signature_type text NOT NULL, storage_key text UNIQUE NOT NULL, sha256 text NOT NULL, signed_at timestamptz NOT NULL, ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS training_certificates (id uuid PRIMARY KEY, employee_id text NOT NULL, submission_id text NOT NULL, storage_key text UNIQUE NOT NULL, issued_at timestamptz NOT NULL, verification_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS training_document_audit (id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, document_id text, metadata jsonb NOT NULL DEFAULT '{}', ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
COMMIT;
