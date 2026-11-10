-- Batch 39: real snapshot movement bridge and cohort retention curves.
reset role;
insert into auth.users(id,email) values
 ('55555555-5555-4555-8555-555555555555','batch39-new@example.invalid'),
 ('66666666-6666-4666-8666-666666666666','batch39-churned@example.invalid')
on conflict(id) do nothing;
insert into executive_visuals.subscription_revenue_snapshots(
 snapshot_month,owner_id,cohort_month,currency,mrr_minor,subscription_status
) values
 ((date_trunc('month',now())-interval '1 month')::date,'77777777-7777-4777-8777-777777777777',
  (date_trunc('month',now())-interval '1 month')::date,'ZZZ',80000,'active'),
 ((date_trunc('month',now())-interval '1 month')::date,'66666666-6666-4666-8666-666666666666',
  (date_trunc('month',now())-interval '1 month')::date,'ZZZ',30000,'active'),
 (date_trunc('month',now())::date,'77777777-7777-4777-8777-777777777777',
  (date_trunc('month',now())-interval '1 month')::date,'ZZZ',100000,'active'),
 (date_trunc('month',now())::date,'55555555-5555-4555-8555-555555555555',
  date_trunc('month',now())::date,'ZZZ',40000,'active')
on conflict(snapshot_month,owner_id,currency) do update
 set mrr_minor=excluded.mrr_minor,subscription_status=excluded.subscription_status;
set role service_role;
do $batch39$
declare
 v_report jsonb;
 v_bridge jsonb;
 v_prior_cohort jsonb;
 v_new_cohort jsonb;
 v_actor constant uuid:='99999999-9999-4999-8999-999999999999';
begin
 v_report:=executive_visuals.financial_revenue_movement_overview(v_actor);
 if (v_report->'comparison'->>'available')::boolean is not true then
  raise exception 'Batch 39 monthly comparison should be available: %',v_report->'comparison';
 end if;
 select movement_row.value into v_bridge from jsonb_array_elements(v_report->'movement') as movement_row(value) where movement_row.value->>'currency'='ZZZ';
 if v_bridge is null then raise exception 'UGX movement bridge missing: %',v_report; end if;
 if (v_bridge->>'openingMrrMinor')::bigint<>110000
  or (v_bridge->>'newMrrMinor')::bigint<>40000
  or (v_bridge->>'expansionMrrMinor')::bigint<>20000
  or (v_bridge->>'contractionMrrMinor')::bigint<>0
  or (v_bridge->>'churnMrrMinor')::bigint<>30000
  or (v_bridge->>'closingMrrMinor')::bigint<>140000
  or (v_bridge->>'reconciliationDeltaMinor')::bigint<>0 then
  raise exception 'MRR movement bridge does not reconcile: %',v_bridge;
 end if;
 select cohort_row.value into v_prior_cohort from jsonb_array_elements(v_report->'cohorts') as cohort_row(value)
  where cohort_row.value->>'currency'='ZZZ' and cohort_row.value->>'cohortMonth'=(date_trunc('month',now())-interval '1 month')::date::text
   and cohort_row.value->>'snapshotMonth'=date_trunc('month',now())::date::text;
 if v_prior_cohort is null or (v_prior_cohort->>'baselineCustomers')::integer<>2
  or (v_prior_cohort->>'activeCustomers')::integer<>1
  or (v_prior_cohort->>'logoRetentionPct')::numeric<>50
  or (v_prior_cohort->>'revenueRetentionPct')::numeric<>90.91 then
  raise exception 'Observed prior cohort retention curve mismatch: %',v_prior_cohort;
 end if;
 select cohort_row.value into v_new_cohort from jsonb_array_elements(v_report->'cohorts') as cohort_row(value)
  where cohort_row.value->>'currency'='ZZZ' and cohort_row.value->>'cohortMonth'=date_trunc('month',now())::date::text
   and cohort_row.value->>'snapshotMonth'=date_trunc('month',now())::date::text;
 if v_new_cohort is null or (v_new_cohort->>'logoRetentionPct')::numeric<>100 then
  raise exception 'New cohort first-observed baseline mismatch: %',v_new_cohort;
 end if;
end $batch39$;
reset role;
