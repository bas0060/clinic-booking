# Clinic booking API

Express + Postgres API for booking clinic appointment slots, with a small patient-facing web page.
The page is served by the same app, so there is one repo and one URL.

## Endpoints

All requests need an `X-API-Key` header. Errors are always `{"error": "<message>"}`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/reset` | Replace all slots (clears bookings) |
| GET | `/slots` | Earliest first, optional `?provider=` |
| POST | `/bookings` | 201, 400, 404, 409, 422, 429. Optional `Idempotency-Key` |
| GET | `/bookings?email=` | Cursor pagination: `limit` (1-50), `cursor`, `next_cursor` |
| GET | `/bookings/:id` | |
| DELETE | `/bookings/:id` | Cancels and frees the slot |

## How the hard parts work

- **No double booking.** A partial unique index (`slot_id WHERE status = 'confirmed'`) lets Postgres decide.
  The insert uses `ON CONFLICT DO NOTHING`, so the loser of a race gets a 409 instead of an error.
- **Idempotency.** Each key is stored with a hash of the request body and the response. A repeat returns the stored
  response; a different body returns 422. A per-key advisory lock makes simultaneous retries safe.
- **Rate limit.** Attempts are recorded per email (failed ones too) and counted over the last 60 seconds.
  A per-email advisory lock keeps concurrent requests from slipping past the limit of 5.
  Rejected requests are not recorded, and `Retry-After` is the seconds until the oldest attempt expires.
- **Stateless server.** Everything lives in Postgres, so it works on serverless hosts too.

## Run locally

```bash
npm install
cp .env.example .env      # set DATABASE_URL and API_KEY
npm run migrate           # creates the tables
npm run dev
BASE_URL=http://localhost:3000 API_KEY=your-key node tests/check.mjs
```

## Deploy

**Netlify:** import the repo (publish dir `public`, functions `netlify/functions` come from `netlify.toml`),
then set `DATABASE_URL` and `API_KEY` in Site settings, Environment variables.
**Render:** build `npm install`, start `npm start`, same two environment variables.
Run `npm run migrate` once against the production database (or paste `schema.sql` into the Neon SQL editor).

## Note on the web page

`/config.js` hands the API key to the page so it can call the API. That is fine for this exercise, but a browser app
can't keep a key secret. A production version would put a login or a server-side proxy in front.
