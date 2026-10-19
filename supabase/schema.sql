-- =====================================================================
-- Brigit Stock Planner — Supabase setup
-- Adds sp_* tables next to ASH, Lead Sentinel and the trivia game.
-- Does NOT change any existing table. Safe to run more than once.
-- Run in: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- ---------- Who may use the planner ----------
create table if not exists public.sp_users (
  email      text primary key check (email = lower(email)),
  name       text not null,
  role       text not null default 'buyer' check (role in ('admin','buyer','viewer')),
  created_at timestamptz not null default now()
);

create or replace function public.sp_my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.sp_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sp_users where email = public.sp_my_email())
$$;

create or replace function public.sp_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sp_users where email = public.sp_my_email() and role = 'admin')
$$;

create or replace function public.sp_can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sp_users where email = public.sp_my_email() and role in ('admin','buyer'))
$$;

-- n8n signs in with the secret (service_role) key
create or replace function public.sp_is_service() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or coalesce(current_setting('role', true), '') = 'service_role'
$$;

-- ---------- Imports (one row per Qlik export loaded) ----------
create table if not exists public.sp_imports (
  id          uuid primary key default gen_random_uuid(),
  source      text not null default 'n8n',          -- n8n | upload
  file_name   text,
  report_date date,
  status      text not null default 'loading' check (status in ('loading','done','failed')),
  warehouses  text[] not null default '{}',
  row_count   integer not null default 0,
  months      text[] not null default '{}',         -- sales months found, newest first (YYYY-MM)
  message     text,
  created_by  text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------- Stock rows: one per stock code per warehouse ----------
create table if not exists public.sp_stock (
  stock_code       text not null,
  warehouse        text not null,
  description      text,
  long_description text,
  obsolete         text,
  product_manager  text,
  drawing_no       text,
  buyer            text,
  supplier_code    text,
  supplier         text,
  product_class    text,
  on_hold          text,
  unit_cost        numeric not null default 0,
  qty_on_hand_m1   numeric not null default 0,
  qty_available    numeric not null default 0,   -- "Qty Available - ALL": available in THIS row's warehouse
  mtd_sold         numeric not null default 0,
  sales            jsonb   not null default '{}', -- {"2026-09": 810, ...}
  issues           jsonb   not null default '{}', -- same shape, if the export has Issues Qty columns
  mtd_issued       numeric not null default 0,
  overdue_qty      numeric not null default 0,
  po_due_qty       numeric not null default 0,
  po_due           jsonb   not null default '{}', -- {"2026-10": 0, ...}
  open_so_qty      numeric not null default 0,
  selling_price    numeric,
  gp_pct           numeric,
  lead_time_days   numeric,                       -- "Stock Lead Time (Days)" if the export has it
  planner          text,                          -- "Planner" (LOCAL / IH-STOCKED ...) if the export has it
  abc_class        text,                          -- "ABC Class" if the export has it
  import_id        uuid references public.sp_imports(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (stock_code, warehouse)
);
create index if not exists sp_stock_warehouse on public.sp_stock (warehouse);
-- columns added after the first version (safe to re-run)
alter table public.sp_stock add column if not exists lead_time_days numeric;
alter table public.sp_stock add column if not exists planner text;
alter table public.sp_stock add column if not exists abc_class text;

-- Rows wait here until an import is finished, then replace the live rows in one go
create table if not exists public.sp_stock_staging (like public.sp_stock including defaults);
alter table public.sp_stock_staging drop constraint if exists sp_stock_staging_pkey;
create index if not exists sp_stock_staging_import on public.sp_stock_staging (import_id);
alter table public.sp_stock_staging add column if not exists lead_time_days numeric;
alter table public.sp_stock_staging add column if not exists planner text;
alter table public.sp_stock_staging add column if not exists abc_class text;

-- ---------- Settings (one row) ----------
create table if not exists public.sp_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.sp_settings (id, data) values (1, '{
  "coverMonths":      {"LOCAL": 3, "FOREIGN": 6, "IN-HOUSE": 3},
  "leadTimeDays":     {"LOCAL": 30, "FOREIGN": 90, "IN-HOUSE": 14},
  "buyerTypes":       {"CP": "LOCAL", "CH": "FOREIGN", "PRODUCTION": "IN-HOUSE", "IN-BRANCH": "IN-HOUSE", "INBRANCH": "IN-HOUSE"},
  "unknownBuyerType": "LOCAL",
  "demandBasis":      "max6and12",
  "serviceLevel":     {"A": 0.99, "B": 0.95, "C": 0.90},
  "abcSplit":         {"A": 0.80, "B": 0.95},
  "mainWarehouse":    "M1",
  "branches":         {"JH01": 1, "CT01": 3, "DN01": 2},
  "restockCycleDays": 30,
  "planWarehouses":   ["M1","JH01","DN01","CT01","JH02","JH05","JHP1"],
  "subtractOpenSO":   false,
  "includeIssues":    true,
  "minSalesMonths":   3
}'::jsonb) on conflict (id) do nothing;

-- ---------- Supplier settings (lead time / type overrides) ----------
create table if not exists public.sp_suppliers (
  supplier_code  text primary key,
  supply_type    text check (supply_type in ('LOCAL','FOREIGN','IN-HOUSE')),
  lead_time_days int  check (lead_time_days between 0 and 730),
  note           text,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

-- ---------- Per-item buyer decisions ----------
create table if not exists public.sp_item_overrides (
  stock_code     text primary key,
  exclude        boolean not null default false,   -- never suggest buying it
  supply_type    text check (supply_type in ('LOCAL','FOREIGN','IN-HOUSE')),
  lead_time_days int  check (lead_time_days between 0 and 730),
  cover_months   numeric check (cover_months between 0 and 24),
  note           text,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

-- ---------- Access rules ----------
alter table public.sp_users          enable row level security;
alter table public.sp_imports        enable row level security;
alter table public.sp_stock          enable row level security;
alter table public.sp_stock_staging  enable row level security;
alter table public.sp_settings       enable row level security;
alter table public.sp_suppliers      enable row level security;
alter table public.sp_item_overrides enable row level security;

drop policy if exists sp_users_read  on public.sp_users;
drop policy if exists sp_users_admin on public.sp_users;
create policy sp_users_read  on public.sp_users for select to authenticated using (email = public.sp_my_email() or public.sp_is_admin());
create policy sp_users_admin on public.sp_users for all    to authenticated using (public.sp_is_admin()) with check (public.sp_is_admin());

drop policy if exists sp_imports_read on public.sp_imports;
create policy sp_imports_read on public.sp_imports for select to authenticated using (public.sp_is_member());

drop policy if exists sp_stock_read on public.sp_stock;
create policy sp_stock_read on public.sp_stock for select to authenticated using (public.sp_is_member());
-- staging: no policies = nobody reads it directly (the import functions do)

drop policy if exists sp_settings_read  on public.sp_settings;
drop policy if exists sp_settings_admin on public.sp_settings;
create policy sp_settings_read  on public.sp_settings for select to authenticated using (public.sp_is_member());
create policy sp_settings_admin on public.sp_settings for update to authenticated using (public.sp_is_admin()) with check (public.sp_is_admin());

drop policy if exists sp_suppliers_read  on public.sp_suppliers;
drop policy if exists sp_suppliers_admin on public.sp_suppliers;
create policy sp_suppliers_read  on public.sp_suppliers for select to authenticated using (public.sp_is_member());
create policy sp_suppliers_admin on public.sp_suppliers for all    to authenticated using (public.sp_is_admin()) with check (public.sp_is_admin());

drop policy if exists sp_overrides_read on public.sp_item_overrides;
drop policy if exists sp_overrides_edit on public.sp_item_overrides;
create policy sp_overrides_read on public.sp_item_overrides for select to authenticated using (public.sp_is_member());
create policy sp_overrides_edit on public.sp_item_overrides for all    to authenticated using (public.sp_can_edit()) with check (public.sp_can_edit());

grant select on public.sp_users, public.sp_imports, public.sp_stock, public.sp_settings, public.sp_suppliers, public.sp_item_overrides to authenticated;
grant insert, update, delete on public.sp_users, public.sp_suppliers, public.sp_item_overrides to authenticated;
grant update on public.sp_settings to authenticated;

-- =====================================================================
-- IMPORT FUNCTIONS
-- Called by n8n (secret key) or by an admin uploading a file in the app.
--   1. sp_import_begin(file_name, report_date, source)  → import id
--   2. sp_import_rows(import id, rows)                  → call once per batch (e.g. 1,000 rows)
--   3. sp_import_finish(import id)                      → swaps the new rows in
-- Rows are the Qlik export rows exactly as they come out of the file
-- (column headings as keys). Each row must have a "Warehouse" column.
-- Finishing replaces ALL rows of every warehouse found in the import.
-- =====================================================================

-- normalise a Qlik column heading: "Unit Cost - _x000d_\nM1" → "unit cost - m1"
create or replace function public.sp_norm(k text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(k), '_x000d_', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- tolerant number: '', ' ', '-', null → 0; '1 234,5' → 1234.5
create or replace function public.sp_num(v jsonb) returns numeric language plpgsql immutable as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return 0; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  t := regexp_replace(v #>> '{}', '[\s R]', '', 'g');
  t := replace(t, ',', '.');
  if t ~ '^-?[0-9]*\.?[0-9]+(e-?[0-9]+)?$' then return t::numeric; end if;
  return 0;
end $$;

create or replace function public.sp_txt(v jsonb) returns text language sql immutable as $$
  select nullif(nullif(trim(v #>> '{}'), ''), '-')
$$;

-- "SEP 2026" → "2026-09"
create or replace function public.sp_month(m text) returns text language sql immutable as $$
  select to_char(to_date('01 ' || initcap(trim(m)), 'DD Mon YYYY'), 'YYYY-MM')
$$;

create or replace function public.sp_check_import_rights() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.sp_is_service() or public.sp_is_admin()) then
    raise exception 'Only n8n (secret key) or a planner admin can import stock data';
  end if;
end $$;

create or replace function public.sp_import_begin(p_file_name text default null, p_report_date date default null, p_source text default 'n8n')
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.sp_check_import_rights();
  -- clear out abandoned imports older than a day
  delete from public.sp_stock_staging s using public.sp_imports i
   where s.import_id = i.id and i.status = 'loading' and i.created_at < now() - interval '1 day';
  update public.sp_imports set status = 'failed', message = 'Not finished within a day'
   where status = 'loading' and created_at < now() - interval '1 day';
  insert into public.sp_imports (source, file_name, report_date, created_by)
  values (coalesce(nullif(p_source, ''), 'n8n'), p_file_name, coalesce(p_report_date, current_date),
          case when public.sp_is_service() then 'n8n' else public.sp_my_email() end)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.sp_import_rows(p_import_id uuid, p_rows jsonb)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare
  r jsonb; n jsonb; kv record; v_count int := 0; v_wh text; v_code text;
  v_sales jsonb; v_issues jsonb; v_po jsonb; m text;
begin
  perform public.sp_check_import_rights();
  if not exists (select 1 from public.sp_imports where id = p_import_id and status = 'loading') then
    raise exception 'Import % is not open (start it with sp_import_begin)', p_import_id;
  end if;
  if jsonb_typeof(p_rows) = 'object' and p_rows ? 'rows' then p_rows := p_rows -> 'rows'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be a JSON array of rows'; end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    -- re-key the row with normalised headings, and pick up the monthly columns
    n := '{}'; v_sales := '{}'; v_issues := '{}'; v_po := '{}';
    for kv in select key, value from jsonb_each(r) loop
      n := n || jsonb_build_object(public.sp_norm(kv.key), kv.value);
      m := substring(public.sp_norm(kv.key) from '^sales qty - ([a-z]{3} [0-9]{4})$');
      if m is not null then v_sales := v_sales || jsonb_build_object(public.sp_month(m), public.sp_num(kv.value)); end if;
      m := substring(public.sp_norm(kv.key) from '^issues? qty - ([a-z]{3} [0-9]{4})$');
      if m is not null then v_issues := v_issues || jsonb_build_object(public.sp_month(m), public.sp_num(kv.value)); end if;
      m := substring(public.sp_norm(kv.key) from '^po due qty - ([a-z]{3} [0-9]{4})$');
      if m is not null then v_po := v_po || jsonb_build_object(public.sp_month(m), public.sp_num(kv.value)); end if;
    end loop;

    v_code := upper(public.sp_txt(coalesce(n -> 'stockcode', n -> 'stock code')));
    v_wh   := upper(public.sp_txt(n -> 'warehouse'));
    continue when v_code is null or v_wh is null;

    insert into public.sp_stock_staging (
      stock_code, warehouse, description, long_description, obsolete, product_manager, drawing_no,
      buyer, supplier_code, supplier, product_class, on_hold, unit_cost, qty_on_hand_m1, qty_available,
      mtd_sold, sales, issues, mtd_issued, overdue_qty, po_due_qty, po_due, open_so_qty,
      selling_price, gp_pct, lead_time_days, planner, abc_class, import_id, updated_at)
    values (
      v_code, v_wh,
      public.sp_txt(n -> 'stock description'), public.sp_txt(n -> 'longdescription'),
      upper(public.sp_txt(n -> 'obsolete stock')), public.sp_txt(n -> 'productmanager'),
      public.sp_txt(n -> 'draw office num'),
      upper(public.sp_txt(n -> 'buyer')), upper(public.sp_txt(n -> 'supplier code')), public.sp_txt(n -> 'supplier'),
      public.sp_txt(n -> 'product class'), upper(public.sp_txt(n -> 'on hold')),
      public.sp_num(n -> 'unit cost - m1'), public.sp_num(n -> 'qty on hand - m1'),
      public.sp_num(coalesce(n -> 'qty available - all', n -> 'qty available')),
      public.sp_num(n -> 'mtd qty sold'), v_sales, v_issues, public.sp_num(n -> 'mtd qty issued'),
      public.sp_num(n -> 'overdue qty'), public.sp_num(n -> 'po due qty'), v_po,
      public.sp_num(n -> 'open sales order qty (excl. sct)'),
      public.sp_num(n -> 'selling price'), public.sp_num(n -> 'gp %'),
      case when coalesce(n -> 'stock lead time (days)', n -> 'lead time (days)', n -> 'lead time', n -> 'leadtime') is null then null
           else public.sp_num(coalesce(n -> 'stock lead time (days)', n -> 'lead time (days)', n -> 'lead time', n -> 'leadtime')) end,
      upper(public.sp_txt(n -> 'planner')), upper(public.sp_txt(n -> 'abc class')),
      p_import_id, now());
    v_count := v_count + 1;
  end loop;

  update public.sp_imports set row_count = row_count + v_count where id = p_import_id;
  return v_count;
end $$;

create or replace function public.sp_import_finish(p_import_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_wh text[]; v_rows int; v_months text[];
begin
  perform public.sp_check_import_rights();
  if not exists (select 1 from public.sp_imports where id = p_import_id and status = 'loading') then
    raise exception 'Import % is not open', p_import_id;
  end if;

  select array_agg(distinct warehouse order by warehouse) into v_wh from public.sp_stock_staging where import_id = p_import_id;
  if v_wh is null then
    update public.sp_imports set status = 'failed', message = 'No rows with a StockCode and Warehouse', finished_at = now() where id = p_import_id;
    return jsonb_build_object('ok', false, 'message', 'No rows with a StockCode and Warehouse');
  end if;

  select array_agg(k order by k desc) into v_months
    from (select distinct jsonb_object_keys(sales) k from public.sp_stock_staging where import_id = p_import_id) x;

  -- the same stock code/warehouse can appear in several files (each branch file repeats M1): keep one
  delete from public.sp_stock where warehouse = any (v_wh);
  insert into public.sp_stock (
         stock_code, warehouse, description, long_description, obsolete, product_manager, drawing_no,
         buyer, supplier_code, supplier, product_class, on_hold, unit_cost, qty_on_hand_m1, qty_available,
         mtd_sold, sales, issues, mtd_issued, overdue_qty, po_due_qty, po_due, open_so_qty,
         selling_price, gp_pct, lead_time_days, planner, abc_class, import_id, updated_at)
  select distinct on (stock_code, warehouse)
         stock_code, warehouse, description, long_description, obsolete, product_manager, drawing_no,
         buyer, supplier_code, supplier, product_class, on_hold, unit_cost, qty_on_hand_m1, qty_available,
         mtd_sold, sales, issues, mtd_issued, overdue_qty, po_due_qty, po_due, open_so_qty,
         selling_price, gp_pct, lead_time_days, planner, abc_class, import_id, updated_at
    from public.sp_stock_staging
   where import_id = p_import_id
   order by stock_code, warehouse, updated_at desc;
  get diagnostics v_rows = row_count;
  delete from public.sp_stock_staging where import_id = p_import_id;

  update public.sp_imports
     set status = 'done', warehouses = v_wh, row_count = v_rows, months = coalesce(v_months, '{}'), finished_at = now(),
         message = 'Loaded ' || v_rows || ' rows for ' || array_to_string(v_wh, ', ')
   where id = p_import_id;
  return jsonb_build_object('ok', true, 'warehouses', v_wh, 'rows', v_rows, 'months', v_months);
end $$;

-- Same as sp_import_begin, but answers {"import_id": "..."} (easier to read in n8n)
create or replace function public.sp_import_start(p_file_name text default null, p_report_date date default null, p_source text default 'n8n')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  return jsonb_build_object('import_id', public.sp_import_begin(p_file_name, p_report_date, p_source));
end $$;

-- Combine several per-warehouse files into one import, or send everything in one call
create or replace function public.sp_import_all(p_rows jsonb, p_file_name text default null, p_report_date date default null, p_source text default 'n8n')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := public.sp_import_begin(p_file_name, p_report_date, p_source);
  perform public.sp_import_rows(v_id, p_rows);
  return public.sp_import_finish(v_id) || jsonb_build_object('import_id', v_id);
end $$;

revoke all on function public.sp_import_start(text, date, text) from public, anon;
grant execute on function public.sp_import_start(text, date, text) to authenticated, service_role;
revoke all on function public.sp_import_begin(text, date, text), public.sp_import_rows(uuid, jsonb),
                       public.sp_import_finish(uuid), public.sp_import_all(jsonb, text, date, text) from public, anon;
grant execute on function public.sp_import_begin(text, date, text), public.sp_import_rows(uuid, jsonb),
                          public.sp_import_finish(uuid), public.sp_import_all(jsonb, text, date, text) to authenticated, service_role;
grant execute on function public.sp_is_member(), public.sp_is_admin(), public.sp_can_edit(), public.sp_my_email() to authenticated;

-- =====================================================================
-- FIRST USERS — edit names/emails, then run. Add buyers in the app later.
-- =====================================================================
insert into public.sp_users (email, name, role) values
  ('sysproai@elveygroup.com', 'Syspro AI (admin)', 'admin'),
  ('lasya@elveygroup.com',    'Lasya Niemandt',    'admin')
on conflict (email) do nothing;
