-- Coaching chat: one thread per client, so the coach can question the analysis
-- and correct what the app got wrong (a plan start date read out of a PDF, a
-- client's FTP, a session that was never going to happen as written).
create table if not exists client_messages (
  id         uuid        primary key default gen_random_uuid(),
  client_id  uuid        not null references clients(id) on delete cascade,
  coach_id   uuid        not null references auth.users(id) on delete cascade,
  role       text        not null check (role in ('user', 'assistant')),
  content    text        not null,
  created_at timestamptz not null default now()
);

create index if not exists client_messages_thread on client_messages (client_id, created_at);

alter table client_messages enable row level security;

drop policy if exists "Coaches manage own client messages" on client_messages;
create policy "Coaches manage own client messages" on client_messages
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);
