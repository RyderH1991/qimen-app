-- 在 Supabase 的 SQL Editor 執行這段
-- 這版改成「不依賴 Supabase Auth」的登入方式：
-- 使用者身份完全由我們自己的後端（LINE OAuth + JWT cookie）管理，
-- Supabase 純粹當資料庫使用，所有讀寫都透過後端的 service_role key，
-- 不開放給前端直接存取，因此不需要設計 RLS 政策給一般使用者。

-- 如果你之前已經建立過 profiles 表（給 Supabase Auth 用的舊版），可以先清掉，不清也不影響：
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.handle_new_user;
-- drop table if exists public.profiles;

create table if not exists public.app_users (
  line_user_id text primary key,
  display_name text,
  picture_url text,
  points_balance integer not null default 0,
  last_free_use_at timestamptz,
  created_at timestamptz not null default now()
);

-- 啟用 RLS 但不開放任何政策：
-- 一般使用者（用 anon/publishable key）完全無法讀寫這張表，
-- 只有後端用 service_role key（會自動繞過RLS）才能存取，確保點數不會被竄改。
alter table public.app_users enable row level security;

-- ---------- 儲值訂單（綠界金流用） ----------
create table if not exists public.orders (
  id text primary key,                 -- 綠界 MerchantTradeNo（訂單編號）
  line_user_id text not null references public.app_users(line_user_id),
  package_points integer not null,
  amount_ntd integer not null,
  status text not null default 'pending',  -- pending / paid / failed
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.orders enable row level security;
-- 同樣不開放任何政策，只有後端 service_role key 能存取
