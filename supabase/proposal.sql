-- REVIEWABLE PROPOSAL ONLY. Not a migration; never executed by the build or site.
-- Tracker window copied from data.json. Do not expose versus_private in the Data API.
begin;
create schema versus_private;
revoke all on schema versus_private from public, anon, authenticated;
grant usage on schema versus_private to authenticated;

-- The only application table. A vote is one immutable row, never a visitor-supplied counter.
create table versus_private.votes (
  vote_day date not null default (statement_timestamp() at time zone 'America/Los_Angeles')::date,
  voter_id uuid not null default auth.uid(),
  team text not null check (team in ('dots', 'bots')),
  created_at timestamptz not null default statement_timestamp(),
  primary key (vote_day, voter_id),
  check (vote_day between date '2026-10-05' and date '2026-11-01')
);
alter table versus_private.votes enable row level security;
revoke all on versus_private.votes from public, anon, authenticated;
grant select on versus_private.votes to authenticated;
grant insert (voter_id, team) on versus_private.votes to authenticated;
create policy own_vote_read on versus_private.votes for select to authenticated
  using (voter_id = (select auth.uid()));
create policy own_vote_today on versus_private.votes for insert to authenticated
  with check (voter_id = (select auth.uid()) and auth.uid() is not null
    and vote_day = (statement_timestamp() at time zone 'America/Los_Angeles')::date);
-- No UPDATE/DELETE grants or policies. The table is unexposed and INSERT cannot set day/time.

-- Intentionally privileged aggregate-only read; it cannot take a date/identity/query argument.
-- Bypasses own-row RLS solely to count teams. Never returns another visitor's row or identity.
create function versus_private.results()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (statement_timestamp() at time zone 'America/Los_Angeles')::date;
  v_dots bigint;
  v_bots bigint;
  v_choice text;
begin
  if v_uid is null then raise exception 'Anonymous sign-in required' using errcode = '42501'; end if;
  -- One SELECT keeps totals and own choice on the same snapshot during concurrent votes.
  select count(*) filter (where team = 'dots'), count(*) filter (where team = 'bots'),
    max(team) filter (where voter_id = v_uid)
    into v_dots, v_bots, v_choice from versus_private.votes where vote_day = v_day;
  return pg_catalog.jsonb_build_object('day', v_day, 'open', v_day between date '2026-10-05' and date '2026-11-01',
    'dotsVotes', v_dots, 'botsVotes', v_bots, 'totalVotes', v_dots + v_bots, 'yourVote', v_choice);
end;
$$;
revoke all on function versus_private.results() from public, anon, authenticated;
grant execute on function versus_private.results() to authenticated;

create function public.versus_results()
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select versus_private.results();
$$;
revoke all on function public.versus_results() from public, anon, authenticated;
grant execute on function public.versus_results() to authenticated;

create function public.cast_versus_vote(p_team text, p_expected_day date)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (statement_timestamp() at time zone 'America/Los_Angeles')::date;
  v_inserted integer;
begin
  if v_uid is null then raise exception 'Anonymous sign-in required' using errcode = '42501'; end if;
  if p_team is null or p_team not in ('dots', 'bots') then
    raise exception 'Invalid team' using errcode = '22023';
  end if;
  if p_expected_day is null or p_expected_day <> v_day then
    raise exception 'Pacific day changed; refresh before voting' using errcode = '22023';
  end if;
  if v_day not between date '2026-10-05' and date '2026-11-01' then
    raise exception 'This tracker poll is closed' using errcode = 'P0001';
  end if;
  -- The unique key arbitrates concurrent requests. Conflicts keep the original team.
  insert into versus_private.votes (voter_id, team) values (v_uid, p_team)
    on conflict (vote_day, voter_id) do nothing;
  get diagnostics v_inserted = row_count;
  return versus_private.results() || pg_catalog.jsonb_build_object('accepted', v_inserted = 1);
end;
$$;
revoke all on function public.cast_versus_vote(text, date) from public, anon, authenticated;
grant execute on function public.cast_versus_vote(text, date) to authenticated;
commit;
