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
