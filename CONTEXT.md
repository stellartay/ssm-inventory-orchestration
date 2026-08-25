├── CONTEXT.md
├── api/
│   ├── reserve.ts
│   ├── fulfill.ts
│   ├── cancel.ts
│   └── availability-sync.ts
├── lib/
│   ├── zoho.ts          # cliente + refresh com lock
│   ├── jira.ts          # criar child, comentar, editar field description
│   ├── db.ts            # Supabase
│   └── hmac.ts
├── supabase/migrations/
│   └── 0001_init.sql
├── scripts/seed-item-map.ts
├── .env.example
└── vercel.json          # cron + region EU