-- Executive Visuals financial intelligence foundation.
-- Staging-first: apply only to the isolated Executive Visuals Supabase project
-- after reviewing RLS and storage policies. No live merchant configuration is changed.

create table if not exists executive_visuals.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','platform_admin','billing_admin','support')),
  granted_by uuid references auth.users(id),
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);

create table if not exists executive_visuals.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  provider text not null default 'flutterwave' check (provider in ('flutterwave')),
  provider_transaction_id text,
  tx_ref text not null,
  flw_ref text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending','successful','failed','cancelled')),
  payment_method text,
  customer_email text,
  description text not null default '',
  provider_fee_minor bigint check (provider_fee_minor is null or provider_fee_minor >= 0),
  paid_at timestamptz,
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, tx_ref)
);
create unique index if not exists payment_transactions_provider_id_uq
  on executive_visuals.payment_transactions(provider, provider_transaction_id)
  where provider_transaction_id is not null;
create index if not exists payment_transactions_owner_created_idx
  on executive_visuals.payment_transactions(owner_id, created_at desc);
create index if not exists payment_transactions_status_idx
  on executive_visuals.payment_transactions(status, created_at desc);

create table if not exists executive_visuals.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  entry_type text not null check (entry_type in ('purchase_grant','reservation','settlement','refund_reversal','manual_adjustment','expiration')),
  credit_delta bigint not null check (credit_delta <> 0),
  idempotency_key text not null,
  payment_transaction_id uuid references executive_visuals.payment_transactions(id) on delete restrict,
  refund_id uuid,
  job_id uuid,
  reason text not null check (char_length(reason) between 3 and 500),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique(owner_id, idempotency_key)
);
create index if not exists credit_ledger_owner_created_idx
  on executive_visuals.credit_ledger(owner_id, created_at desc);
create index if not exists credit_ledger_payment_idx
  on executive_visuals.credit_ledger(payment_transaction_id, entry_type);

create table if not exists executive_visuals.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  payment_transaction_id uuid not null references executive_visuals.payment_transactions(id) on delete restrict,
  provider text not null default 'flutterwave' check (provider in ('flutterwave')),
  provider_refund_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('requested','processing','succeeded','failed')),
  reason text not null check (char_length(reason) between 3 and 500),
  idempotency_key text not null,
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_code text,
  failure_message text,
  provider_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, idempotency_key)
);
create unique index if not exists payment_refunds_provider_id_uq
  on executive_visuals.payment_refunds(provider, provider_refund_id)
  where provider_refund_id is not null;
create index if not exists payment_refunds_payment_idx
  on executive_visuals.payment_refunds(payment_transaction_id, created_at desc);
create index if not exists payment_refunds_owner_idx
  on executive_visuals.payment_refunds(owner_id, created_at desc);

alter table executive_visuals.credit_ledger
  add constraint credit_ledger_refund_fk
  foreign key (refund_id) references executive_visuals.payment_refunds(id) on delete restrict;

create table if not exists executive_visuals.chargeback_cases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  payment_transaction_id uuid references executive_visuals.payment_transactions(id) on delete restrict,
  provider text not null default 'flutterwave' check (provider in ('flutterwave')),
  provider_case_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null,
  status text not null check (status in ('open','under_review','accepted','won','lost','closed')),
  stage text,
  response_due_at timestamptz,
  outcome_at timestamptz,
  provider_reference text,
  provider_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_case_id)
);
create index if not exists chargeback_cases_owner_due_idx
  on executive_visuals.chargeback_cases(owner_id, response_due_at) where status in ('open','under_review');
create index if not exists chargeback_cases_status_idx
  on executive_visuals.chargeback_cases(status, response_due_at);

create table if not exists executive_visuals.chargeback_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  case_id uuid not null references executive_visuals.chargeback_cases(id) on delete restrict,
  evidence_type text not null check (evidence_type in ('invoice','delivery_proof','communication','terms','usage_log','identity_consent','other')),
  storage_bucket text not null default 'executive-visuals-media',
  object_path text not null,
  file_name text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  notes text not null default '',
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(case_id, object_path)
);
create index if not exists chargeback_evidence_case_idx
  on executive_visuals.chargeback_evidence(case_id, created_at);

create table if not exists executive_visuals.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  payment_transaction_id uuid not null unique references executive_visuals.payment_transactions(id) on delete restrict,
  invoice_number text not null unique,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0),
  issued_at timestamptz not null default now(),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  pdf_bucket text,
  pdf_object_path text,
  created_at timestamptz not null default now()
);
create index if not exists billing_invoices_owner_issued_idx
  on executive_visuals.billing_invoices(owner_id, issued_at desc);

create table if not exists executive_visuals.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  payment_transaction_id uuid references executive_visuals.payment_transactions(id) on delete set null,
  tx_ref text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('failed','retry_scheduled','succeeded','cancelled','exhausted')),
  failure_code text,
  failure_message text,
  attempt_number integer not null check (attempt_number between 1 and 10),
  next_retry_at timestamptz,
  last_notified_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, idempotency_key)
);
create index if not exists payment_attempts_retry_idx
  on executive_visuals.payment_attempts(next_retry_at) where status = 'retry_scheduled';
create index if not exists payment_attempts_owner_idx
  on executive_visuals.payment_attempts(owner_id, created_at desc);

create table if not exists executive_visuals.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('flutterwave')),
  event_key text not null,
  event_type text not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  signature_verified boolean not null,
  processing_status text not null default 'received' check (processing_status in ('received','processing','processed','ignored','failed')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, event_key)
);
create index if not exists payment_webhook_events_status_idx
  on executive_visuals.payment_webhook_events(processing_status, received_at);

create table if not exists executive_visuals.payment_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('flutterwave')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running','completed','failed')),
  checked_count integer not null default 0 check (checked_count >= 0),
  matched_count integer not null default 0 check (matched_count >= 0),
  exception_count integer not null default 0 check (exception_count >= 0),
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report) = 'object')
);

create table if not exists executive_visuals.billing_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null,
  dedupe_key text not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists billing_notification_outbox_queue_idx
  on executive_visuals.billing_notification_outbox(status, available_at);

-- Provider callbacks and credit mutations are server-only. Customer-facing
-- rows are read-only through RLS; writes use the isolated service-role backend.
alter table executive_visuals.platform_admins enable row level security;
alter table executive_visuals.payment_transactions enable row level security;
alter table executive_visuals.credit_ledger enable row level security;
alter table executive_visuals.payment_refunds enable row level security;
alter table executive_visuals.chargeback_cases enable row level security;
alter table executive_visuals.chargeback_evidence enable row level security;
alter table executive_visuals.billing_invoices enable row level security;
alter table executive_visuals.payment_attempts enable row level security;
alter table executive_visuals.payment_webhook_events enable row level security;
alter table executive_visuals.payment_reconciliation_runs enable row level security;
alter table executive_visuals.billing_notification_outbox enable row level security;

revoke all on executive_visuals.platform_admins,
  executive_visuals.payment_transactions,
  executive_visuals.credit_ledger,
  executive_visuals.payment_refunds,
  executive_visuals.chargeback_cases,
  executive_visuals.chargeback_evidence,
  executive_visuals.billing_invoices,
  executive_visuals.payment_attempts,
  executive_visuals.payment_webhook_events,
  executive_visuals.payment_reconciliation_runs,
  executive_visuals.billing_notification_outbox from anon, authenticated;

grant select on executive_visuals.payment_transactions,
  executive_visuals.credit_ledger,
  executive_visuals.payment_refunds,
  executive_visuals.chargeback_cases,
  executive_visuals.chargeback_evidence,
  executive_visuals.billing_invoices,
  executive_visuals.payment_attempts to authenticated;

create policy ev_payment_transactions_read on executive_visuals.payment_transactions
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_credit_ledger_read on executive_visuals.credit_ledger
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_payment_refunds_read on executive_visuals.payment_refunds
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_chargeback_cases_read on executive_visuals.chargeback_cases
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_chargeback_evidence_read on executive_visuals.chargeback_evidence
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_billing_invoices_read on executive_visuals.billing_invoices
  for select to authenticated using (owner_id = (select auth.uid()));
create policy ev_payment_attempts_read on executive_visuals.payment_attempts
  for select to authenticated using (owner_id = (select auth.uid()));

grant all privileges on executive_visuals.platform_admins,
  executive_visuals.payment_transactions,
  executive_visuals.credit_ledger,
  executive_visuals.payment_refunds,
  executive_visuals.chargeback_cases,
  executive_visuals.chargeback_evidence,
  executive_visuals.billing_invoices,
  executive_visuals.payment_attempts,
  executive_visuals.payment_webhook_events,
  executive_visuals.payment_reconciliation_runs,
  executive_visuals.billing_notification_outbox to service_role;
