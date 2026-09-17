BEGIN;
CREATE TABLE IF NOT EXISTS training_modules (
  id text PRIMARY KEY, code text UNIQUE NOT NULL, title text NOT NULL, content jsonb NOT NULL,
  module_order integer UNIQUE NOT NULL, knowledge_question text NOT NULL, correct_answer_hash text NOT NULL,
  revision text NOT NULL DEFAULT '1.0', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employee_training_profiles (
  id uuid PRIMARY KEY, user_id text UNIQUE NOT NULL, full_name text NOT NULL, employee_number text NOT NULL,
  job_title text NOT NULL, work_location text NOT NULL CHECK (work_location IN ('liberia','us')),
  manager_id text, start_date date NOT NULL, selfie_doc_id text, signature_doc_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS training_submissions (
  id uuid PRIMARY KEY, employee_id text NOT NULL, status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  submitted_at timestamptz, approved_at timestamptz, approved_by text, rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS module_completions (
  id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES training_submissions(id), module_id text NOT NULL REFERENCES training_modules(id),
  read_confirmed boolean NOT NULL, signature_doc_id text NOT NULL, signed_at timestamptz NOT NULL,
  knowledge_answer text NOT NULL, is_correct boolean NOT NULL, UNIQUE(submission_id,module_id)
);
CREATE TABLE IF NOT EXISTS verification_submissions (
  id uuid PRIMARY KEY, employee_id text NOT NULL, status text NOT NULL DEFAULT 'NOT_STARTED', legal_name text,
  date_of_birth_ciphertext text, nationality text, country_of_residence text, id_type text, issuing_country text,
  id_number_ciphertext text, id_number_hash text, id_expiry date, address_ciphertext text, signature_doc_id text,
  submitted_at timestamptz, reviewed_at timestamptz, reviewed_by text, rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_employee_status_idx ON verification_submissions(employee_id,status);
CREATE TABLE IF NOT EXISTS employee_references (
  id uuid PRIMARY KEY, verification_submission_id uuid NOT NULL REFERENCES verification_submissions(id),
  full_name text NOT NULL, phone_ciphertext text NOT NULL, phone_hash text NOT NULL, relationship text,
  company text, email_ciphertext text, verifier_note text, review_status text NOT NULL DEFAULT 'PENDING',
  reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_distinct_phone_idx ON employee_references(verification_submission_id,phone_hash);
CREATE TABLE IF NOT EXISTS document_pointers (
  id uuid PRIMARY KEY, owner_type text NOT NULL, owner_id text NOT NULL, doc_type text NOT NULL,
  storage_key text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, sha256 text NOT NULL,
  doc_database text NOT NULL, doc_record_id text NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), uploaded_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS training_audit_log (
  id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, entity text NOT NULL, entity_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', ip_address inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS training_outbox (
  id uuid PRIMARY KEY, event_type text NOT NULL, entity_id text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
