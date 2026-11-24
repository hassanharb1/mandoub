-- SalesGo by MESTK — cloud sync schema (Supabase)
-- Paste all of this once in: Supabase dashboard → SQL Editor → New query → Run.
-- One generic table: every customer, order, payment, handover, account line, request,
-- the settings and the rep's product changes are one row each, owned by the signed-in user.

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text        not null,              -- customers | orders | payments | handovers | adjusts | requests | settings | cat
  id         text        not null,              -- the app's own id
  data       jsonb,                             -- the record as the app keeps it (null once deleted)
  deleted    boolean     not null default false,-- deletes are kept as tombstones so other phones learn about them
  rev        bigint      not null,              -- when the phone changed it (ms); the newest change wins
  updated_at timestamptz not null default now(),-- when the server got it; phones pull "everything after X"
  primary key (user_id, kind, id)
);

create index if not exists records_pull on public.records (user_id, updated_at);

-- the server stamps the time, so a phone with a wrong clock can't hide changes from the others
create or replace function public.records_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  -- last write wins: an older change never overwrites a newer one
  if tg_op = 'UPDATE' and new.rev < old.rev then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

-- Row Level Security: each account sees and changes only its own rows
alter table public.records enable row level security;

drop policy if exists "own rows: read"   on public.records;
drop policy if exists "own rows: insert" on public.records;
drop policy if exists "own rows: update" on public.records;
create policy "own rows: read"   on public.records for select using (user_id = auth.uid());
create policy "own rows: insert" on public.records for insert with check (user_id = auth.uid());
create policy "own rows: update" on public.records for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- no delete policy on purpose: rows are never removed from a phone, only marked deleted

-- product photos the rep takes himself: a private bucket, one folder per account
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists "own photos: read"   on storage.objects;
drop policy if exists "own photos: write"  on storage.objects;
drop policy if exists "own photos: update" on storage.objects;
create policy "own photos: read"   on storage.objects for select
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos: write"  on storage.objects for insert
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos: update" on storage.objects for update
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
