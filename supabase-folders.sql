-- Breeze 폴더 기능: Supabase SQL Editor에서 한 번 실행하세요.
-- 노트가 어느 폴더에 있는지, 처음 만든 날, 마지막으로 글을 고친 날을 기기끼리 맞춥니다.
alter table public.notes add column if not exists folder text;
alter table public.notes add column if not exists created_at timestamptz;
alter table public.notes add column if not exists edited_at timestamptz;
