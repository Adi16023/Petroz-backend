# Petroz backend

Dealer desk API. One dealer, two outlets. Phone and password login returns a JWT. Reads are GET. Creates are POST, changes are PATCH, and removals are DELETE. Login, `/health`, and token-specific public bill reads are public; all private routes require a bearer token in the Authorization header.

On an empty database the server creates the tables, then one dealer (Whitefield and T. Nagar) and the owner login.

## Local

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` and `JWT_SECRET`.
3. `npm install` then `npm start`.

`POST /api/login` with `{ "phone": "9820011420", "password": "1142" }` unless those seed values were changed.

## Render

1. New Web Service from this repo. Runtime Node.
2. Build command: `npm install`
3. Start command: `npm start`
4. Environment variables: `DATABASE_URL` (Neon pooled URL), `JWT_SECRET` (a long random string).
5. Deploy. Open `https://<service>.onrender.com/health` — it returns `{ "ok": true }`.
6. `POST https://<service>.onrender.com/api/login` with the owner phone and password. Send the returned token in the Authorization header on private `/api` calls; public bill reads use only their unguessable bill token.

## Public QR bills

Run `npm run db:migrate` before deploying the updated frontend. Billing rows receive a unique cryptographically random `public_token`, a station snapshot, and optional `cancelled_at`. Existing rows are backfilled once; their original station metadata cannot be recovered if it changed before migration. New bills capture current station details on insert; later station edits do not change saved bills.

`GET /api/public/bills/:token` is intentionally registered before authentication. It returns only the named bill's customer/transaction details and station snapshot, not internal IDs, credentials, or access tokens. Responses are `no-store` and `noindex`. Possession of the unguessable 64-hex token grants read access with no login and no time expiry. Unknown, malformed, cancelled, or deleted bill links return 404.

Authenticated `PATCH /api/billing/:id/cancel` with `{ "outletId": "..." }` verifies outlet access and marks the bill cancelled, revoking public access immediately. Cancellation is idempotent and recorded in activity. The frontend disables print/share/download for cancelled bills and omits them from today's sales summary. Already downloaded copies cannot be recalled.

`node --test src/public-bills.test.mjs` validates migration reruns, token uniqueness, station snapshots, public response fields/headers, unauthenticated reads, protected cancellation, outlet isolation, and revocation using isolated in-memory PostgreSQL.

## Contacts

`contacts` stores all three directory tabs, distinguished by `tab` (`customers`, `business`, `logins`) and scoped by `outlet_id`. Migration creates an empty table; no sample records are inserted. Contacts remain separate from credit customers/users.

Owners and managers may use `GET /api/contacts?outletId=...`, `POST /api/contacts`, `PATCH /api/contacts/:id`, and `DELETE /api/contacts/:id?outletId=...`. Create/update bodies contain `outletId`, `tab`, `name`, `company`, `category`, `phone`, `email`, `website`, `username`, `password`, and `notes`. Updates replace the editable record; tab and outlet cannot be moved. All routes verify outlet access.

Website Login passwords are encrypted with AES-256-GCM using a random IV for each write, and decrypted only for authorized API responses with `Cache-Control: no-store`. By default, the backend derives a separate encryption key from the required `JWT_SECRET`, so no extra environment variable is needed. Keep `JWT_SECRET` stable across deployments and database restores; changing it makes saved passwords unreadable unless an explicit key is configured. An optional `CONTACTS_ENCRYPTION_KEY` can override the derived key and must be a persistent 64-character hex key. Changing the active key makes saved passwords unreadable.

Run `node --test src/contacts.test.mjs` for isolated contacts validation, encryption, and route tests.

## Shift cashiers

- Creating or updating a shift requires at least one active cashier (`staff_type = cashier`, staff/manager role) from the outlet's dealer and outlet. Dealer-wide cashiers with no outlet restriction are allowed.
- Shift-linked document creation/updates and shift-entry saves reject missing, inactive, non-cashier, or cross-outlet assignments. An existing shift without cashiers must be edited to assign them before entry or closing.
- Shift-entry saves preserve the stored cashier assignments, not cashier IDs supplied in the entry payload. New shift-linked documents and entry saves validate the shift inside their database transaction before changing transactions or stock.
- Document list/detail responses include `cashierIds`, `cashierNames`, and `handledBy` for shift-linked records. All assigned cashiers are included; historical shifts with no assignment return `handledBy: "Unassigned cashier"`. Standalone documents retain their original shape.
- Shift-entry expense history exposes `paidBy` for the assigned cashiers and retains `by` as the actual creator. `createdBy`, `partyId`, `decidedBy`, and audit actors are never replaced with a cashier.

Run `npm test` for isolated regression tests using mocks and in-memory PostgreSQL; these tests never connect to the configured live database.

## Shift cash received

`POST /api/shifts/:id/cash-receipts` accepts `id` (a client-generated UUID used for retry deduplication), `counts` (note quantities for `10`, `20`, `50`, `100`, `200`, `500` and a rupee-value `coins` amount), the currently displayed `cashTotal`, and `knownReceiptIds` (receipt IDs already included in that displayed total). It requires outlet access, a valid shift cashier assignment, and an owner, manager, staff, or super-admin session.

The backend validates denominations and calculates each receipt total itself. A transaction locks the shift, appends the receipt to `entry.cashReceipts`, adds it to the Cash total, updates expected/declared cash without changing shift status, and writes activity. The submitting user and timestamp are supplied by the server, not the client. A retry of the same ID and counts returns the saved result without adding cash again.

Entry GET/PUT responses include `cashReceipts`. Entry PUT bodies send `entry.cashReceiptIds` for receipts already included in `entry.totals.cash`. Stored receipts are preserved, never replaced by client-supplied log rows; receipts added by another session since loading are included once in the saved cash total. These logs are distinct from the editable `entry.cashCount` snapshot. No schema migration is required.

## DSR edit lock

A closed shift is read-only when a `documents` row of kind `dsr` is `locked` for the same outlet and any date covered by the shift, using Asia/Kolkata dates (including overnight shifts). Entry GET remains available and returns `shift.dsrLocked`. Shift entry saves, cash receipts, shift edits/deletion, and linked document writes reject locked closed shifts with HTTP 423 and an explicit unlock message. Open and upcoming shifts are unaffected, including their transition to closed; subsequent changes then follow the lock. Unlocking the DSR restores existing closed-shift editing without a migration.

## Shift meter readings

Shift entry stores each nozzle's opening and closing separately. Shift details, reading lists, and reopened entries use that shift's saved values, not the nozzle's current meter. For older entries affected by identical opening/closing rows, reads recover the opening from the shift's saved `entry.meters` when available; no meter-reading rewrite is performed.

Unsaved openings carry forward each nozzle's reading from the most recently **closed** shift in that outlet, ordered by actual `closed_at`, not scheduled start/end. A backdated late-night shift closed after a morning shift therefore supplies the next opening. Open/upcoming shifts and other outlets never supply this baseline. Saved openings remain unchanged. If no closed shift has a reading for that nozzle, the latest standalone closing or equipment meter is used.

The explicit Close Shift action records `closed_at`; entry saving and submission never change shift status, `closed_at`, or `closed_by`. Submission still posts the entry transactions and updates cash totals. Editing an already closed shift preserves its closure metadata, and reopening clears the timestamp so a later closure receives a new one. Deployment migration adds this column and recovers historical closure times from recognized closure activity, falling back to the last saved closing-reading timestamp when no closure event is available. That fallback is approximate for old records; future closures have explicit timestamps.

## Fuel rates at shift closing

Authentication tokens for every login role expire 12 hours after issuance. Authentication also enforces a maximum token age of 12 hours, so previously issued seven-day tokens cannot bypass the new limit. Activity does not renew the session; users must log in again.

### Daily lube/FMCG product prices

`npm run db:migrate` also installs `product_daily_prices` and a database trigger covering product creation and price updates from every write path. Both cost and selling price are saved atomically with the product change, keyed by product and IST business day. Multiple changes on one day replace that day's prices; earlier days are preserved, and unchanged prices carry forward. Product prices retain their existing dealer-wide scope.

Product list/detail responses include `priceHistory: [{ day, purchasePrice, sellingPrice }]`. The frontend uses the sale's document/business date to select daily cost for profit and the original transaction amount for revenue. This is daily costing, not inventory batch/FIFO costing. Migration seeds existing products with current prices at their creation day as an approximate baseline; missing historical price changes cannot be recovered. Re-running migration does not replace existing history. Deploy this migration before serving the updated product API. The migration/trigger tests run in an isolated PostgreSQL-compatible PGlite database, without accessing deployed data.

Closing an open shift through the separate Close Shift action checks the current fuel product prices in the database and recalculates that shift's non-cancelled `shift_fuel` lines and sale totals before closing, in one transaction. Entry submission also uses current prices but does not close the shift. Test quantities remain excluded from billable litres. A missing or non-positive price blocks closure with an error. Lube sales, credit records, payment collections, and other shifts are unchanged.

Saving an open entry uses the current fuel product price and never writes a stale entry rate back to the product catalog. Closed entries retain their saved fuel rates when viewed later; approving an already closed shift does not apply newer prices. Reopening and closing a shift again deliberately checks prices again.

Open and upcoming entry responses always use current product prices, not historical sale rates or timestamp-based guesses. Closing stores `entry.fuelRates` per nozzle, including assigned nozzles without sales. Closed-entry saves ignore client-supplied rates and retain these snapshots (or stored sale-line rates for older shifts). Product prices are locked during saving/closing so the saved rates and fuel sale amounts remain consistent.

Pump saves reuse existing active fuel products rather than creating a separate zero-priced product with the same name. Updating a fuel selling price also updates matching dealer fuel records (including regular Petrol/MS and Diesel/HSD aliases), so nozzles linked to older duplicate records receive the new price. Branded grades remain separate and closed shift snapshots are unchanged. For already divergent duplicate prices, re-save the intended rate after deploying this fix.
