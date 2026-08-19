-- 在 Supabase 的 SQL Editor 執行這段，建立使用者的點數/免費次數資料表
-- （這是為下一階段「點數系統」預先準備，帳號登入本身不依賴這張表）

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points_balance integer not null default 0,
  last_free_use_at timestamptz,
  created_at timestamptz not null default now()
);

-- 使用者第一次登入時，自動建立一筆 profiles 記錄
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 啟用 Row Level Security：使用者只能讀到自己的資料
alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = user_id);

-- 注意：不開放使用者自己 update points_balance，
-- 扣點/加點一律透過後端（service_role key）執行，避免使用者竄改點數。
