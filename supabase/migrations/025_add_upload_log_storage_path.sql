begin;

-- Additive compatibility step. Apply this before deploying the API/UI that
-- reads and writes upload_logs.storage_path.
alter table public.upload_logs
  add column if not exists storage_path varchar(500);

alter table public.upload_logs
  drop constraint if exists upload_logs_storage_path_check;

alter table public.upload_logs
  add constraint upload_logs_storage_path_check
  check (
    storage_path is null
    or (
      length(storage_path) between 9 and 500
      and storage_path ~ '^uploads/[A-Za-z0-9/._-]+$'
      and storage_path !~ '(^|/)\.\.(/|$)'
    )
  );

-- upload-debug is shared by sales debug files and settlement direct uploads.
-- Enforce the largest application limit at the signed Storage boundary.
update storage.buckets
set file_size_limit = 104857600
where id = 'upload-debug';

commit;
