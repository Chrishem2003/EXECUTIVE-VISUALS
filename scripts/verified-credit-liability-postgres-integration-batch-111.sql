-- Batch 111: deferred value and unused credit liability must remain separate.
set role service_role;
do $batch111_verify$
declare
  v_owner constant uuid:='71717171-7171-4171-8171-717171717171';
  v_report jsonb;
  v_usd jsonb;
  v_unpriced jsonb;
begin
  v_report:=executive_visuals.financial_credit_liability_report(v_owner,null);
  select value into v_usd
    from jsonb_array_elements(v_report->'byCurrency')
    where value->>'currency'='USD';
  if v_usd is null then
    raise exception 'Batch 111 did not return the verified USD credit source';
  end if;
  if (v_usd->>'recognizedRevenueMinor')::bigint<>400
     or (v_usd->>'deferredRevenueLiabilityMinor')::bigint<>600 then
    raise exception 'Batch 111 must distinguish earned revenue from deferred paid-credit value: %',v_usd;
  end if;
  if (v_usd->>'creditsGranted')::bigint<>1050
     or (v_usd->>'creditsConsumed')::bigint<>70
     or (v_usd->>'creditsRemaining')::bigint<>980 then
    raise exception 'Batch 111 credit unit totals are inconsistent: %',v_usd;
  end if;
  if (v_usd->>'pendingSubscriptionSplitCredits')::bigint<>20
     or (v_usd->>'unattributedCredits')::bigint<>0 then
    raise exception 'Pending subscription value must remain unpriced and separate: %',v_usd;
  end if;
  v_unpriced:=v_report->'unpriced';
  if (v_unpriced->>'pending_split_credits')::bigint<>20
     or (v_unpriced->>'unattributed_credits')::bigint<>5 then
    raise exception 'Batch 111 must surface pending and unattributed credits outside currency totals: %',v_unpriced;
  end if;
  if (v_usd->>'integrityExceptionSources')::integer<>0 then
    raise exception 'Unexpected source integrity exception: %',v_usd;
  end if;
  if v_report->'limitations' is null then
    raise exception 'Batch 111 must disclose report limitations';
  end if;
end
$batch111_verify$;
reset role;
