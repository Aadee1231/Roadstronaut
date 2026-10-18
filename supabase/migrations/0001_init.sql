create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key,
  nickname text not null default 'NeonDriver',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint players_nickname_length check (char_length(nickname) between 3 and 16),
  constraint players_nickname_characters check (nickname ~ '^[A-Za-z0-9 _.-]{3,16}$')
);

create table if not exists public.runs (
  id uuid primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  seed bigint not null check (seed between 0 and 4294967295),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'started' check (status in ('started', 'used', 'rejected')),
  used_at timestamptz
);

create index if not exists runs_player_status_idx on public.runs(player_id, status);
create index if not exists runs_expires_at_idx on public.runs(expires_at);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.runs(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  score integer not null check (score >= 0),
  distance integer not null check (distance >= 0),
  flips integer not null check (flips >= 0),
  max_combo integer not null check (max_combo >= 0),
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists scores_score_desc_idx on public.scores(score desc);
create index if not exists scores_created_at_idx on public.scores(created_at);
create index if not exists scores_player_id_idx on public.scores(player_id);

create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null check (count >= 0),
  primary key (key, window_start)
);

create index if not exists rate_limits_window_start_idx on public.rate_limits(window_start);

create or replace function public.rate_limit_hit(
  p_key text,
  p_window_seconds integer,
  p_max integer,
  p_now timestamptz default now()
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_window_seconds < 1 or p_max < 1 then
    return false;
  end if;
  v_window := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits(key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

create or replace function public.leaderboard_data(
  p_since timestamptz,
  p_player_id uuid
) returns table (
  rank bigint,
  player_id uuid,
  nickname text,
  score integer,
  flips integer,
  created_at timestamptz,
  is_you boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with best_per_player as (
    select distinct on (s.player_id)
      s.player_id,
      p.nickname,
      s.score,
      s.flips,
      s.created_at
    from public.scores s
    join public.players p on p.id = s.player_id
    where p_since is null or s.created_at >= p_since
    order by s.player_id, s.score desc, s.created_at asc, s.run_id asc
  ),
  ranked as (
    select
      row_number() over (order by b.score desc, b.created_at asc, b.player_id) as player_rank,
      b.player_id,
      b.nickname,
      b.score,
      b.flips,
      b.created_at
    from best_per_player b
  )
  select
    r.player_rank,
    r.player_id,
    r.nickname,
    r.score,
    r.flips,
    r.created_at,
    r.player_id = p_player_id
  from ranked r
  where r.player_rank <= 50 or r.player_id = p_player_id
  order by r.player_rank;
$$;

create or replace function public.leaderboard_all(p_player_id uuid)
returns table (rank bigint, player_id uuid, nickname text, score integer, flips integer, created_at timestamptz, is_you boolean)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.leaderboard_data(null, p_player_id);
$$;

create or replace function public.leaderboard_week(p_player_id uuid)
returns table (rank bigint, player_id uuid, nickname text, score integer, flips integer, created_at timestamptz, is_you boolean)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.leaderboard_data(date_trunc('week', now() at time zone 'utc') at time zone 'utc', p_player_id);
$$;

create or replace function public.player_rank(p_player_id uuid, p_since timestamptz default null)
returns table (rank bigint, best integer)
language sql
stable
security definer
set search_path = public
as $$
  select board.rank, board.score
  from public.leaderboard_data(p_since, p_player_id) board
  where board.player_id = p_player_id;
$$;

alter table public.players enable row level security;
alter table public.runs enable row level security;
alter table public.scores enable row level security;
alter table public.rate_limits enable row level security;

revoke all on public.players, public.runs, public.scores, public.rate_limits from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.leaderboard_data(timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.leaderboard_all(uuid) from public, anon, authenticated;
revoke all on function public.leaderboard_week(uuid) from public, anon, authenticated;
revoke all on function public.player_rank(uuid, timestamptz) from public, anon, authenticated;
grant all on public.players, public.runs, public.scores, public.rate_limits to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer, timestamptz) to service_role;
grant execute on function public.leaderboard_data(timestamptz, uuid) to service_role;
grant execute on function public.leaderboard_all(uuid) to service_role;
grant execute on function public.leaderboard_week(uuid) to service_role;
grant execute on function public.player_rank(uuid, timestamptz) to service_role;

-- Periodically remove expired run tokens and old rate-limit buckets, for example:
-- delete from public.runs where expires_at < now() - interval '7 days';
-- delete from public.rate_limits where window_start < now() - interval '7 days';
