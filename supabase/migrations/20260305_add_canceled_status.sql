alter table public.qa_runs
  drop constraint if exists qa_runs_status_check;

alter table public.qa_runs
  add constraint qa_runs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));
