-- Pitchside Coaching AI database. Paste into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- One row per account: plan and billing state. Only the server (service-role key) writes it.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free' check (plan in ('free', 'pro', 'premium')),
  billing_interval text check (billing_interval in ('month', 'year')),
  subscription_status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  player_profile jsonb,           -- (not used any more; kept so older databases still match)
  plan_changed_at timestamptz,    -- a plan change starts a fresh usage allowance
  created_at timestamptz not null default now()
);
-- Databases created before plan_changed_at existed:
alter table public.profiles add column if not exists plan_changed_at timestamptz;

-- Every AI question / plan, for the daily and weekly limits.
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('question', 'plan')),
  created_at timestamptz not null default now()
);
create index if not exists usage_events_lookup on public.usage_events (user_id, kind, created_at);

-- Saved training plans (Pro and Premium).
create table if not exists public.saved_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  answers jsonb not null,
  plan jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists saved_plans_by_user on public.saved_plans (user_id, created_at desc);

-- Row-level security: players can read their own rows; nobody can write from the browser.
alter table public.profiles enable row level security;
alter table public.usage_events enable row level security;
alter table public.saved_plans enable row level security;

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Read own plans" on public.saved_plans;
create policy "Read own plans" on public.saved_plans for select using (auth.uid() = user_id);

-- Create a Free profile automatically when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
