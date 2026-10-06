-- =====================================================================
-- DIASTOCK – RESET TOTALE E SCHEMA COMPLETO DIRETTO
-- Sicuro al 100%: rimuove vecchie tabelle/policy ed esegue da zero
-- =====================================================================

create extension if not exists pgcrypto;

-- 1. PULIZIA COMPLETA TABELLE PRECEDENTI (se esistenti)
drop table if exists public.push_subscriptions cascade;
drop table if exists public.audit_log cascade;
drop table if exists public.notifiche cascade;
drop table if exists public.righe_inventario cascade;
drop table if exists public.inventari cascade;
drop table if exists public.materiali cascade;
drop table if exists public.operatori cascade;
drop sequence if exists public.inventari_numero_seq cascade;

-- 2. TABELLA OPERATORI (con PIN a 4 cifre)
create table public.operatori (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  pin         varchar(4) not null check (pin ~ '^[0-9]{4}$'),
  ruolo       text not null default 'operatore' check (ruolo in ('operatore','master')),
  attivo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Master predefinito con PIN 1234
insert into public.operatori (nome, pin, ruolo, attivo)
values ('Coordinatore Master', '1234', 'master', true);

-- 3. TABELLA MATERIALI
create table public.materiali (
  id                 uuid primary key,
  barcode            text not null unique,
  nome               text not null,
  categoria          text not null default '',
  pezzi_per_scatola  integer not null default 1 check (pezzi_per_scatola > 0),
  scorta_minima      integer not null default 0 check (scorta_minima >= 0),
  attivo             boolean not null default true,
  created_by         uuid references public.operatori(id),
  updated_by         uuid references public.operatori(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 4. TABELLA INVENTARI E RIGHE
create table public.inventari (
  id             uuid primary key,
  numero         integer,
  operatore_id   uuid not null references public.operatori(id),
  operatore_nome text not null default '',
  device_id      text,
  note           text default '',
  iniziato_at    timestamptz not null,
  chiuso_at      timestamptz not null,
  synced_at      timestamptz not null default now()
);

create table public.righe_inventario (
  id                uuid primary key,
  inventario_id     uuid not null references public.inventari(id) on delete cascade,
  materiale_id      uuid not null references public.materiali(id) on delete cascade,
  scatole           integer not null default 0 check (scatole >= 0),
  pezzi_per_scatola integer not null default 1,
  totale_pezzi      integer generated always as (scatole * pezzi_per_scatola) stored,
  esito             text not null check (esito in ('scansionato','manuale','non_necessario')),
  motivo            text default '',
  operatore_id      uuid not null references public.operatori(id),
  rilevato_at       timestamptz not null
);

create index righe_inv_idx on public.righe_inventario(inventario_id);
create index righe_mat_idx on public.righe_inventario(materiale_id);

-- 5. TABELLA NOTIFICHE E AUDIT LOG
create table public.notifiche (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('inventario','scorta','sistema')),
  destinatari    text not null default 'tutti' check (destinatari in ('tutti','master')),
  titolo         text not null,
  testo          text not null default '',
  inventario_id  uuid references public.inventari(id) on delete cascade,
  materiale_id   uuid references public.materiali(id) on delete cascade,
  operatore_id   uuid references public.operatori(id),
  created_at     timestamptz not null default now()
);

create table public.audit_log (
  id            uuid primary key,
  operatore_id  uuid not null references public.operatori(id),
  device_id     text,
  azione        text not null,
  entita        text,
  entita_id     text,
  dettagli      jsonb default '{}'::jsonb,
  eseguito_at   timestamptz not null,
  synced_at     timestamptz not null default now()
);

create table public.push_subscriptions (
  endpoint      text primary key,
  user_id       uuid not null references public.operatori(id) on delete cascade,
  subscription  jsonb not null,
  created_at    timestamptz not null default now()
);

-- 6. ABILITAZIONE PERMESSI ACCESSO (RLS PERMETTE TUTTO A ANON)
alter table public.operatori          enable row level security;
alter table public.materiali          enable row level security;
alter table public.inventari          enable row level security;
alter table public.righe_inventario   enable row level security;
alter table public.notifiche          enable row level security;
alter table public.audit_log          enable row level security;
alter table public.push_subscriptions enable row level security;

create policy p_anon_operatori on public.operatori for all to anon using (true) with check (true);
create policy p_anon_materiali on public.materiali for all to anon using (true) with check (true);
create policy p_anon_inventari on public.inventari for all to anon using (true) with check (true);
create policy p_anon_righe on public.righe_inventario for all to anon using (true) with check (true);
create policy p_anon_notifiche on public.notifiche for all to anon using (true) with check (true);
create policy p_anon_audit on public.audit_log for all to anon using (true) with check (true);
create policy p_anon_push on public.push_subscriptions for all to anon using (true) with check (true);

grant usage on schema public to anon;
grant all on all tables in schema public to anon;
grant all on all sequences in schema public to anon;
