-- =============================================================================
-- 0100 — Core schema: enums, tables, constraints, indexes, timestamps.
-- Access control lives in 0200 (helpers) and 0300 (RLS policies).
-- Business rules (history, audit, guards) live in 0400.
-- =============================================================================

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('company_admin', 'sales_manager', 'sales_agent', 'cs_agent');
create type public.lead_status as enum ('new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost');
create type public.lead_source as enum ('website', 'whatsapp', 'phone', 'referral', 'walk_in', 'social_media', 'campaign', 'event', 'import', 'other');
create type public.priority_level as enum ('low', 'medium', 'high', 'urgent');
create type public.pipeline_kind as enum ('lead', 'deal');
create type public.stage_type as enum ('open', 'won', 'lost');
create type public.deal_status as enum ('open', 'won', 'lost');
create type public.task_status as enum ('open', 'in_progress', 'completed', 'canceled');
create type public.activity_type as enum ('call', 'meeting', 'note', 'email', 'whatsapp', 'other');
create type public.contact_relationship as enum ('prospect', 'customer', 'partner', 'other');
create type public.target_metric as enum ('won_revenue', 'deals_won', 'leads_created', 'leads_contacted', 'calls_logged', 'meetings_logged', 'tasks_completed');
create type public.wa_account_status as enum ('pending_setup', 'test', 'active', 'disabled');
create type public.conversation_status as enum ('open', 'pending', 'resolved');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_status as enum ('received', 'queued', 'sent', 'delivered', 'read', 'failed');

-- -----------------------------------------------------------------------------
-- Generic updated_at trigger
-- -----------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Companies, profiles, memberships, teams
-- -----------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  timezone text not null default 'UTC',
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (length(full_name) <= 200),
  email text,
  phone text,
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  is_super_admin boolean not null default false,
  is_active boolean not null default true,
  deactivated_at timestamptz,
  deactivated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.companies
  add constraint companies_created_by_fkey foreign key (created_by) references public.profiles (id) on delete set null;

create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.app_role not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index company_memberships_user_idx on public.company_memberships (user_id) where is_active;

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  manager_id uuid references public.profiles (id) on delete set null,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id)
);
create index teams_manager_idx on public.teams (manager_id) where is_active;

create table public.team_memberships (
  team_id uuid not null,
  company_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (team_id, company_id) references public.teams (id, company_id) on delete cascade
);
create index team_memberships_user_idx on public.team_memberships (user_id);

-- -----------------------------------------------------------------------------
-- Contacts: one canonical identity + explicit per-company relationships.
-- Company-specific business data never lives on `contacts`.
-- -----------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(btrim(full_name)) between 1 and 200),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  merged_into_id uuid references public.contacts (id) on delete restrict,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (merged_into_id is null or merged_into_id <> id)
);
-- An E.164 number identifies at most one active canonical contact.
create unique index contacts_phone_active_uidx on public.contacts (phone_e164)
  where merged_into_id is null and phone_e164 is not null;
create index contacts_email_idx on public.contacts (lower(email)) where email is not null;
create index contacts_name_idx on public.contacts (lower(full_name));

create table public.contact_companies (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  relationship public.contact_relationship not null default 'prospect',
  owner_id uuid references public.profiles (id) on delete set null,
  notes text check (notes is null or length(notes) <= 5000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, company_id)
);
create index contact_companies_company_idx on public.contact_companies (company_id);

-- Ambiguous potential duplicates are queued for human review, never auto-merged.
create table public.contact_duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  contact_a_id uuid not null references public.contacts (id) on delete cascade,
  contact_b_id uuid not null references public.contacts (id) on delete cascade,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'merged', 'dismissed')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (contact_a_id < contact_b_id),
  unique (contact_a_id, contact_b_id)
);

-- -----------------------------------------------------------------------------
-- Pipelines
-- -----------------------------------------------------------------------------
create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind public.pipeline_kind not null default 'deal',
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, kind, name)
);
create unique index pipelines_one_default_uidx on public.pipelines (company_id, kind) where is_default;

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null,
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  position int not null check (position >= 0),
  stage_type public.stage_type not null default 'open',
  probability int check (probability between 0 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (pipeline_id, company_id) references public.pipelines (id, company_id) on delete cascade,
  unique (pipeline_id, position) deferrable initially deferred,
  unique (id, pipeline_id)
);

-- -----------------------------------------------------------------------------
-- Leads
-- -----------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  source public.lead_source not null default 'other',
  campaign text check (campaign is null or length(campaign) <= 200),
  referral_source text check (referral_source is null or length(referral_source) <= 200),
  status public.lead_status not null default 'new',
  priority public.priority_level not null default 'medium',
  stage_id uuid references public.pipeline_stages (id) on delete set null,
  estimated_value numeric(14, 2) check (estimated_value is null or estimated_value >= 0),
  owner_id uuid references public.profiles (id) on delete set null,
  team_id uuid,
  created_by uuid not null references public.profiles (id) on delete restrict,
  last_activity_at timestamptz,
  first_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  notes text check (notes is null or length(notes) <= 10000),
  qualification jsonb not null default '{}'::jsonb check (jsonb_typeof(qualification) = 'object'),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (team_id, company_id) references public.teams (id, company_id)
);
create index leads_company_status_idx on public.leads (company_id, status) where archived_at is null;
create index leads_owner_idx on public.leads (owner_id) where archived_at is null;
create index leads_team_idx on public.leads (team_id) where archived_at is null;
create index leads_contact_idx on public.leads (contact_id);
create index leads_created_by_idx on public.leads (created_by, created_at);
create index leads_company_created_idx on public.leads (company_id, created_at);
create index leads_follow_up_idx on public.leads (next_follow_up_at) where archived_at is null;
create index leads_title_idx on public.leads (lower(title));

create table public.lead_assignments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  company_id uuid not null,
  from_user_id uuid references public.profiles (id) on delete set null,
  to_user_id uuid references public.profiles (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  assigned_by uuid references public.profiles (id) on delete set null,
  reason text check (reason is null or length(reason) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (lead_id, company_id) references public.leads (id, company_id) on delete cascade
);
create index lead_assignments_lead_idx on public.lead_assignments (lead_id, created_at);
create index lead_assignments_to_idx on public.lead_assignments (to_user_id, created_at);

create table public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  company_id uuid not null,
  from_status public.lead_status,
  to_status public.lead_status not null,
  changed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (lead_id, company_id) references public.leads (id, company_id) on delete cascade
);
create index lead_status_history_lead_idx on public.lead_status_history (lead_id, created_at);
create index lead_status_history_company_idx on public.lead_status_history (company_id, to_status, created_at);

-- -----------------------------------------------------------------------------
-- Deals
-- -----------------------------------------------------------------------------
create table public.deals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  lead_id uuid,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  pipeline_id uuid not null,
  stage_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  probability int check (probability between 0 and 100),
  expected_close_date date,
  status public.deal_status not null default 'open',
  won_at timestamptz,
  lost_at timestamptz,
  loss_reason text check (loss_reason is null or length(loss_reason) <= 1000),
  closed_by uuid references public.profiles (id) on delete set null,
  owner_id uuid references public.profiles (id) on delete set null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  notes text check (notes is null or length(notes) <= 10000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (lead_id, company_id) references public.leads (id, company_id),
  foreign key (pipeline_id, company_id) references public.pipelines (id, company_id),
  foreign key (stage_id, pipeline_id) references public.pipeline_stages (id, pipeline_id),
  -- Outcome timestamps must agree with status.
  check ((status = 'won') = (won_at is not null)),
  check ((status = 'lost') = (lost_at is not null)),
  check (status <> 'lost' or loss_reason is not null)
);
create index deals_company_status_idx on public.deals (company_id, status) where archived_at is null;
create index deals_owner_idx on public.deals (owner_id) where archived_at is null;
create index deals_won_idx on public.deals (company_id, won_at) where status = 'won';
create index deals_lost_idx on public.deals (company_id, lost_at) where status = 'lost';
create index deals_lead_idx on public.deals (lead_id);
create index deals_contact_idx on public.deals (contact_id);
create index deals_stage_idx on public.deals (stage_id);

create table public.deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  company_id uuid not null,
  from_stage_id uuid references public.pipeline_stages (id) on delete set null,
  to_stage_id uuid references public.pipeline_stages (id) on delete set null,
  from_status public.deal_status,
  to_status public.deal_status not null,
  changed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (deal_id, company_id) references public.deals (id, company_id) on delete cascade
);
create index deal_stage_history_deal_idx on public.deal_stage_history (deal_id, created_at);

-- -----------------------------------------------------------------------------
-- Tasks and activities
-- -----------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (description is null or length(description) <= 5000),
  contact_id uuid references public.contacts (id) on delete set null,
  lead_id uuid,
  deal_id uuid,
  assigned_to uuid references public.profiles (id) on delete set null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  due_at timestamptz,
  priority public.priority_level not null default 'medium',
  status public.task_status not null default 'open',
  completed_at timestamptz,
  completed_by uuid references public.profiles (id) on delete set null,
  canceled_at timestamptz,
  outcome text check (outcome is null or length(outcome) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (lead_id, company_id) references public.leads (id, company_id) on delete cascade,
  foreign key (deal_id, company_id) references public.deals (id, company_id) on delete cascade,
  check ((status = 'completed') = (completed_at is not null)),
  check (status <> 'completed' or completed_by is not null),
  check ((status = 'canceled') = (canceled_at is not null))
);
create index tasks_assignee_idx on public.tasks (assigned_to, status, due_at);
create index tasks_company_due_idx on public.tasks (company_id, due_at) where status in ('open', 'in_progress');
create index tasks_completed_idx on public.tasks (company_id, completed_at) where status = 'completed';
create index tasks_lead_idx on public.tasks (lead_id);
create index tasks_deal_idx on public.tasks (deal_id);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  type public.activity_type not null,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  contact_id uuid references public.contacts (id) on delete set null,
  lead_id uuid,
  deal_id uuid,
  occurred_at timestamptz not null default now(),
  duration_seconds int check (duration_seconds is null or duration_seconds between 0 and 86400),
  outcome text check (outcome is null or length(outcome) <= 200),
  body text check (body is null or length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (lead_id, company_id) references public.leads (id, company_id) on delete cascade,
  foreign key (deal_id, company_id) references public.deals (id, company_id) on delete cascade
);
create index activities_actor_idx on public.activities (actor_id, occurred_at);
create index activities_company_idx on public.activities (company_id, type, occurred_at);
create index activities_lead_idx on public.activities (lead_id, occurred_at);
create index activities_deal_idx on public.activities (deal_id, occurred_at);
create index activities_contact_idx on public.activities (contact_id, occurred_at);

-- -----------------------------------------------------------------------------
-- Sales targets
-- -----------------------------------------------------------------------------
create table public.sales_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  team_id uuid,
  metric public.target_metric not null,
  period_start date not null,
  period_end date not null,
  target_value numeric(14, 2) not null check (target_value > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, company_id) references public.teams (id, company_id) on delete cascade,
  check (period_end >= period_start),
  check (user_id is null or team_id is null)
);
create unique index sales_targets_scope_uidx on public.sales_targets
  (company_id, metric, period_start, period_end,
   coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- -----------------------------------------------------------------------------
-- WhatsApp
-- -----------------------------------------------------------------------------
create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  default_company_id uuid not null references public.companies (id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_number_id text unique,         -- Meta phone number ID (not secret)
  waba_id text,                        -- Meta WhatsApp Business Account ID (not secret)
  status public.wa_account_status not null default 'pending_setup',
  is_simulated boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Explicit per-user access to each WhatsApp number.
create table public.whatsapp_account_access (
  whatsapp_account_id uuid not null references public.whatsapp_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  can_reply boolean not null default true,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (whatsapp_account_id, user_id)
);
create index whatsapp_account_access_user_idx on public.whatsapp_account_access (user_id);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  whatsapp_account_id uuid not null references public.whatsapp_accounts (id) on delete restrict,
  company_id uuid not null references public.companies (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  customer_wa_id text not null,        -- the customer's WhatsApp ID (digits) as sent by Meta
  status public.conversation_status not null default 'open',
  owner_id uuid references public.profiles (id) on delete set null,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  unread_count int not null default 0 check (unread_count >= 0),
  is_simulated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (whatsapp_account_id, customer_wa_id),
  unique (id, company_id)
);
create index conversations_account_idx on public.conversations (whatsapp_account_id, last_message_at desc);
create index conversations_owner_idx on public.conversations (owner_id, status);
create index conversations_company_idx on public.conversations (company_id, status, last_message_at desc);
create index conversations_contact_idx on public.conversations (contact_id);

create table public.conversation_assignments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  from_user_id uuid references public.profiles (id) on delete set null,
  to_user_id uuid references public.profiles (id) on delete set null,
  assigned_by uuid references public.profiles (id) on delete set null,
  reason text check (reason is null or length(reason) <= 1000),
  created_at timestamptz not null default now()
);
create index conversation_assignments_conv_idx on public.conversation_assignments (conversation_id, created_at);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction public.message_direction not null,
  wa_message_id text unique,           -- Meta message ID; uniqueness = webhook dedup
  message_type text not null default 'text' check (length(message_type) <= 40),
  body text check (body is null or length(body) <= 4096),
  media jsonb,
  status public.message_status not null,
  error_code text,
  error_message text check (error_message is null or length(error_message) <= 1000),
  sent_by uuid references public.profiles (id) on delete set null,  -- authenticated sender, outbound only
  client_request_id uuid unique,       -- idempotency key for outbound sends
  sent_at timestamptz not null default now(),   -- WhatsApp timestamp (inbound) or queue time (outbound)
  status_updated_at timestamptz,
  is_simulated boolean not null default false,
  created_at timestamptz not null default now(),
  check (direction = 'outbound' or sent_by is null),
  check ((direction = 'inbound') = (status = 'received'))
);
create index messages_conversation_idx on public.messages (conversation_id, sent_at);
create index messages_sender_idx on public.messages (sent_by, sent_at) where direction = 'outbound';

-- Internal notes are stored separately so they can never be sent to a customer.
create table public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete restrict,
  body text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index conversation_notes_conv_idx on public.conversation_notes (conversation_id, created_at);

-- Raw webhook intake: dedup + retry bookkeeping. Service role only.
create table public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_kind text not null check (event_kind in ('message', 'status', 'other')),
  phone_number_id text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processed', 'failed', 'ignored')),
  attempts int not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index whatsapp_webhook_events_status_idx on public.whatsapp_webhook_events (status, received_at);

-- -----------------------------------------------------------------------------
-- Notifications, audit, attachments, auth events
-- -----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  type text not null check (length(type) <= 60),
  title text not null check (length(title) <= 200),
  body text check (body is null or length(body) <= 1000),
  entity_type text,
  entity_id uuid,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create unique index notifications_dedupe_uidx on public.notifications (user_id, dedupe_key) where dedupe_key is not null;

create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid references public.companies (id) on delete set null,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (length(action) <= 80),
  entity_type text not null check (length(entity_type) <= 60),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_company_idx on public.audit_logs (company_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  entity_type text not null check (entity_type in ('lead', 'deal', 'contact', 'task', 'conversation')),
  entity_id uuid not null,
  storage_path text not null unique,
  file_name text not null check (length(file_name) <= 255),
  mime_type text not null check (length(mime_type) <= 120),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);

-- Login / logout events recorded by the application. Distinct from working time.
create table public.auth_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  event text not null check (event in ('sign_in', 'sign_out', 'password_reset_requested', 'password_changed')),
  created_at timestamptz not null default now()
);
create index auth_events_user_idx on public.auth_events (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'companies', 'profiles', 'company_memberships', 'teams', 'contacts', 'contact_companies',
    'pipelines', 'pipeline_stages', 'leads', 'deals', 'tasks', 'activities', 'sales_targets',
    'whatsapp_accounts', 'conversations'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
  end loop;
end $$;
