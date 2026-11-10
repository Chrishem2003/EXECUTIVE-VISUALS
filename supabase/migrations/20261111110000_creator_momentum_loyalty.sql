-- Batch 14: transparent first-purchase welcome reward and customer loyalty foundation.
-- A verified first paid subscription receives one 30-day extension and configurable bonus credits.
-- The reward is one-time, idempotent, visible to the customer and never creates an automatic charge.

create table if not exists executive_visuals.customer_loyalty_campaigns(
 id uuid primary key default gen_random_uuid(),
 campaign_code text not null unique check(campaign_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
 name text not null check(char_length(name) between 2 and 100),
 description text not null default '',
 status text not null default 'active' check(status in ('draft','active','paused','ended')),
 reward_days integer not null default 30 check(reward_days between 0 and 90),
 bonus_credits bigint not null default 100 check(bonus_credits between 0 and 100000),
 starts_at timestamptz not null default now(),
 ends_at timestamptz,
 max_awards bigint not null default 1000000 check(max_awards>0),
 award_count bigint not null default 0 check(award_count>=0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(ends_at is null or ends_at>starts_at)
);

insert into executive_visuals.customer_loyalty_campaigns
 (campaign_code,name,description,status,reward_days,bonus_credits,starts_at)
values
 ('first_paid_creator_welcome','Creator Momentum Welcome Reward',
  'After your first verified paid subscription: 30 extra days on your purchased plan plus 100 bonus creator credits. No automatic renewal is created by this reward.',
  'active',30,100,now())
on conflict(campaign_code) do nothing;

create table if not exists executive_visuals.customer_loyalty_rewards(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 subscription_id uuid not null references executive_visuals.customer_subscriptions(id) on delete restrict,
 payment_transaction_id uuid not null references executive_visuals.payment_transactions(id) on delete restrict,
 campaign_id uuid not null references executive_visuals.customer_loyalty_campaigns(id) on delete restrict,
 reward_code text not null,
 granted_days integer not null check(granted_days between 0 and 90),
 bonus_credits bigint not null check(bonus_credits between 0 and 100000),
 original_period_end timestamptz not null,
 rewarded_period_end timestamptz not null,
 granted_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 unique(owner_id,reward_code),
 unique(payment_transaction_id,campaign_id),
 check(rewarded_period_end>=original_period_end)
);
create index if not exists customer_loyalty_rewards_owner_idx
 on executive_visuals.customer_loyalty_rewards(owner_id,granted_at desc);

create table if not exists executive_visuals.customer_loyalty_events(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 reward_id uuid references executive_visuals.customer_loyalty_rewards(id) on delete restrict,
 event_type text not null check(event_type in ('welcome_reward_granted','reward_expired','milestone_reached')),
 event_data jsonb not null default '{}'::jsonb check(jsonb_typeof(event_data)='object'),
 created_at timestamptz not null default now()
);
create index if not exists customer_loyalty_events_owner_idx
 on executive_visuals.customer_loyalty_events(owner_id,created_at desc);

create or replace function executive_visuals.grant_first_paid_creator_welcome_reward()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare
 payment_row executive_visuals.payment_transactions%rowtype;
 campaign_row executive_visuals.customer_loyalty_campaigns%rowtype;
 reward_row executive_visuals.customer_loyalty_rewards%rowtype;
 old_period_end timestamptz;
 new_period_end timestamptz;
 previous_paid_count bigint;
begin
 if old.status is distinct from 'pending' or new.status is distinct from 'active'
   or new.provider is distinct from 'flutterwave' then
  return new;
 end if;

 select * into payment_row
 from executive_visuals.payment_transactions p
 where p.owner_id=new.owner_id
  and p.status='successful'
  and p.metadata->>'payment_purpose'='subscription_purchase'
  and p.metadata->>'subscription_id'=new.id::text
 order by p.verified_at desc nulls last,p.created_at desc
 limit 1;
 if not found then return new; end if;

 select count(*) into previous_paid_count
 from executive_visuals.payment_transactions p
 where p.owner_id=new.owner_id
  and p.status='successful'
  and p.metadata->>'payment_purpose'='subscription_purchase'
  and p.id<>payment_row.id;
 if previous_paid_count>0 then return new; end if;

 select * into campaign_row
 from executive_visuals.customer_loyalty_campaigns c
 where c.campaign_code='first_paid_creator_welcome'
  and c.status='active'
  and now()>=c.starts_at
  and (c.ends_at is null or now()<c.ends_at)
  and c.award_count<c.max_awards
 for update;
 if not found then return new; end if;

 old_period_end:=new.current_period_end;
 new_period_end:=old_period_end+make_interval(days=>campaign_row.reward_days);
 new.current_period_end:=new_period_end;

 insert into executive_visuals.customer_loyalty_rewards(
  owner_id,subscription_id,payment_transaction_id,campaign_id,reward_code,
  granted_days,bonus_credits,original_period_end,rewarded_period_end
 ) values(
  new.owner_id,new.id,payment_row.id,campaign_row.id,'first_paid_creator_welcome',
  campaign_row.reward_days,campaign_row.bonus_credits,old_period_end,new_period_end
 )
 on conflict(owner_id,reward_code) do nothing
 returning * into reward_row;

 if reward_row.id is null then
  new.current_period_end:=old_period_end;
  return new;
 end if;

 if campaign_row.bonus_credits>0 then
  insert into executive_visuals.credit_ledger(
   owner_id,entry_type,credit_delta,idempotency_key,payment_transaction_id,reason,metadata
  ) values(
   new.owner_id,'purchase_grant',campaign_row.bonus_credits,
   'loyalty-welcome:'||reward_row.id::text,payment_row.id,
   'One-time Creator Momentum welcome reward after first verified paid subscription',
   jsonb_build_object('reward_id',reward_row.id,'campaign_code',campaign_row.campaign_code,
    'subscription_id',new.id,'bonus_credits',campaign_row.bonus_credits,
    'reward_days',campaign_row.reward_days,'rewarded_period_end',new_period_end)
  ) on conflict(owner_id,idempotency_key) do nothing;
 end if;

 update executive_visuals.customer_loyalty_campaigns
 set award_count=award_count+1,updated_at=now()
 where id=campaign_row.id;

 insert into executive_visuals.customer_loyalty_events(owner_id,reward_id,event_type,event_data)
 values(new.owner_id,reward_row.id,'welcome_reward_granted',
  jsonb_build_object('campaign_code',campaign_row.campaign_code,
   'reward_days',campaign_row.reward_days,'bonus_credits',campaign_row.bonus_credits,
   'original_period_end',old_period_end,'rewarded_period_end',new_period_end,
   'payment_transaction_id',payment_row.id));

 insert into executive_visuals.billing_notification_outbox(
  owner_id,notification_type,dedupe_key,payload,status
 ) values(
  new.owner_id,'loyalty.welcome_reward',
  'loyalty-welcome:'||reward_row.id::text,
  jsonb_build_object('rewardId',reward_row.id,'campaignName',campaign_row.name,
   'rewardDays',campaign_row.reward_days,'bonusCredits',campaign_row.bonus_credits,
   'periodEnd',new_period_end,
   'message','Your first paid subscription unlocked extra access time and bonus creator credits. No automatic renewal was added by this reward.'),
  'queued'
 ) on conflict(dedupe_key) do nothing;

 return new;
end $$;

drop trigger if exists customer_subscription_first_paid_welcome_reward on executive_visuals.customer_subscriptions;
create trigger customer_subscription_first_paid_welcome_reward
before update of status on executive_visuals.customer_subscriptions
for each row execute function executive_visuals.grant_first_paid_creator_welcome_reward();

revoke all on executive_visuals.customer_loyalty_campaigns from public,anon,authenticated;
revoke all on executive_visuals.customer_loyalty_rewards from public,anon,authenticated;
revoke all on executive_visuals.customer_loyalty_events from public,anon,authenticated;
grant select,insert,update on executive_visuals.customer_loyalty_campaigns to service_role;
grant select on executive_visuals.customer_loyalty_rewards,executive_visuals.customer_loyalty_events to service_role;
revoke delete,truncate on executive_visuals.customer_loyalty_campaigns,executive_visuals.customer_loyalty_rewards,executive_visuals.customer_loyalty_events from service_role;

create or replace function executive_visuals.customer_loyalty_summary(p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,executive_visuals
as $$
declare reward_rows jsonb; event_rows jsonb; credit_balance bigint;
begin
 if p_owner_id is null then raise exception 'Customer identity required' using errcode='22023'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.granted_at desc),'[]'::jsonb)
 into reward_rows from (
  select reward_code,granted_days,bonus_credits,original_period_end,rewarded_period_end,granted_at
  from customer_loyalty_rewards where owner_id=p_owner_id
  order by granted_at desc limit 20
 ) r;
 select coalesce(jsonb_agg(jsonb_build_object('eventType',e.event_type,'eventData',e.event_data,'createdAt',e.created_at)
  order by e.created_at desc),'[]'::jsonb)
 into event_rows from (
  select event_type,event_data,created_at from customer_loyalty_events
  where owner_id=p_owner_id order by created_at desc limit 50
 ) e;
 select coalesce(sum(credit_delta),0) into credit_balance
 from credit_ledger where owner_id=p_owner_id;
 return jsonb_build_object('rewards',reward_rows,'events',event_rows,'creditBalance',credit_balance);
end $$;

revoke all on function executive_visuals.customer_loyalty_summary(uuid) from public,anon,authenticated;
grant execute on function executive_visuals.customer_loyalty_summary(uuid) to service_role;
