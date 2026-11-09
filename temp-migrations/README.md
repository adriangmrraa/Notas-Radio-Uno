# temp-migrations — scripts de datos idempotentes

Scripts de backfill del cambio `live-creator-platform`. Son **idempotentes**
(guards `NOT EXISTS` / `ON CONFLICT DO NOTHING`) y pueden re-ejecutarse manualmente:

```bash
psql "$DATABASE_URL" -f temp-migrations/0008_backfill.sql
```

- `0008_backfill.sql` — user_tenants←users; persons(+photos, person_program,
  person_transmission)←conductors+guests; guest_dossiers.person_id;
  assets←clips+publications; tenant_quotas←usage_records;
  social_connections←business_assets+credenciales twitter. El mismo SQL corre
  una vez vía `drizzle-kit migrate` como `drizzle/0008_backfill.sql`.
