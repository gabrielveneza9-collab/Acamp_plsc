-- =============================================================
-- ACAMP PLSC · placar compartilhado
-- Cole tudo no Supabase > SQL Editor > New query e clique em Run.
-- Pode rodar mais de uma vez sem problema (não apaga o placar).
-- =============================================================

-- 1) Tabela com a quantidade de pacotes de cada item tabelado
create table if not exists public.pacotes (
  id         text primary key,
  qty        integer not null default 0 check (qty >= 0 and qty <= 100000),
  updated_at timestamptz not null default now()
);

-- valores iniciais (só entram se o item ainda não existir)
insert into public.pacotes (id, qty) values
  ('cafe', 25), ('oleo', 13), ('feijao', 8), ('leite', 21), ('sardinha', 8)
on conflict (id) do nothing;

-- 2) Segurança: qualquer um pode LER; ninguém altera a tabela direto.
--    As mudanças só passam pelas funções abaixo, que validam os valores.
alter table public.pacotes enable row level security;

drop policy if exists "leitura publica" on public.pacotes;
create policy "leitura publica" on public.pacotes
  for select to anon, authenticated using (true);

revoke insert, update, delete on public.pacotes from anon, authenticated;
grant select on public.pacotes to anon, authenticated;

-- 3) Funções usadas pelo site
-- + / − (soma direto no banco, então cliques ao mesmo tempo não se perdem)
create or replace function public.incrementar_pacote(item text, delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if delta is null or abs(delta) > 1000 then
    raise exception 'delta invalido';
  end if;
  update public.pacotes
     set qty = least(100000, greatest(0, qty + delta)), updated_at = now()
   where id = item;
  if not found then
    raise exception 'item invalido: %', item;
  end if;
end;
$$;

-- digitar uma quantidade
create or replace function public.definir_pacote(item text, quantidade integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if quantidade is null or quantidade < 0 or quantidade > 100000 then
    raise exception 'quantidade invalida';
  end if;
  update public.pacotes set qty = quantidade, updated_at = now() where id = item;
  if not found then
    raise exception 'item invalido: %', item;
  end if;
end;
$$;

-- zerar / desfazer (vários itens de uma vez)
create or replace function public.definir_pacotes(valores jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  v text;
  n integer;
begin
  if valores is null or jsonb_typeof(valores) <> 'object' then
    raise exception 'valores invalidos';
  end if;
  for k, v in select key, value from jsonb_each_text(valores) loop
    n := v::integer;
    if n < 0 or n > 100000 then
      raise exception 'quantidade invalida';
    end if;
    update public.pacotes set qty = n, updated_at = now() where id = k;
    if not found then
      raise exception 'item invalido: %', k;
    end if;
  end loop;
end;
$$;

revoke all on function public.incrementar_pacote(text, integer) from public;
revoke all on function public.definir_pacote(text, integer) from public;
revoke all on function public.definir_pacotes(jsonb) from public;
grant execute on function public.incrementar_pacote(text, integer) to anon, authenticated;
grant execute on function public.definir_pacote(text, integer) to anon, authenticated;
grant execute on function public.definir_pacotes(jsonb) to anon, authenticated;

-- 4) Tempo real: avisa o site na hora em que algo muda
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pacotes'
  ) then
    alter publication supabase_realtime add table public.pacotes;
  end if;
end;
$$;

-- conferência: deve mostrar os 5 itens
select id, qty from public.pacotes order by id;
