-- Skill-eval harness: owner suites, pinned trials, immutable publications.
-- No seed rows. Sample records stay in the app fixture.

create table public.suites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.suites (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  prompt text not null check (char_length(btrim(prompt)) between 1 and 8000),
  unique (suite_id, slug)
);

create table public.trials (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.suites (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  harness text not null check (harness in ('claude-code', 'codex')),
  condition text not null check (condition in ('baseline', 'skill', 'agents', 'claude')),
  seed integer not null check (seed >= 0),
  passed boolean not null,
  instruction_loaded boolean,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  cli_version text not null check (char_length(btrim(cli_version)) between 1 and 200),
  model_id text not null check (char_length(btrim(model_id)) between 1 and 200),
  artifact_sha256 text not null,
  grader_id text not null check (char_length(btrim(grader_id)) between 1 and 200),
  grader_sha256 text not null check (grader_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  unique (suite_id, task_id, harness, condition, seed),
  constraint trials_loaded_matches_condition check (
    (condition = 'baseline' and instruction_loaded is null)
    or (condition <> 'baseline' and instruction_loaded is not null)
  ),
  constraint trials_artifact_pin check (
    (condition = 'baseline' and artifact_sha256 = 'none')
    or (condition <> 'baseline' and artifact_sha256 ~ '^[0-9a-f]{64}$')
  )
);

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.suites (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  is_public boolean not null default false,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  trial_ids uuid[] not null,
  created_at timestamptz not null default now()
);

create index suites_owner_idx on public.suites (owner_id);
create index tasks_suite_idx on public.tasks (suite_id);
create index trials_suite_idx on public.trials (suite_id);
create index trials_owner_idx on public.trials (owner_id);
create index publications_owner_idx on public.publications (owner_id);
create index publications_public_idx on public.publications (id) where is_public;

create or replace function public.enforce_trial_shape()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  suite_owner uuid;
  task_suite uuid;
begin
  select s.owner_id into suite_owner from public.suites as s where s.id = new.suite_id;
  if suite_owner is null or suite_owner <> new.owner_id then
    raise exception 'trial owner must own the suite';
  end if;
  select t.suite_id into task_suite from public.tasks as t where t.id = new.task_id;
  if task_suite is distinct from new.suite_id then
    raise exception 'task does not belong to the suite';
  end if;
  return new;
end;
$$;

create trigger trials_enforce_shape
  before insert or update on public.trials
  for each row execute function public.enforce_trial_shape();

create or replace function public.enforce_publication_shape()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  suite_owner uuid;
  foreign_count integer;
begin
  if tg_op = 'UPDATE' then
    raise exception 'publications are immutable';
  end if;
  select s.owner_id into suite_owner from public.suites as s where s.id = new.suite_id;
  if suite_owner is null or suite_owner <> new.owner_id then
    raise exception 'publication owner must own the suite';
  end if;
  if coalesce(array_length(new.trial_ids, 1), 0) < 1 or coalesce(array_length(new.trial_ids, 1), 0) > 2000 then
    raise exception 'a publication needs between 1 and 2000 trials';
  end if;
  select count(*) into foreign_count
  from unnest(new.trial_ids) as trial_id
  where not exists (
    select 1 from public.trials as tr
    where tr.id = trial_id and tr.suite_id = new.suite_id and tr.owner_id = new.owner_id
  );
  if foreign_count > 0 then
    raise exception 'publication trials must belong to the suite owner';
  end if;
  return new;
end;
$$;

create trigger publications_enforce_shape
  before insert or update on public.publications
  for each row execute function public.enforce_publication_shape();

create or replace function public.import_suite(payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_suite_id uuid;
  task_row jsonb;
  trial_row jsonb;
  task_count integer;
  trial_count integer;
  task_slug text;
  new_task_id uuid;
  loaded boolean;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload must be a JSON object';
  end if;
  if char_length(btrim(coalesce(payload->>'name', ''))) not between 1 and 160 then
    raise exception 'suite name is required';
  end if;

  task_count := coalesce(jsonb_array_length(payload->'tasks'), 0);
  trial_count := coalesce(jsonb_array_length(payload->'trials'), 0);
  if task_count < 1 then
    raise exception 'at least one task is required';
  end if;
  if trial_count < 1 or trial_count > 2000 then
    raise exception 'trial count must be from 1 to 2000';
  end if;

  insert into public.suites (owner_id, name, description)
  values (auth.uid(), btrim(payload->>'name'), coalesce(payload->>'description', ''))
  returning id into new_suite_id;

  for task_row in select value from jsonb_array_elements(payload->'tasks')
  loop
    task_slug := task_row->>'slug';
    insert into public.tasks (suite_id, slug, title, prompt)
    values (
      new_suite_id,
      task_slug,
      coalesce(nullif(btrim(task_row->>'title'), ''), task_slug),
      coalesce(task_row->>'prompt', '')
    );
  end loop;

  for trial_row in select value from jsonb_array_elements(payload->'trials')
  loop
    task_slug := trial_row->>'task_slug';
    select t.id into new_task_id
    from public.tasks as t
    where t.suite_id = new_suite_id and t.slug = task_slug;
    if new_task_id is null then
      raise exception 'trial task_slug % is not in this suite', task_slug;
    end if;
    if trial_row->>'instruction_loaded' is null then
      loaded := null;
    else
      loaded := (trial_row->>'instruction_loaded')::boolean;
    end if;
    insert into public.trials (
      suite_id, task_id, owner_id, harness, condition, seed, passed,
      instruction_loaded, input_tokens, output_tokens, cost_usd,
      cli_version, model_id, artifact_sha256, grader_id, grader_sha256
    ) values (
      new_suite_id,
      new_task_id,
      auth.uid(),
      trial_row->>'harness',
      trial_row->>'condition',
      (trial_row->>'seed')::integer,
      (trial_row->>'passed')::boolean,
      loaded,
      (trial_row->>'input_tokens')::integer,
      (trial_row->>'output_tokens')::integer,
      (trial_row->>'cost_usd')::numeric,
      trial_row->>'cli_version',
      trial_row->>'model_id',
      trial_row->>'artifact_sha256',
      trial_row->>'grader_id',
      trial_row->>'grader_sha256'
    );
  end loop;

  return new_suite_id;
end;
$$;

revoke all on function public.import_suite(jsonb) from public, anon;
grant execute on function public.import_suite(jsonb) to authenticated;

alter table public.suites enable row level security;
alter table public.tasks enable row level security;
alter table public.trials enable row level security;
alter table public.publications enable row level security;

alter table public.suites force row level security;
alter table public.tasks force row level security;
alter table public.trials force row level security;
alter table public.publications force row level security;

create policy suites_owner_all on public.suites
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy tasks_owner_all on public.tasks
  for all to authenticated
  using (
    exists (
      select 1 from public.suites as s
      where s.id = suite_id and s.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.suites as s
      where s.id = suite_id and s.owner_id = auth.uid()
    )
  );

create policy trials_owner_all on public.trials
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy publications_owner_select on public.publications
  for select to authenticated
  using (owner_id = auth.uid() or is_public);

create policy publications_public_select on public.publications
  for select to anon
  using (is_public);

-- No insert, update, or delete policy on publications.
-- publish-run inserts with the service role after it checks the user JWT and suite owner.
-- The service role bypasses RLS, including FORCE ROW LEVEL SECURITY. The handler must keep that check.
