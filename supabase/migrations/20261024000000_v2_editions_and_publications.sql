-- s20.run.v2 persistence (PLAN.md §11). Ordered forward migration; 20261023190000 is preserved unchanged.
-- Not applied anywhere. Inspect the target's migration history before applying (no remote baseline is verified).
--
-- suite_editions        owner-scoped immutable normalized v2 full-run input (exact canonical text + digest)
-- publication_artifacts sanitized, immutable artifact bytes + recomputed summary (no owner identity)
-- publication_controls  private ownership/visibility/idempotency metadata (owner-only)
-- Public reads go only through get_public_publication(), which returns the sanitized columns.
-- Legacy suites/tasks/trials/publications stay for legacy data; v2 facts are never dual-written into trials.

create table public.suite_editions (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.suites (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  schema_version text not null check (schema_version = 's20.run.v2'),
  run_id text not null check (run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  experiment_digest text not null check (experiment_digest ~ '^[0-9a-f]{64}$'),
  records_edition_digest text not null check (records_edition_digest ~ '^[0-9a-f]{64}$'),
  -- Exact canonical JSON text of {spec, ledger, attempts}; its SHA-256 is records_edition_digest (verified by publish-run).
  content text not null check (octet_length(content) <= 8388608),
  created_at timestamptz not null default now(),
  unique (suite_id, records_edition_digest)
);

create table public.publication_artifacts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null check (schema_version = 's20.run.v2'),
  method_version text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  source_edition_digest text not null check (source_edition_digest ~ '^[0-9a-f]{64}$'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  -- Exact sanitized envelope bytes; the viewer re-verifies them against the embedded manifest.
  artifact text not null check (octet_length(artifact) <= 8388608),
  created_at timestamptz not null default now()
);

create table public.publication_controls (
  publication_id uuid primary key references public.publication_artifacts (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- No cascade from source deletion to copied publication bytes.
  suite_id uuid references public.suites (id) on delete set null,
  edition_id uuid references public.suite_editions (id) on delete set null,
  is_public boolean not null default false,
  revoked_at timestamptz,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index suite_editions_owner_idx on public.suite_editions (owner_id);
create index suite_editions_suite_idx on public.suite_editions (suite_id);
create index publication_controls_owner_idx on public.publication_controls (owner_id);

-- Immutability and parent-owner consistency.
create or replace function public.enforce_edition_shape()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  suite_owner uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'suite editions are immutable';
  end if;
  select s.owner_id into suite_owner from public.suites as s where s.id = new.suite_id;
  if suite_owner is null or suite_owner <> new.owner_id then
    raise exception 'edition owner must own the suite';
  end if;
  return new;
end;
$$;

create trigger suite_editions_enforce_shape
  before insert or update on public.suite_editions
  for each row execute function public.enforce_edition_shape();

create or replace function public.reject_artifact_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'publication artifacts are immutable';
end;
$$;

create trigger publication_artifacts_immutable
  before update on public.publication_artifacts
  for each row execute function public.reject_artifact_update();

create or replace function public.enforce_control_shape()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  suite_owner uuid;
  edition_owner uuid;
begin
  if tg_op = 'UPDATE' then
    if new.publication_id <> old.publication_id or new.owner_id <> old.owner_id
       or new.idempotency_key <> old.idempotency_key or new.request_digest <> old.request_digest
       or new.created_at <> old.created_at then
      raise exception 'only visibility and revocation can change';
    end if;
    return new;
  end if;
  if new.suite_id is not null then
    select s.owner_id into suite_owner from public.suites as s where s.id = new.suite_id;
    if suite_owner is distinct from new.owner_id then
      raise exception 'publication owner must own the suite';
    end if;
  end if;
  if new.edition_id is not null then
    select e.owner_id into edition_owner from public.suite_editions as e where e.id = new.edition_id and e.suite_id = new.suite_id;
    if edition_owner is distinct from new.owner_id then
      raise exception 'publication owner must own the edition in that suite';
    end if;
  end if;
  return new;
end;
$$;

create trigger publication_controls_enforce_shape
  before insert or update on public.publication_controls
  for each row execute function public.enforce_control_shape();

-- Save RPC: bounded v2 input, atomic insert of an immutable edition under an owned suite. Invoker rights + RLS.
create or replace function public.save_suite_edition(
  p_suite_id uuid,
  p_suite_name text,
  p_run_id text,
  p_experiment_digest text,
  p_records_edition_digest text,
  p_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  parsed jsonb;
  target_suite uuid;
  existing uuid;
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if p_content is null or octet_length(p_content) > 8388608 then
    raise exception 'edition content must be at most 8 MiB';
  end if;
  begin
    parsed := p_content::jsonb;
  exception when others then
    raise exception 'edition content is not JSON';
  end;
  if jsonb_typeof(parsed) <> 'object' or jsonb_typeof(parsed->'spec') <> 'object'
     or jsonb_typeof(parsed->'ledger') <> 'object' or jsonb_typeof(parsed->'attempts') <> 'array' then
    raise exception 'edition content must be {spec, ledger, attempts}';
  end if;
  if parsed->'spec'->>'schema_version' is distinct from 's20.run.v2' or parsed->'ledger'->>'schema_version' is distinct from 's20.run.v2' then
    raise exception 'only s20.run.v2 editions can be saved; legacy records use the legacy importer';
  end if;
  if jsonb_array_length(parsed->'attempts') > 2000 or jsonb_array_length(coalesce(parsed->'ledger'->'sides', '[]'::jsonb)) > 2000
     or jsonb_array_length(coalesce(parsed->'spec'->'tasks', '[]'::jsonb)) > 256 then
    raise exception 'edition exceeds attempt, side or task caps';
  end if;
  if parsed->'ledger'->>'run_id' is distinct from p_run_id or parsed->'spec'->>'experiment_digest' is distinct from p_experiment_digest then
    raise exception 'run id or experiment digest does not match the content';
  end if;

  if p_suite_id is null then
    if char_length(btrim(coalesce(p_suite_name, ''))) not between 1 and 160 then
      raise exception 'suite name is required';
    end if;
    insert into public.suites (owner_id, name, description)
    values (auth.uid(), btrim(p_suite_name), 'v2 run editions')
    returning id into target_suite;
  else
    select s.id into target_suite from public.suites as s where s.id = p_suite_id and s.owner_id = auth.uid();
    if target_suite is null then
      raise exception 'suite not found for this owner';
    end if;
  end if;

  select e.id into existing from public.suite_editions as e
  where e.suite_id = target_suite and e.records_edition_digest = p_records_edition_digest;
  if existing is not null then
    return jsonb_build_object('suite_id', target_suite, 'edition_id', existing, 'existing', true);
  end if;

  insert into public.suite_editions (suite_id, owner_id, schema_version, run_id, experiment_digest, records_edition_digest, content)
  values (target_suite, auth.uid(), 's20.run.v2', p_run_id, p_experiment_digest, p_records_edition_digest, p_content)
  returning id into new_id;
  return jsonb_build_object('suite_id', target_suite, 'edition_id', new_id, 'existing', false);
end;
$$;

revoke all on function public.save_suite_edition(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.save_suite_edition(uuid, text, text, text, text, text) to authenticated;

-- Service-only transactional insert with idempotency (called by publish-run after its own JWT/owner checks).
-- Same key + same request returns the existing publication; same key + changed request conflicts.
create or replace function public.record_publication(
  p_owner_id uuid,
  p_suite_id uuid,
  p_edition_id uuid,
  p_idempotency_key text,
  p_request_digest text,
  p_is_public boolean,
  p_method_version text,
  p_content_digest text,
  p_source_edition_digest text,
  p_summary jsonb,
  p_artifact text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prior public.publication_controls;
  new_id uuid;
  created timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key, 0));
  select * into prior from public.publication_controls as c
  where c.owner_id = p_owner_id and c.idempotency_key = p_idempotency_key;
  if found then
    if prior.request_digest <> p_request_digest then
      raise exception 'idempotency key reused with a different request' using errcode = 'P0409';
    end if;
    return jsonb_build_object('id', prior.publication_id, 'is_public', prior.is_public, 'created_at', prior.created_at, 'existing', true);
  end if;
  insert into public.publication_artifacts (schema_version, method_version, content_digest, source_edition_digest, summary, artifact)
  values ('s20.run.v2', p_method_version, p_content_digest, p_source_edition_digest, p_summary, p_artifact)
  returning id, created_at into new_id, created;
  insert into public.publication_controls (publication_id, owner_id, suite_id, edition_id, is_public, idempotency_key, request_digest)
  values (new_id, p_owner_id, p_suite_id, p_edition_id, p_is_public, p_idempotency_key, p_request_digest);
  return jsonb_build_object('id', new_id, 'is_public', p_is_public, 'created_at', created, 'existing', false);
end;
$$;

revoke all on function public.record_publication(uuid, uuid, uuid, text, text, boolean, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_publication(uuid, uuid, uuid, text, text, boolean, text, text, text, jsonb, text) to service_role;

-- Public read: exactly the sanitized schema, no owner identity, only while public and not revoked.
create or replace function public.get_public_publication(p_id uuid)
returns table (
  id uuid,
  schema_version text,
  method_version text,
  content_digest text,
  source_edition_digest text,
  summary jsonb,
  artifact text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.schema_version, a.method_version, a.content_digest, a.source_edition_digest, a.summary, a.artifact, a.created_at
  from public.publication_artifacts as a
  join public.publication_controls as c on c.publication_id = a.id
  where a.id = p_id and c.is_public and c.revoked_at is null;
$$;

revoke all on function public.get_public_publication(uuid) from public;
grant execute on function public.get_public_publication(uuid) to anon, authenticated;

-- Owner deletion removes access and the copied bytes (permanence is not promised).
create or replace function public.delete_my_publication(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if not exists (select 1 from public.publication_controls as c where c.publication_id = p_id and c.owner_id = auth.uid()) then
    raise exception 'publication not found for this owner';
  end if;
  delete from public.publication_artifacts where id = p_id;
end;
$$;

revoke all on function public.delete_my_publication(uuid) from public, anon;
grant execute on function public.delete_my_publication(uuid) to authenticated;

alter table public.suite_editions enable row level security;
alter table public.publication_artifacts enable row level security;
alter table public.publication_controls enable row level security;
alter table public.suite_editions force row level security;
alter table public.publication_artifacts force row level security;
alter table public.publication_controls force row level security;

-- Editions: owner read/insert/delete; no update policy (immutable).
create policy suite_editions_owner_select on public.suite_editions
  for select to authenticated using (owner_id = auth.uid());
create policy suite_editions_owner_insert on public.suite_editions
  for insert to authenticated
  with check (owner_id = auth.uid() and exists (select 1 from public.suites as s where s.id = suite_editions.suite_id and s.owner_id = auth.uid()));
create policy suite_editions_owner_delete on public.suite_editions
  for delete to authenticated using (owner_id = auth.uid());

-- Controls: owner read; owner may change only is_public / revoked_at (column grants below).
create policy publication_controls_owner_select on public.publication_controls
  for select to authenticated using (owner_id = auth.uid());
create policy publication_controls_owner_update on public.publication_controls
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Artifacts: owners can read their own; nobody writes directly (service function only).
create policy publication_artifacts_owner_select on public.publication_artifacts
  for select to authenticated
  using (exists (select 1 from public.publication_controls as c where c.publication_id = publication_artifacts.id and c.owner_id = auth.uid()));

revoke all on public.suite_editions from anon;
revoke all on public.publication_artifacts from anon;
revoke all on public.publication_controls from anon;
revoke insert, update, delete on public.publication_artifacts from authenticated;
revoke insert, update, delete on public.publication_controls from authenticated;
revoke update on public.suite_editions from authenticated;
grant select on public.publication_artifacts to authenticated;
grant select on public.publication_controls to authenticated;
grant update (is_public, revoked_at) on public.publication_controls to authenticated;
grant select, insert, delete on public.suite_editions to authenticated;
