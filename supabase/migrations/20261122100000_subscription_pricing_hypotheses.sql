-- Proposed subscription price points are recorded as private draft hypotheses only.
-- No credits, provider prices, checkout eligibility or public visibility are activated.
-- Apply only to an isolated Executive Visuals database after the migration target is verified.

insert into executive_visuals.subscription_plans
  (plan_code,name,description,status,billing_interval,amount_minor,currency,
   included_credits,entitlements,is_public,version)
values
  ('starter_creator','Starter Creator',
   'Pricing hypothesis: USD 9/month. Draft only; credit allowance and entitlements require measured unit economics.',
   'draft','monthly',900,'USD',0,
   '{"catalog_state":"pricing_hypothesis","credits_pending_cost_validation":true,"commercial_use":"not_configured"}'::jsonb,
   false,1),
  ('professional_creator','Professional Creator',
   'Pricing hypothesis: USD 29/month. Draft only; credit allowance and entitlements require measured unit economics.',
   'draft','monthly',2900,'USD',0,
   '{"catalog_state":"pricing_hypothesis","credits_pending_cost_validation":true,"commercial_use":"not_configured"}'::jsonb,
   false,1),
  ('studio','Studio',
   'Pricing hypothesis: USD 79/month. Draft only; seat limits, credit allowance and entitlements require measured unit economics.',
   'draft','monthly',7900,'USD',0,
   '{"catalog_state":"pricing_hypothesis","credits_pending_cost_validation":true,"commercial_use":"not_configured"}'::jsonb,
   false,1),
  ('agency','Agency',
   'Pricing hypothesis: USD 199/month. Draft only; seat limits, credit allowance and entitlements require measured unit economics.',
   'draft','monthly',19900,'USD',0,
   '{"catalog_state":"pricing_hypothesis","credits_pending_cost_validation":true,"commercial_use":"not_configured"}'::jsonb,
   false,1),
  ('enterprise','Enterprise',
   'Custom commercial pricing hypothesis. Draft only; requires a negotiated contract and cost validation.',
   'draft','monthly',0,'USD',0,
   '{"catalog_state":"pricing_hypothesis","custom_contract_required":true,"credits_pending_cost_validation":true,"commercial_use":"not_configured"}'::jsonb,
   false,1)
on conflict (plan_code) do nothing;
