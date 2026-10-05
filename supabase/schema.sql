-- =====================================================================
-- DIASTOCK – Schema database Supabase
-- Eseguire tutto il file in: Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- PROFILI OPERATORI (1:1 con auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  nome        text not null default '',
  ruolo       text not null default 'operatore' check (ruolo in ('operatore','master')),
  attivo      boolean not null default false,   -- il master approva i nuovi operatori
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- crea automaticamente il profilo alla registrazione
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, nome)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'nome', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and attivo);
$$;

create or replace function public.is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and attivo and ruolo = 'master');
$$;

-- un operatore non può promuoversi o attivarsi da solo
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() nullo = SQL Editor / service role: modifica consentita
  if auth.uid() is not null and not public.is_master() then
    new.ruolo  := old.ruolo;
    new.attivo := old.attivo;
    new.email  := old.email;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------
-- MATERIALI (anagrafica)
-- ---------------------------------------------------------------------
create table if not exists public.materiali (
  id                 uuid primary key,
  barcode            text not null unique,
  nome               text not null,
  categoria          text not null default '',
  pezzi_per_scatola  integer not null default 1 check (pezzi_per_scatola > 0),
  scorta_minima      integer not null default 0 check (scorta_minima >= 0), -- in SCATOLE, la imposta il master
  attivo             boolean not null default true,
  created_by         uuid references public.profiles(id),
  updated_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- INVENTARI
-- ---------------------------------------------------------------------
create sequence if not exists public.inventari_numero_seq;

create table if not exists public.inventari (
  id            uuid primary key,
  numero        integer unique default nextval('public.inventari_numero_seq'),
  operatore_id  uuid not null references public.profiles(id),
  operatore_nome text not null default '',
  device_id     text,
  note          text default '',
  iniziato_at   timestamptz not null,
  chiuso_at     timestamptz not null,
  synced_at     timestamptz not null default now()
);

create table if not exists public.righe_inventario (
  id             uuid primary key,
  inventario_id  uuid not null references public.inventari(id) on delete cascade,
  materiale_id   uuid not null references public.materiali(id),
  scatole        integer not null default 0 check (scatole >= 0),
  pezzi_per_scatola integer not null default 1,
  totale_pezzi   integer generated always as (scatole * pezzi_per_scatola) stored,
  esito          text not null check (esito in ('scansionato','manuale','non_necessario')),
  motivo         text default '',
  operatore_id   uuid not null references public.profiles(id),
  rilevato_at    timestamptz not null
);
create index if not exists righe_inv_idx on public.righe_inventario(inventario_id);
create index if not exists righe_mat_idx on public.righe_inventario(materiale_id);

-- ---------------------------------------------------------------------
-- NOTIFICHE
-- ---------------------------------------------------------------------
create table if not exists public.notifiche (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('inventario','scorta','sistema')),
  destinatari    text not null default 'tutti' check (destinatari in ('tutti','master')),
  titolo         text not null,
  testo          text not null default '',
  inventario_id  uuid references public.inventari(id) on delete cascade,
  materiale_id   uuid references public.materiali(id) on delete cascade,
  operatore_id   uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- REGISTRO ATTIVITÀ (ogni operazione abbinata all'operatore)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id            uuid primary key,
  operatore_id  uuid not null references public.profiles(id),
  device_id     text,
  azione        text not null,
  entita        text,
  entita_id     text,
  dettagli      jsonb default '{}'::jsonb,
  eseguito_at   timestamptz not null,
  synced_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- SOTTOSCRIZIONI PUSH
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint      text primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  subscription  jsonb not null,
  created_at    timestamptz not null default now()
);

-- =====================================================================
-- RPC: sincronizzazione materiale (gestisce barcode duplicati creati offline)
-- Ritorna l'id definitivo del materiale.
-- =====================================================================
create or replace function public.sync_materiale(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_existing record;
  v_master boolean := public.is_master();
begin
  if not public.is_active() then raise exception 'Utente non attivo'; end if;

  select * into v_existing from materiali where id = v_id;
  if not found then
    select * into v_existing from materiali where barcode = p->>'barcode';
  end if;

  if not found then
    insert into materiali (id, barcode, nome, categoria, pezzi_per_scatola, scorta_minima, attivo,
                           created_by, updated_by, created_at, updated_at)
    values (v_id, p->>'barcode', p->>'nome', coalesce(p->>'categoria',''),
            greatest(coalesce((p->>'pezzi_per_scatola')::int,1),1),
            case when v_master then coalesce((p->>'scorta_minima')::int,0) else 0 end,
            coalesce((p->>'attivo')::boolean, true),
            auth.uid(), auth.uid(),
            coalesce((p->>'updated_at')::timestamptz, now()), coalesce((p->>'updated_at')::timestamptz, now()));
    return v_id;
  end if;

  -- last-write-wins sull'orario della modifica
  if coalesce((p->>'updated_at')::timestamptz, now()) >= v_existing.updated_at then
    update materiali set
      nome = p->>'nome',
      categoria = coalesce(p->>'categoria',''),
      pezzi_per_scatola = greatest(coalesce((p->>'pezzi_per_scatola')::int,1),1),
      scorta_minima = case when v_master then coalesce((p->>'scorta_minima')::int, scorta_minima) else scorta_minima end,
      attivo = case when v_master then coalesce((p->>'attivo')::boolean, attivo) else attivo end,
      updated_by = auth.uid(),
      updated_at = coalesce((p->>'updated_at')::timestamptz, now())
    where id = v_existing.id;
  end if;
  return v_existing.id;
end $$;

-- =====================================================================
-- RPC: sincronizzazione inventario completo (atomica e idempotente)
-- Assegna il numero definitivo, crea notifiche e alert scorte.
-- =====================================================================
create or replace function public.sync_inventario(p jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_num integer;
  v_nome text;
  r jsonb;
  m record;
begin
  if not public.is_active() then raise exception 'Utente non attivo'; end if;
  if (p->>'operatore_id')::uuid <> auth.uid() then raise exception 'Operatore non corrispondente'; end if;

  select numero into v_num from inventari where id = v_id;
  if found then return v_num; end if;   -- già sincronizzato

  select nome into v_nome from profiles where id = auth.uid();

  insert into inventari (id, operatore_id, operatore_nome, device_id, note, iniziato_at, chiuso_at)
  values (v_id, auth.uid(), coalesce(v_nome,''), p->>'device_id', coalesce(p->>'note',''),
          (p->>'iniziato_at')::timestamptz, (p->>'chiuso_at')::timestamptz)
  returning numero into v_num;

  for r in select * from jsonb_array_elements(p->'righe') loop
    insert into righe_inventario (id, inventario_id, materiale_id, scatole, pezzi_per_scatola,
                                  esito, motivo, operatore_id, rilevato_at)
    values ((r->>'id')::uuid, v_id, (r->>'materiale_id')::uuid,
            coalesce((r->>'scatole')::int,0), greatest(coalesce((r->>'pezzi_per_scatola')::int,1),1),
            r->>'esito', coalesce(r->>'motivo',''), auth.uid(), (r->>'rilevato_at')::timestamptz);
  end loop;

  insert into notifiche (tipo, destinatari, titolo, testo, inventario_id, operatore_id)
  values ('inventario', 'tutti',
          'Inventario n. ' || v_num,
          'Compilato da ' || coalesce(v_nome,'') || ' il ' ||
            to_char((p->>'chiuso_at')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'),
          v_id, auth.uid());

  -- alert sotto scorta (solo materiali rilevati, non "non necessari")
  for m in
    select mt.id, mt.nome, mt.scorta_minima, ri.scatole
    from righe_inventario ri join materiali mt on mt.id = ri.materiale_id
    where ri.inventario_id = v_id and ri.esito <> 'non_necessario'
      and mt.scorta_minima > 0 and ri.scatole < mt.scorta_minima
  loop
    insert into notifiche (tipo, destinatari, titolo, testo, inventario_id, materiale_id, operatore_id)
    values ('scorta', 'master', 'Sotto scorta: ' || m.nome,
            'Giacenza ' || m.scatole || ' scatole – minimo ' || m.scorta_minima || ' (inventario n. ' || v_num || ')',
            v_id, m.id, auth.uid());
  end loop;

  return v_num;
end $$;

grant execute on function public.sync_materiale(jsonb)  to authenticated;
grant execute on function public.sync_inventario(jsonb) to authenticated;

-- =====================================================================
-- VISTA GIACENZE ATTUALI (utile anche per la futura app Ordini)
-- Ultima rilevazione valida (non "non necessario") per ciascun materiale.
-- =====================================================================
create or replace view public.giacenze_attuali with (security_invoker = true) as
select distinct on (mt.id)
  mt.id as materiale_id, mt.barcode, mt.nome, mt.categoria, mt.pezzi_per_scatola, mt.scorta_minima,
  ri.scatole, ri.totale_pezzi, i.numero as inventario_numero, i.chiuso_at as rilevato_il,
  (mt.scorta_minima > 0 and coalesce(ri.scatole,0) < mt.scorta_minima) as sotto_scorta
from materiali mt
left join righe_inventario ri on ri.materiale_id = mt.id and ri.esito <> 'non_necessario'
left join inventari i on i.id = ri.inventario_id
where mt.attivo
order by mt.id, i.chiuso_at desc nulls last;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.profiles            enable row level security;
alter table public.materiali           enable row level security;
alter table public.inventari           enable row level security;
alter table public.righe_inventario    enable row level security;
alter table public.notifiche           enable row level security;
alter table public.audit_log           enable row level security;
alter table public.push_subscriptions  enable row level security;

drop policy if exists p_profiles_sel on public.profiles;
create policy p_profiles_sel on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active());
drop policy if exists p_profiles_upd on public.profiles;
create policy p_profiles_upd on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_master());

drop policy if exists p_mat_sel on public.materiali;
create policy p_mat_sel on public.materiali for select to authenticated using (public.is_active());

drop policy if exists p_inv_sel on public.inventari;
create policy p_inv_sel on public.inventari for select to authenticated using (public.is_active());

drop policy if exists p_righe_sel on public.righe_inventario;
create policy p_righe_sel on public.righe_inventario for select to authenticated using (public.is_active());

drop policy if exists p_notif_sel on public.notifiche;
create policy p_notif_sel on public.notifiche for select to authenticated
  using (public.is_active() and (destinatari = 'tutti' or public.is_master()));

drop policy if exists p_audit_ins on public.audit_log;
create policy p_audit_ins on public.audit_log for insert to authenticated
  with check (operatore_id = auth.uid() and public.is_active());
drop policy if exists p_audit_sel on public.audit_log;
create policy p_audit_sel on public.audit_log for select to authenticated
  using (operatore_id = auth.uid() or public.is_master());

drop policy if exists p_push_all on public.push_subscriptions;
create policy p_push_all on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- PRIMO MASTER: dopo esserti registrato dall'app, esegui (sostituisci l'email):
--   update public.profiles set ruolo = 'master', attivo = true where email = 'coordinatore@esempio.it';
-- =====================================================================
