# Paddle / Pesapal staging database acceptance

The provider migration `20261121120000_paddle_pesapal_provider_billing.sql` was applied to the connected Executive Visuals staging database after checking all referenced financial tables existed and contained no incompatible provider values.

Run the manual `Paddle Pesapal staging database acceptance` workflow using staging-only secret `SUPABASE_STAGING_DB_URL`.

The SQL verifies:
- provider price table exists and has RLS enabled;
- anon/authenticated roles cannot directly read or insert provider price rows;
- service_role has the intended administrative privileges;
- all seven provider billing RPCs exist, are executable by service_role and not executable by anon/authenticated;
- no provider prices are active or configured and no Paddle/Pesapal subscriptions exist.

This does not create provider price rows, activate checkout, make a provider API request, charge a customer, or enable live mode. Real sandbox merchant credentials, price configuration, checkout, webhook/IPN replay and reconciliation still need separate acceptance. Keep `PADDLE_ALLOW_LIVE=false`, `PESAPAL_ALLOW_LIVE=false`, and `PADDLE_PESAPAL_BILLING_ENABLED=false` until the full sandbox test matrix is signed off.
