-- Coaching: a coach's clients, their plans (read from uploaded PDFs), their
-- uploaded rides, and the plan changes those rides motivate.
--
-- Every table is owned by a coach (auth.users) and gated by RLS on that
-- ownership. Client data is never shared between coaches.

create table if not exists clients (
  id             uuid        primary key default gen_random_uuid(),
  coach_id       uuid        not null references auth.users(id) on delete cascade,
  name           text        not null,
  email          text,
  ftp            integer,
  hr_max         integer,
  weight_kg      numeric(5,2),
  goal_event     text,
  goal_date      date,
  weekly_hours   numeric(4,1),
  training_phase text,
  notes          text,
  archived       boolean     not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists clients_coach on clients (coach_id, archived, name);

-- A plan as uploaded. The PDF itself is not stored; `extracted` keeps the raw
-- extraction so a coach can see what was read out of it and re-review later.
create table if not exists training_plans (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references clients(id) on delete cascade,
  coach_id     uuid        not null references auth.users(id) on delete cascade,
  filename     text        not null,
  plan_name    text,
  start_date   date,
  weeks        integer,
  status       text        not null default 'active'
                           check (status in ('active', 'archived')),
  extracted    jsonb       not null,
  warnings     jsonb       not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists training_plans_client on training_plans (client_id, status, created_at desc);

create table if not exists plan_sessions (
  id            uuid        primary key default gen_random_uuid(),
  plan_id       uuid        not null references training_plans(id) on delete cascade,
  client_id     uuid        not null references clients(id) on delete cascade,
  coach_id      uuid        not null references auth.users(id) on delete cascade,
  week          integer     not null,
  day_of_week   integer     not null check (day_of_week between 1 and 7),
  session_date  date,
  title         text        not null,
  description   text,
  sport         text,
  duration_secs integer,
  target_load   integer,
  intensity     text        not null default 'unknown',
  source_text   text,
  created_at    timestamptz not null default now()
);

create index if not exists plan_sessions_client_date on plan_sessions (client_id, session_date);
create index if not exists plan_sessions_plan on plan_sessions (plan_id, week, day_of_week);

-- One row per uploaded .fit file: the computed ride analysis, the comparison
-- against the session it was meant to be, and the coaching feedback.
create table if not exists rides (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid        not null references clients(id) on delete cascade,
  coach_id        uuid        not null references auth.users(id) on delete cascade,
  plan_session_id uuid        references plan_sessions(id) on delete set null,
  filename        text        not null,
  ride_date       date,
  coach_note      text,
  summary         jsonb       not null,
  comparison      jsonb,
  feedback        jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists rides_client_date on rides (client_id, ride_date desc);

-- Proposed changes to upcoming sessions, confirmed by the coach before they
-- touch the plan. Applying one updates the plan_sessions row it points at.
create table if not exists plan_changes (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid        not null references clients(id) on delete cascade,
  coach_id        uuid        not null references auth.users(id) on delete cascade,
  ride_id         uuid        references rides(id) on delete cascade,
  plan_session_id uuid        not null references plan_sessions(id) on delete cascade,
  summary         text        not null,
  rationale       text,
  changes         jsonb       not null,
  status          text        not null default 'pending'
                              check (status in ('pending', 'applied', 'dismissed')),
  applied_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists plan_changes_client_status on plan_changes (client_id, status, created_at desc);

alter table clients        enable row level security;
alter table training_plans enable row level security;
alter table plan_sessions  enable row level security;
alter table rides          enable row level security;
alter table plan_changes   enable row level security;

drop policy if exists "Coaches manage own clients" on clients;
create policy "Coaches manage own clients" on clients
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

drop policy if exists "Coaches manage own plans" on training_plans;
create policy "Coaches manage own plans" on training_plans
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

drop policy if exists "Coaches manage own plan sessions" on plan_sessions;
create policy "Coaches manage own plan sessions" on plan_sessions
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

drop policy if exists "Coaches manage own rides" on rides;
create policy "Coaches manage own rides" on rides
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

drop policy if exists "Coaches manage own plan changes" on plan_changes;
create policy "Coaches manage own plan changes" on plan_changes
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);
