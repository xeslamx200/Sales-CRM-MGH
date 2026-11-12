# Deploying to Vercel (Frankfurt) with a permanent WhatsApp webhook

1. Project: `sales-crm-mgh` on Vercel (created with `npx vercel link`); region `fra1` and the 60 s function limit are in `vercel.json`
   (the database is in Frankfurt too, so each query takes ~2 ms instead of ~200 ms from outside Europe).
2. Variables + first deployment: `powershell -ExecutionPolicy Bypass -File scripts\deploy\vercel-setup.ps1` (reads `.env.local`, never prints values).
3. Check: `https://<project>.vercel.app/api/health` answers 200; a POST to `/api/webhooks/kapso` without a signature answers 401.
4. Kapso: set the endpoint of the webhook of EVERY real number to `https://<project>.vercel.app/api/webhooks/kapso` (same signing secret,
   payload v2). The address never changes, so the temporary tunnel and the local filter are no longer needed.
5. Supabase (Authentication > URL configuration): Site URL = the app address; add `https://<project>.vercel.app/**` to the redirect URLs.
6. Scheduled jobs run inside the database (pg_cron), not on Vercel.
7. A custom domain (e.g. crm.example.com): Vercel > Domains, add the DNS records it shows at the domain registrar, then set `APP_URL` to it and redeploy.
