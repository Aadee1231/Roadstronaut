# Deployment

ROADSTRONAUT deploys to Vercel as a Vite static app plus four Node.js serverless API routes. The browser bundle does not need Supabase credentials.

## 1. Create and configure Supabase

1. Create a Supabase project.
2. Run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) in the Supabase SQL Editor, or apply it with `supabase db push`.
3. In Project Settings → API, copy the project URL and the **service role** key. Keep the service role key private; it bypasses row-level security and belongs only in server environment variables.
4. Generate independent secrets:

   ```sh
   openssl rand -hex 32
   openssl rand -hex 32
   ```

   Use one for `RUN_TOKEN_SECRET` and the other for `IP_HASH_SALT`.

RLS is enabled on every application table. There are no anonymous table policies; only the server's service role is granted access.

## 2. Configure Vercel

1. Import the GitHub repository into Vercel.
2. Select the Vite framework preset. The checked-in configuration uses `npm run build`, publishes `dist`, and keeps `/api/*` on the serverless routes.
3. Add these variables in **Project → Settings → Environment Variables** for both Production and Preview:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
   | `RUN_TOKEN_SECRET` | First generated 32-byte secret |
   | `IP_HASH_SALT` | Second generated 32-byte secret |
   | `ALLOW_DEV_LEADERBOARD` | `0` |

   Do not prefix any of these with `VITE_`. Do not place the service role key in browser code, public build variables, or source control.
4. Deploy the project. Redeploy after changing environment variables.

## 3. Verify a deployment

1. Open `https://<your-domain>/api/leaderboard?period=all`. A configured deployment returns JSON with `"mode":"supabase"` and an empty `entries` array until a run has been saved.
2. Play a run through a crash. The game submits the input log for authoritative replay verification.
3. Confirm a row was written to the Supabase `scores` table and that the run appears at `/api/leaderboard?period=all`.
4. Check the Supabase `runs` row: accepted and rejected submissions are single-use.

If required database settings are absent in production, the API returns HTTP 503 with `leaderboard_not_configured`. The in-memory adapter is intentionally enabled only outside production or when `ALLOW_DEV_LEADERBOARD=1` is explicitly set; do not enable it for a public production deployment.

## Operations

The migration includes cleanup guidance for expired runs and old rate-limit buckets. Schedule those deletions if the database needs routine cleanup. Keep the Supabase service role key and both secrets private, rotate them through Vercel environment settings when needed, and redeploy after rotation.

The replay checks deter casual score tampering but are not a guarantee against offline bots, crafted logs, or anonymous identity resets. See the anti-cheat limitations in [README.md](README.md).
