-- Batch 15: creator-to-creator referrals with double-sided, verified-purchase rewards.
-- Rewards are ledger credits, never cash. Attribution closes at the referred customer's first paid purchase.

create table if not exists executive_visuals.customer_referral_program(
 id uuid primary key default gen_random_uuid(),
 program_code text not null unique,
 name text not null,
 status text not null default 'active' check(status in ('draft','active','paused','ended')),
 bonus_credits_per_side bigint not null default 50 check(bonus_credits_per_side between 0 and 10000),
 starts_at timestamptz not null default now(),
 ends_at timestamptz,
 max_conversions bigint not null default 100000 check(max_conversions>0),
 conversion_count bigint not null default 0 check(conversion_count>=0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(ends_at is null or ends_at>starts_at)
);
insert into executive_visuals.customer_referral_program(program_code,name,status,bonus_credits_per_side)
values('creator_circle','Creator Circle — Invite a Creator','active',50)
on conflict(program_code) do nothing;

create table if not exists executive_visuals.customer_referral_codes(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null unique references auth.users(id) on delete restrict,
 referral_code text not null unique check(referral_code ~ '^[A-Z0-9]{8,12}$'),
 status text not null default 'active' check(status in ('active','paused','revoked')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists executive_visuals.customer_referral_attributions(
 id uuid primary key default gen_random_uuid(),
 referred_owner_id uuid not null unique references auth.users(id) on delete restrict,
 referrer_owner_id uuid not null references auth.users(id) on delete restrict,
 referral_code_id uuid not null references executive_visuals.customer_referral_codes(id) on delete restrict,
 status text not null default 'pending' check(status in ('pending','converted','rejected')),
 attributed_at timestamptz not null default now(),
 converted_at timestamptz,
 created_at timestamptz not null default now(),
 check(referred_owner_id<>referrer_owner_id)
);
create index if not exists customer_referral_attributions_referrer_idx
 on executive_visuals.customer_referral_attributions(referrer_owner_id,status,attributed_at desc);
create table if not exists executive_visuals.customer_referral_rewards(
 id uuid primary key default gen_random_uuid(),
 referral_attribution_id uuid not null references executive_visuals.customer_referral_attributions(id) on delete restrict,
 beneficiary_owner_id uuid not null references auth.users(id) on delete restrict,
 reward_type text not null check(reward_type in ('referrer_bonus','referred_creator_bonus')),
 credit_units bigint not null check(credit_units between 0 and 10000),
 payment_transaction_id uuid not null references executive_visuals.payment_transactions(id) on delete restrict,
 granted_at timestamptz not null default now(),
 unique(referral_attribution_id,beneficiary_owner_id,reward_type)
);
create index if not exists customer_referral_rewards_beneficiary_idx
 on executive_visuals.customer_referral_rewards(beneficiary_owner_id,granted_at desc);

create or replace function executive_visuals.create_customer_referral_code(p_owner_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare code_row executive_visuals.customer_referral_codes%rowtype;
 candidate text;
begin
 if p_owner_id is null then raise exception 'Customer identity required' using errcode='22023'; end if;
 select * into code_row from customer_referral_codes where owner_id=p_owner_id;
 if found then return jsonb_build_object('code',code_row.referral_code,'status',code_row.status); end if;
 for attempt in 1..5 loop
  candidate:=upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  insert into customer_referral_codes(owner_id,referral_code)
  values(p_owner_id,candidate) on conflict do nothing
  returning * into code_row;
  if code_row.id is not null then
   return jsonb_build_object('code',code_row.referral_code,'status',code_row.status);
  end if;
  select * into code_row from customer_referral_codes where owner_id=p_owner_id;
  if found then return jsonb_build_object('code',code_row.referral_code,'status',code_row.status); end if;
 end loop;
 raise exception 'Could not create a unique referral code' using errcode='23505';
end $$;

create or replace function executive_visuals.attribute_customer_referral_code(p_referred_owner_id uuid,p_referral_code text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare code_row executive_visuals.customer_referral_codes%rowtype;
 attribution_row executive_visuals.customer_referral_attributions%rowtype;
begin
 if p_referred_owner_id is null or p_referral_code is null
  or p_referral_code !~ '^[A-Za-z0-9]{8,12}$' then
  raise exception 'A valid referral code is required' using errcode='22023';
 end if;
 select * into code_row from customer_referral_codes
 where referral_code=upper(p_referral_code) and status='active';
 if not found then raise exception 'Referral code is invalid or inactive' using errcode='P0002'; end if;
 if code_row.owner_id=p_referred_owner_id then
  raise exception 'Self-referrals are not allowed' using errcode='23514';
 end if;
 if exists(select 1 from payment_transactions p where p.owner_id=p_referred_owner_id
  and p.status='successful' and p.metadata->>'payment_purpose'='subscription_purchase') then
  raise exception 'Referral attribution must happen before the first paid subscription' using errcode='23514';
 end if;
 insert into customer_referral_attributions(referred_owner_id,referrer_owner_id,referral_code_id)
 values(p_referred_owner_id,code_row.owner_id,code_row.id)
 on conflict(referred_owner_id) do nothing
 returning * into attribution_row;
 if attribution_row.id is null then
  select * into attribution_row from customer_referral_attributions
   where referred_owner_id=p_referred_owner_id;
  if attribution_row.referrer_owner_id<>code_row.owner_id then
   raise exception 'A different referral code has already been attributed' using errcode='23505';
  end if;
 end if;
 return jsonb_build_object('attributed',true,'status',attribution_row.status,
  'referrerOwnerId',attribution_row.referrer_owner_id,'attributedAt',attribution_row.attributed_at);
end $$;

create or replace function executive_visuals.award_creator_referral_after_first_paid_subscription()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
 payment_row executive_visuals.payment_transactions%rowtype;
 attribution_row executive_visuals.customer_referral_attributions%rowtype;
 program_row executive_visuals.customer_referral_program%rowtype;
 reward_units bigint;
begin
 if old.status is distinct from 'pending' or new.status is distinct from 'active'
  or new.provider is distinct from 'flutterwave' then return new; end if;
 select * into payment_row from payment_transactions p
 where p.owner_id=new.owner_id and p.status='successful'
  and p.metadata->>'payment_purpose'='subscription_purchase'
  and p.metadata->>'subscription_id'=new.id::text
 order by p.verified_at desc nulls last,p.created_at desc limit 1;
 if not found then return new; end if;
 if exists(select 1 from payment_transactions p where p.owner_id=new.owner_id
  and p.status='successful' and p.metadata->>'payment_purpose'='subscription_purchase'
  and p.id<>payment_row.id) then return new; end if;
 select * into attribution_row from customer_referral_attributions
 where referred_owner_id=new.owner_id and status='pending' for update;
 if not found then return new; end if;
 select * into program_row from customer_referral_program
 where program_code='creator_circle' and status='active'
  and now()>=starts_at and (ends_at is null or now()<ends_at)
  and conversion_count<max_conversions for update;
 if not found then return new; end if;
 reward_units:=program_row.bonus_credits_per_side;
 if reward_units>0 then
  insert into customer_referral_rewards(referral_attribution_id,beneficiary_owner_id,reward_type,credit_units,payment_transaction_id)
  values(attribution_row.id,attribution_row.referrer_owner_id,'referrer_bonus',reward_units,payment_row.id),
        (attribution_row.id,attribution_row.referred_owner_id,'referred_creator_bonus',reward_units,payment_row.id)
  on conflict(referral_attribution_id,beneficiary_owner_id,reward_type) do nothing;
  insert into credit_ledger(owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata)
  values(attribution_row.referrer_owner_id,'purchase_grant',reward_units,
   'creator-referral:'||attribution_row.id::text||':referrer',payment_row.id,
   'Creator Circle referral reward after referred creator completed first verified paid subscription',
   jsonb_build_object('referral_id',attribution_row.id,'role','referrer','referred_owner_id',new.owner_id)),
  (attribution_row.referred_owner_id,'purchase_grant',reward_units,
   'creator-referral:'||attribution_row.id::text||':referred',payment_row.id,
   'Creator Circle welcome reward after first verified paid subscription using a creator referral',
   jsonb_build_object('referral_id',attribution_row.id,'role','referred_creator','referrer_owner_id',attribution_row.referrer_owner_id))
  on conflict(owner_id,idempotency_key) do nothing;
 end if;
 update customer_referral_attributions set status='converted',converted_at=now()
 where id=attribution_row.id;
 update customer_referral_program set conversion_count=conversion_count+1,updated_at=now()
 where id=program_row.id;
 insert into customer_loyalty_events(owner_id,event_type,event_data)
 values(attribution_row.referrer_owner_id,'milestone_reached',
  jsonb_build_object('milestone','creator_referral_converted','referral_id',attribution_row.id,'bonus_credits',reward_units)),
 (attribution_row.referred_owner_id,'milestone_reached',
  jsonb_build_object('milestone','joined_via_creator_referral','referral_id',attribution_row.id,'bonus_credits',reward_units));
 insert into billing_notification_outbox(owner_id,notification_type,dedupe_key,payload,status)
 values(attribution_row.referrer_owner_id,'referral.reward_granted','referral:'||attribution_row.id::text||':referrer',
  jsonb_build_object('message','A creator you invited subscribed. Your Creator Circle bonus credits have been added.','bonusCredits',reward_units),'queued'),
 (attribution_row.referred_owner_id,'referral.reward_granted','referral:'||attribution_row.id::text||':referred',
  jsonb_build_object('message','Your first subscription earned you Creator Circle bonus credits.','bonusCredits',reward_units),'queued')
 on conflict(dedupe_key) do nothing;
 return new;
end $$;

drop trigger if exists customer_subscription_creator_referral_reward on executive_visuals.customer_subscriptions;
create trigger customer_subscription_creator_referral_reward
after update of status on executive_visuals.customer_subscriptions
for each row execute function executive_visuals.award_creator_referral_after_first_paid_subscription();

create or replace function executive_visuals.customer_referral_summary(p_owner_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,executive_visuals
as $$
declare own_code jsonb; referral_rows jsonb; rewards_total bigint; program_offer jsonb;
begin
 own_code:=create_customer_referral_code(p_owner_id);
 select coalesce(jsonb_agg(jsonb_build_object('status',a.status,'attributedAt',a.attributed_at,'convertedAt',a.converted_at)
  order by a.attributed_at desc),'[]'::jsonb)
 into referral_rows from (
  select status,attributed_at,converted_at from customer_referral_attributions
  where referrer_owner_id=p_owner_id order by attributed_at desc limit 100
 ) a;
 select coalesce(sum(credit_units),0) into rewards_total from customer_referral_rewards
 where beneficiary_owner_id=p_owner_id;
 select jsonb_build_object('name',name,'bonusCreditsPerSide',bonus_credits_per_side)
 into program_offer from customer_referral_program
 where program_code='creator_circle' and status='active' and now()>=starts_at
  and (ends_at is null or now()<ends_at) and conversion_count<max_conversions
 order by created_at desc limit 1;
 return jsonb_build_object('code',own_code->>'code','codeStatus',own_code->>'status',
  'referrals',referral_rows,'rewardsEarned',rewards_total,'offer',program_offer);
end $$;

revoke all on executive_visuals.customer_referral_program,executive_visuals.customer_referral_codes,
 executive_visuals.customer_referral_attributions,executive_visuals.customer_referral_rewards from public,anon,authenticated;
grant select,insert,update on executive_visuals.customer_referral_program,executive_visuals.customer_referral_codes,
 executive_visuals.customer_referral_attributions,executive_visuals.customer_referral_rewards to service_role;
revoke delete,truncate on executive_visuals.customer_referral_program,executive_visuals.customer_referral_codes,
 executive_visuals.customer_referral_attributions,executive_visuals.customer_referral_rewards from service_role;

revoke all on function executive_visuals.create_customer_referral_code(uuid) from public,anon,authenticated;
revoke all on function executive_visuals.attribute_customer_referral_code(uuid,text) from public,anon,authenticated;
revoke all on function executive_visuals.customer_referral_summary(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.create_customer_referral_code(uuid) to service_role;
grant execute on function executive_visuals.attribute_customer_referral_code(uuid,text) to service_role;
grant execute on function executive_visuals.customer_referral_summary(uuid) to service_role;
