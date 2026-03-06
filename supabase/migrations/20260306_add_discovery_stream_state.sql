alter table public.qa_runs
  add column if not exists run_mode text not null default 'standard';

alter table public.qa_runs
  drop constraint if exists qa_runs_run_mode_check;

alter table public.qa_runs
  add constraint qa_runs_run_mode_check
  check (run_mode in ('standard', 'discover_stream'));

create table if not exists public.qa_discovery_jobs (
  run_id uuid primary key references public.qa_runs(id) on delete cascade,
  state jsonb not null,
  lock_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists qa_discovery_jobs_updated_idx
  on public.qa_discovery_jobs (updated_at desc);

drop trigger if exists qa_discovery_jobs_set_updated_at on public.qa_discovery_jobs;
create trigger qa_discovery_jobs_set_updated_at
before update on public.qa_discovery_jobs
for each row execute function public.set_updated_at();
