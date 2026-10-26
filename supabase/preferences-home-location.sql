alter table public.user_preferences
  add column if not exists home_location_type text not null default 'none',
  add column if not exists home_address text not null default '';

update public.user_preferences
set home_location_type = 'zip'
where home_location_type = 'none' and home_zip ~ '^[0-9]{5}$';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_preferences_home_location_type_check'
      and conrelid = 'public.user_preferences'::regclass
  ) then
    alter table public.user_preferences
      add constraint user_preferences_home_location_type_check
      check (home_location_type in ('address', 'zip', 'none'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_preferences_home_address_length_check'
      and conrelid = 'public.user_preferences'::regclass
  ) then
    alter table public.user_preferences
      add constraint user_preferences_home_address_length_check
      check (length(home_address) <= 300);
  end if;
end $$;
