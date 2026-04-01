create table if not exists public.account_states (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.account_states enable row level security;

create policy "Users can read their own account state"
on public.account_states
for select
using (auth.uid() = user_id);

create policy "Users can insert their own account state"
on public.account_states
for insert
with check (auth.uid() = user_id);

create policy "Users can update their own account state"
on public.account_states
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
