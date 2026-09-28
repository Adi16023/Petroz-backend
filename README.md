# Petroz backend

Dealer desk API. One dealer, two outlets. Phone and password login returns a JWT. The other routes are GET and require `Authorization: Bearer <token>`.

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
