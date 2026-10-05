-- Breeze 노트: Supabase SQL Editor에 통째로 붙여넣고 Run 하세요.

create table if not exists public.notes (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null default '',
  pinned     boolean not null default false,
  deleted    boolean not null default false,
  updated_at timestamptz not null,               -- 기기에서 마지막으로 수정한 시각 (충돌 시 최신 우선)
  synced_at  timestamptz not null default now()  -- 서버에 도착한 시각 (변경분만 가져오는 커서)
);
create index if not exists notes_user_synced on public.notes (user_id, synced_at);

alter table public.notes enable row level security;
drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 더 오래된 수정이 나중에 도착해도 최신 내용을 덮어쓰지 않게 함
create or replace function public.notes_lww() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists notes_lww on public.notes;
create trigger notes_lww before insert or update on public.notes
  for each row execute function public.notes_lww();

-- 실시간 알림 (다른 기기에서 바로 반영)
do $$ begin
  alter publication supabase_realtime add table public.notes;
exception when duplicate_object then null;
end $$;

-- ===== 사진 저장소 (사진 기능을 위해 추가) =====
insert into storage.buckets (id, name, public) values ('images', 'images', false)
  on conflict (id) do nothing;

drop policy if exists "own images read" on storage.objects;
drop policy if exists "own images write" on storage.objects;
drop policy if exists "own images update" on storage.objects;
create policy "own images read" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images write" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images update" on storage.objects for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
