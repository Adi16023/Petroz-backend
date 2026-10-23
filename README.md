# Petroz backend

Dealer desk API. One dealer, two outlets. Phone and password login returns a JWT. Reads are GET. Creates are POST, changes are PATCH, and removals are DELETE. Every route except login and `/health` requires `Authorization: Bearer <token>`.

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
6. `POST https://<service>.onrender.com/api/login` with the owner phone and password. Send the returned token as `Authorization: Bearer <token>` on every other `/api` call.

## Shift cashiers

- Creating or updating a shift requires at least one active cashier (`staff_type = cashier`, staff/manager role) from the outlet's dealer and outlet. Dealer-wide cashiers with no outlet restriction are allowed.
- Shift-linked document creation/updates and shift-entry saves reject missing, inactive, non-cashier, or cross-outlet assignments. An existing shift without cashiers must be edited to assign them before entry or closing.
- Shift-entry saves preserve the stored cashier assignments, not cashier IDs supplied in the entry payload. New shift-linked documents and entry saves validate the shift inside their database transaction before changing transactions or stock.
- Document list/detail responses include `cashierIds`, `cashierNames`, and `handledBy` for shift-linked records. All assigned cashiers are included; historical shifts with no assignment return `handledBy: "Unassigned cashier"`. Standalone documents retain their original shape.
- Shift-entry expense history exposes `paidBy` for the assigned cashiers and retains `by` as the actual creator. `createdBy`, `partyId`, `decidedBy`, and audit actors are never replaced with a cashier.

Run `npm test` for isolated regression tests; these tests do not connect to a database.

## Shift meter readings

Shift entry stores each nozzle's opening and closing separately. Shift details, reading lists, and reopened entries use that shift's saved values, not the nozzle's current meter. For older entries affected by identical opening/closing rows, reads recover the opening from the shift's saved `entry.meters` when available; no database rewrite is performed. New shifts carry forward the previous shift's closing reading.

## Fuel rates at shift closing

Closing an open shift (including direct shift-entry submission) checks the current fuel product prices in the database and recalculates that shift's non-cancelled `shift_fuel` lines and sale totals before closing, in one transaction. Test quantities remain excluded from billable litres. A missing or non-positive price blocks closure with an error. Lube sales, credit records, payment collections, and other shifts are unchanged.

Saving an open entry uses the current fuel product price and never writes a stale entry rate back to the product catalog. Closed entries retain their saved fuel rates when viewed later; approving an already closed shift does not apply newer prices. Reopening and closing a shift again deliberately checks prices again.
