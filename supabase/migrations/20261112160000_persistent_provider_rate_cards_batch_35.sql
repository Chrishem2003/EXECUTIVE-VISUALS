-- Batch 35: versioned, evidence-aware provider model rate cards.
-- Existing immutable catalog rows are retained as legacy_unverified.
alter table executive_visuals.ai_model_price_catalog
 add column if not exists rate_card_version text not null default 'legacy',
 add column if not exists billing_unit text not null default 'legacy_unit',
 add column if not exists source_url text not null default '',
 add column if not exists source_checked_at timestamptz,
 add column if not exists source_fingerprint text not null default '',
 add column if not exists verification_status text not null default 'legacy_unverified',
 add column if not exists pricing_dimensions jsonb not null default '{}'::jsonb,
 add column if not exists supersedes_id uuid references executive_visuals.ai_model_price_catalog(id),
 add column if not exists recorded_by uuid references auth.users(id);

alter table executive_visuals.ai_model_price_catalog
 add constraint ai_model_price_catalog_version_check check(rate_card_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$'),
 add constraint ai_model_price_catalog_billing_unit_check check(billing_unit in(
  'legacy_unit','tokens_per_million','image','video_second','render_second',
  'request','frame','minute','character_block','mixed'
 )),
 add constraint ai_model_price_catalog_verification_check check(verification_status in(
  'legacy_unverified','source_linked','contract_attested','admin_attested'
 )),
 add constraint ai_model_price_catalog_fingerprint_check check(source_fingerprint='' or source_fingerprint ~ '^[a-f0-9]{64}$'),
 add constraint ai_model_price_catalog_dimensions_check check(jsonb_typeof(pricing_dimensions)='object');

create unique index if not exists ai_model_price_catalog_version_unique
 on executive_visuals.ai_model_price_catalog(provider,model,currency,rate_card_version);
create index if not exists ai_model_price_catalog_current_lookup
 on executive_visuals.ai_model_price_catalog(provider,model,currency,effective_from desc);

create or replace function executive_visuals.add_ai_model_price_rate_card(p_actor_id uuid,p_rate_card jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare
 v_provider text:=lower(btrim(coalesce(p_rate_card->>'provider','')));
 v_model text:=btrim(coalesce(p_rate_card->>'model',''));
 v_currency text:=upper(btrim(coalesce(p_rate_card->>'currency','')));
 v_version text:=btrim(coalesce(p_rate_card->>'rateCardVersion',''));
 v_unit text:=coalesce(p_rate_card->>'billingUnit','');
 v_from timestamptz; v_to timestamptz;
 v_source_type text:=coalesce(p_rate_card->>'sourceType','');
 v_source_reference text:=btrim(coalesce(p_rate_card->>'sourceReference',''));
 v_source_url text:=btrim(coalesce(p_rate_card->>'sourceUrl',''));
 v_source_fingerprint text:=lower(coalesce(p_rate_card->>'sourceFingerprint',''));
 v_status text:=coalesce(p_rate_card->>'verificationStatus','');
 v_dimensions jsonb:=coalesce(p_rate_card->'pricingDimensions','{}'::jsonb);
 v_input numeric; v_output numeric; v_image numeric; v_video numeric; v_render numeric;
 v_id uuid; v_actor_role text;
begin
 select role into v_actor_role from platform_admins where user_id=p_actor_id
  and role in('owner','platform_admin','billing_admin');
 if v_actor_role is null then raise exception 'Financial administrator access required' using errcode='42501'; end if;
 begin
  v_from:=(p_rate_card->>'effectiveFrom')::timestamptz;
  if nullif(p_rate_card->>'effectiveTo','') is not null then v_to:=(p_rate_card->>'effectiveTo')::timestamptz; end if;
  v_input:=nullif(p_rate_card->>'inputPerMillionMinor','')::numeric;
  v_output:=nullif(p_rate_card->>'outputPerMillionMinor','')::numeric;
  v_image:=nullif(p_rate_card->>'imageUnitMinor','')::numeric;
  v_video:=nullif(p_rate_card->>'videoSecondMinor','')::numeric;
  v_render:=nullif(p_rate_card->>'renderSecondMinor','')::numeric;
 exception when others then raise exception 'Invalid rate-card numeric or timestamp field' using errcode='22023'; end;
 if v_provider !~ '^[a-z0-9][a-z0-9._-]{1,79}$' or v_model='' or length(v_model)>160
  or v_currency !~ '^[A-Z]{3}$' or v_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$'
  or v_unit not in('tokens_per_million','image','video_second','render_second','request','frame','minute','character_block','mixed')
  or v_from is null or (v_to is not null and v_to<=v_from)
  or v_source_type not in('provider_pricing','provider_contract','admin_verified')
  or length(v_source_reference) not between 3 and 240
  or (v_source_url<>'' and v_source_url !~ '^https://')
  or v_source_fingerprint<>'' and v_source_fingerprint !~ '^[a-f0-9]{64}$'
  or v_status not in('source_linked','contract_attested','admin_attested')
  or jsonb_typeof(v_dimensions)<>'object'
  or (v_input is not null and v_input<0) or (v_output is not null and v_output<0)
  or (v_image is not null and v_image<0) or (v_video is not null and v_video<0)
  or (v_render is not null and v_render<0)
  or num_nonnulls(v_input,v_output,v_image,v_video,v_render)=0 then
  raise exception 'Invalid provider rate-card fields' using errcode='22023';
 end if;
 if v_source_type='provider_pricing' and (v_source_url='' or nullif(p_rate_card->>'sourceCheckedAt','') is null or v_status<>'source_linked') then
  raise exception 'Provider pricing requires an HTTPS source URL, check timestamp and source_linked status' using errcode='22023';
 end if;
 if v_source_type='provider_contract' and v_status<>'contract_attested' then
  raise exception 'Provider contract pricing requires contract_attested status' using errcode='22023';
 end if;
 if v_source_type='admin_verified' and v_status<>'admin_attested' then
  raise exception 'Admin-entered pricing requires admin_attested status' using errcode='22023';
 end if;
 -- Serialize overlap checks per provider/model/currency to prevent concurrent conflicting versions.
 perform pg_advisory_xact_lock(hashtextextended(v_provider||'|'||v_model||'|'||v_currency,0));
 if exists(select 1 from ai_model_price_catalog c where c.provider=v_provider and c.model=v_model and c.currency=v_currency
  and tstzrange(c.effective_from,coalesce(c.effective_to,'infinity'::timestamptz),'[)')
   && tstzrange(v_from,coalesce(v_to,'infinity'::timestamptz),'[)')) then
  raise exception 'Rate-card effective period overlaps an existing version' using errcode='23P01';
 end if;
 insert into ai_model_price_catalog(provider,model,currency,input_per_million_minor,output_per_million_minor,
  image_unit_minor,video_second_minor,render_second_minor,effective_from,effective_to,source_type,
  source_reference,recorded_by,rate_card_version,billing_unit,source_url,source_checked_at,
  source_fingerprint,verification_status,pricing_dimensions,supersedes_id)
 values(v_provider,v_model,v_currency,v_input,v_output,v_image,v_video,v_render,v_from,v_to,v_source_type,
  v_source_reference,p_actor_id,v_version,v_unit,v_source_url,
  nullif(p_rate_card->>'sourceCheckedAt','')::timestamptz,v_source_fingerprint,v_status,v_dimensions,
  nullif(p_rate_card->>'supersedesId','')::uuid)
 returning id into v_id;
 perform write_financial_admin_audit(p_actor_id,'finance.ai_model_rate_card.created',
  'ai_model_price_catalog',v_id::text,'Added immutable versioned AI model rate card',v_version,
  jsonb_build_object('provider',v_provider,'model',v_model,'currency',v_currency,
   'rateCardVersion',v_version,'billingUnit',v_unit,'verificationStatus',v_status,
   'effectiveFrom',v_from,'effectiveTo',v_to));
 return jsonb_build_object('id',v_id,'provider',v_provider,'model',v_model,'currency',v_currency,
  'rateCardVersion',v_version,'billingUnit',v_unit,'effectiveFrom',v_from,'effectiveTo',v_to,
  'sourceType',v_source_type,'sourceReference',v_source_reference,'sourceUrl',v_source_url,
  'sourceCheckedAt',nullif(p_rate_card->>'sourceCheckedAt',''),'sourceFingerprint',v_source_fingerprint,
  'verificationStatus',v_status,'pricingDimensions',v_dimensions,'supersedesId',nullif(p_rate_card->>'supersedesId',''));
end $$;

create or replace function executive_visuals.ai_model_price_rate_card_catalog(
 p_actor_id uuid,p_provider text default null,p_model text default null,p_currency text default null,p_limit integer default 200
) returns jsonb language plpgsql security definer set search_path=pg_catalog,executive_visuals,auth
as $$
declare v_cards jsonb;
begin
 if p_actor_id is null or not exists(select 1 from platform_admins where user_id=p_actor_id
  and role in('owner','platform_admin','billing_admin')) then
  raise exception 'Financial administrator access required' using errcode='42501';
 end if;
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'Invalid rate-card limit' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'provider',provider,'model',model,'currency',currency,
  'inputPerMillionMinor',input_per_million_minor,'outputPerMillionMinor',output_per_million_minor,
  'imageUnitMinor',image_unit_minor,'videoSecondMinor',video_second_minor,'renderSecondMinor',render_second_minor,
  'effectiveFrom',effective_from,'effectiveTo',effective_to,'rateCardVersion',rate_card_version,
  'billingUnit',billing_unit,'sourceType',source_type,'sourceReference',source_reference,
  'sourceUrl',source_url,'sourceCheckedAt',source_checked_at,'sourceFingerprint',source_fingerprint,
  'verificationStatus',verification_status,'pricingDimensions',pricing_dimensions,'supersedesId',supersedes_id
 ) order by provider,model,currency,effective_from desc),'[]'::jsonb)
 into v_cards from (
  select * from ai_model_price_catalog
  where (p_provider is null or provider=lower(p_provider))
   and (p_model is null or model=p_model) and (p_currency is null or currency=upper(p_currency))
  order by effective_from desc limit p_limit
 ) q;
 return jsonb_build_object('rateCards',v_cards,'count',jsonb_array_length(v_cards),
  'limitations',jsonb_build_array(
   'Legacy catalog entries remain marked legacy_unverified until reviewed.',
   'Source links and supplied fingerprints are evidence references, not independent proof of provider authenticity.',
   'Pricing dimensions outside the existing token, image, video-second and render-second usage fields are metadata until corresponding usage telemetry is available.'
  ));
end $$;

revoke all on function executive_visuals.add_ai_model_price_rate_card(uuid,jsonb) from public,anon,authenticated;
revoke all on function executive_visuals.ai_model_price_rate_card_catalog(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function executive_visuals.add_ai_model_price_rate_card(uuid,jsonb) to service_role;
grant execute on function executive_visuals.ai_model_price_rate_card_catalog(uuid,text,text,text,integer) to service_role;
