# Petroz backend

Database for the dealer desk. Fourteen tables, applied to Neon.

## Setup

1. Copy `.env.example` to `.env`.
2. Paste the Neon **direct** connection string into `DATABASE_URL`.
3. Install and migrate:

```bash
npm install
npm run db:migrate
npm run db:check
```

`db:migrate` creates the tables if they are not already there. It does not drop data.
