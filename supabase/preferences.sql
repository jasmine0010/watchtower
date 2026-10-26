begin;

create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  home_location_type text not null default 'none'
    check (home_location_type in ('address', 'zip', 'none')),
  home_address text not null default '' check (length(home_address) <= 300),
  home_zip text not null default '' check (home_zip = '' or home_zip ~ '^[0-9]{5}$'),
  needs text[] not null default '{}' check (
    needs <@ array['extra-time', 'smoke-sensitive', 'pets', 'medical-power', 'shelter']::text[]
  )
);

alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from anon;
grant select, insert, update, delete on public.user_preferences to authenticated;

create policy "Read own preferences" on public.user_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Insert own preferences" on public.user_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own preferences" on public.user_preferences
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Delete own preferences" on public.user_preferences
  for delete to authenticated using ((select auth.uid()) = user_id);

commit;
