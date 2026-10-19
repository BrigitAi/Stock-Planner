# Brigit Stock Planner

Buying and branch-restock suggestions for Brigit, worked out from the Qlik **Stock Planning** report.

**Live app:** https://brigitai.github.io/Stock-Planner/ (Brigit login required)

```
Qlik Stock Planning report ──(n8n, per warehouse)──▶ Supabase (sp_* tables) ──▶ this app (GitHub Pages)
```

- **Buy (M1):** company-wide demand (sales in every warehouse) against stock in every warehouse plus open purchase orders. Local items are planned for 3 months' stock, foreign items for 6 months.
- **Branch restock:** JH01, CT01 and DN01 are restocked from M1 once a month, for one cycle plus transfer time (JH01 1 day, DN01 2 days, CT01 3 days) plus safety stock, from each branch's own sales.
- **Stock health:** stock above the maximum, stock with no sales in 12 months, and obsolete or on-hold stock with value.
- **Exceptions:** data problems that make a suggestion unreliable.
- **Min / max export:** the calculated levels per warehouse, ready for loading into SYSPRO later.

The repo holds only app code. All stock, cost and supplier data stays in Supabase behind the login, and only people listed in `sp_users` can see it.

## How the numbers are worked out (engine.js)

| Step | Rule |
|---|---|
| Use per month | Higher of the 6-month and 12-month average sales (setting), all planning warehouses together |
| Local / foreign | Item setting → supplier setting → Qlik *Planner* column → Buyer code (CP = local, CH = foreign, PRODUCTION / IN-BRANCH = in-house) |
| Lead time | Item setting → supplier setting → Qlik *Stock Lead Time (Days)* → default (30 local, 90 foreign, 14 in-house) |
| ABC class | Qlik *ABC Class* if present, otherwise by yearly usage value: top 80% = A, next 15% = B, rest = C |
| Safety stock | z(service level) × monthly variation × √(lead time in months). Service level A 99%, B 95%, C 90% |
| Minimum | use per month × lead time (months) + safety stock |
| Maximum | use per month × months of cover (3 local / 6 foreign) + safety stock |
| Position | available in all planning warehouses + open purchase orders (optionally − open sales orders) |
| Order | when position < minimum, order up to the maximum |
| Slow mover | sold in fewer than 3 of the last 12 months: not stocked, bought against customer orders |

All of these can be changed by an admin under **Settings**.

## Setup (once)

### 1. Supabase
1. Supabase → **SQL Editor** → New query → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**. It only adds `sp_*` tables and is safe to run again after updates.
2. Give the secret-key role a longer time limit, so n8n's imports aren't cut off at Supabase's default 8 seconds (SQL Editor):
   ```sql
   alter role service_role set statement_timeout = '120s';
   notify pgrst, 'reload config';
   ```
3. Supabase → **Authentication → URL Configuration → Redirect URLs** → add `https://brigitai.github.io/Stock-Planner/` (needed for password-reset links).
4. The first admins are added at the bottom of the script. Add buyers in the app under **Settings → Who can use the planner**.

### 2. n8n (Qlik → planner)
1. Supabase → **Project Settings → API Keys** → copy the **secret** key (`sb_secret_…`). Never put it in this repo.
2. n8n → **Credentials → New → Header Auth**: name `Brigit Supabase (secret key)`, header name `apikey`, value = the secret key.
3. n8n → **Workflows → Import from file** → [`n8n/stock-planner-load.json`](n8n/stock-planner-load.json). Open each of the three HTTP Request nodes and choose the credential from step 2. Save.
4. In the existing Qlik export workflow, after each warehouse file is exported, add an **Execute Workflow** node that calls *Stock Planner – load Qlik export*. It expects the Excel file in the binary property `data`.

Each load replaces the data for the warehouses in that file. Every branch file also contains the M1 rows, which is fine.

**Columns to add to the Qlik export** (picked up automatically once present): `Stock Lead Time (Days)`, `Planner`, `ABC Class`, and monthly `Issues Qty - MMM YYYY` (production use).

### 3. Loading by hand
Admins can drop the `STOCK PLANNING - <warehouse> - <date>.xlsx` files on the **Data** page.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The screens |
| `engine.js` | All the planning maths (no screen code, testable in Node) |
| `config.js` | Supabase address and publishable key (safe to be public) |
| `supabase/schema.sql` | Tables, access rules and the import functions |
| `n8n/stock-planner-load.json` | n8n sub-workflow: Qlik Excel file → Supabase |
