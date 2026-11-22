-- Batch 47: read-only generation credit availability for exact project quotes.
-- Supports personal wallets and project shared pools without reserving or moving credits.
-- Apply to disposable PostgreSQL CI first; production migration remains separately gated.

create or replace function executive_visuals.get_generation_credit_balance_for_project(
 p_owner_id uuid,p_project_id uuid
) returns table(
 ledger_balance bigint,
 reserved_credits bigint,
 available_credits bigint,
 funding_source text,
 pool_status text
)
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $get_generation_credit_balance_for_project$
declare
 pool project_credit_pools;
 gross_balance bigint;
 active_reserved bigint;
 available_balance bigint;
begin
 if p_owner_id is null or p_project_id is null then
  raise exception 'BILLING_CREDIT_BALANCE_SCOPE_REQUIRED';
 end if;
 if not exists(select 1 from projects where id=p_project_id and owner_id=p_owner_id) then
  raise exception 'BILLING_CREDIT_BALANCE_PROJECT_FORBIDDEN';
 end if;

 select * into pool from project_credit_pools where project_id=p_project_id;
 if pool.project_id is not null then
  if pool.owner_id<>p_owner_id then
   raise exception 'PROJECT_CREDIT_POOL_OWNER_MISMATCH';
  end if;
  select coalesce(sum(amount),0)::bigint into available_balance
   from project_credit_pool_ledger where project_id=p_project_id;
  select coalesce(sum(reserved_credits),0)::bigint into active_reserved
   from project_credit_pool_reservations
   where project_id=p_project_id and state='reserved';
  gross_balance:=available_balance+active_reserved;
  return query select gross_balance,active_reserved,available_balance,'project_pool'::text,pool.status;
  return;
 end if;

 select coalesce(sum(amount),0)::bigint into available_balance
  from billing_credit_ledger where owner_id=p_owner_id;
 select coalesce(sum(reserved_credits),0)::bigint into active_reserved
  from billing_credit_reservations
  where owner_id=p_owner_id and state='reserved';
 gross_balance:=available_balance+active_reserved;
 return query select gross_balance,active_reserved,available_balance,'personal'::text,'active'::text;
end;
$get_generation_credit_balance_for_project$;

revoke all on function executive_visuals.get_generation_credit_balance_for_project(uuid,uuid)
 from public,anon,authenticated;
grant execute on function executive_visuals.get_generation_credit_balance_for_project(uuid,uuid)
 to service_role;
