import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { onWorkers, pool, withTx } from "./db.js";

// Read per request: some hosts only expose environment variables once a request arrives.
const apiKey = () => process.env.API_KEY ?? "";
// import.meta.url is not a real file URL inside a Workers bundle, and static files are served by the platform there.
const publicDir = onWorkers ? "" : fileURLToPath(new URL("../public", import.meta.url));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_SECONDS = 60;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

const BOOKING_COLUMNS = "id, slot_id, name, email, status, created_at";

const fail = (res, status, message) => res.status(status).json({ error: message });
const outcome = (status, payload) => ({ status, payload });
const failure = (status, message) => outcome(status, { error: message });

const toBooking = (row) => ({
  id: row.id,
  slot_id: row.slot_id,
  name: row.name,
  email: row.email,
  status: row.status,
  created_at: row.created_at.toISOString(),
});

const keyMatches = (given) => {
  const expected = apiKey();
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const toIso = (value) => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

// Same JSON with keys in a different order must hash the same.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
const hashBody = (body) => createHash("sha256").update(canonical(body)).digest("hex");

const encodeCursor = (seq) => Buffer.from(String(seq)).toString("base64url");
const decodeCursor = (cursor) => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const text = Buffer.from(cursor, "base64url").toString();
  return /^\d{1,18}$/.test(text) ? text : null;
};

// Serialises work per name so concurrent requests with the same email or key line up.
const lock = (db, name) => db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);

// Records an attempt for this email. Returns 0 when allowed, or the seconds to wait.
const takeAttempt = (email) =>
  withTx(async (db) => {
    await lock(db, `rate:${email}`);
    await db.query(
      `DELETE FROM booking_attempts
       WHERE email = $1 AND created_at <= clock_timestamp() - make_interval(secs => $2)`,
      [email, ATTEMPT_WINDOW_SECONDS],
    );
    const { rows } = await db.query(
      `SELECT count(*)::int AS used,
              ceil(extract(epoch FROM (min(created_at) + make_interval(secs => $2) - clock_timestamp())))::int AS wait
       FROM booking_attempts WHERE email = $1`,
      [email, ATTEMPT_WINDOW_SECONDS],
    );
    if (rows[0].used >= ATTEMPT_LIMIT) return Math.max(1, rows[0].wait);
    await db.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
    return 0;
  });

const createBooking = async (db, body) => {
  const slotId = typeof body?.slot_id === "string" ? body.slot_id : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!slotId.trim()) return failure(400, "slot_id is required");
  if (!name) return failure(400, "name is required");
  if (!email) return failure(400, "email is required");
  if (!EMAIL_PATTERN.test(email)) return failure(400, "email is not valid");

  const { rows: slots } = await db.query("SELECT start_at FROM slots WHERE id = $1", [slotId]);
  if (!slots[0]) return failure(404, "slot not found");
  if (slots[0].start_at <= new Date()) return failure(400, "slot has already started");

  const { rows } = await db.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING ${BOOKING_COLUMNS}`,
    [randomUUID(), slotId, name, email],
  );
  if (!rows[0]) return failure(409, "slot is already booked");
  return outcome(201, toBooking(rows[0]));
};

const app = express();
app.disable("x-powered-by");

// When served as a Netlify function the path may arrive with the function prefix.
app.use((req, _res, next) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|\?|$)/, "") || "/";
  next();
});

// The web page and its config are public; the API itself is not.
if (!onWorkers) app.use(express.static(publicDir)); // on Workers, the platform serves static files
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(`window.CLINIC_API_KEY = ${JSON.stringify(apiKey())};\n`);
});

app.use((req, res, next) => {
  if (!keyMatches(req.get("X-API-Key"))) return fail(res, 401, "missing or invalid API key");
  next();
});
app.use(express.json());

app.post("/reset", async (req, res) => {
  const slots = req.body?.slots;
  if (!Array.isArray(slots)) return fail(res, 400, "slots must be an array");

  const cols = { id: [], provider: [], startRaw: [], endRaw: [], startAt: [], endAt: [] };
  for (const slot of slots) {
    const startAt = toIso(slot?.start);
    const endAt = toIso(slot?.end);
    const valid =
      typeof slot?.id === "string" && slot.id.trim() !== "" &&
      typeof slot?.provider === "string" && startAt && endAt;
    if (!valid) return fail(res, 400, "each slot needs id, provider, start and end");
    cols.id.push(slot.id);
    cols.provider.push(slot.provider);
    cols.startRaw.push(slot.start);
    cols.endRaw.push(slot.end);
    cols.startAt.push(startAt);
    cols.endAt.push(endAt);
  }

  await withTx(async (db) => {
    await db.query("DELETE FROM bookings");
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM booking_attempts");
    await db.query("DELETE FROM slots");
    if (cols.id.length === 0) return;
    await db.query(
      `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])
       ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, start_raw = EXCLUDED.start_raw,
         end_raw = EXCLUDED.end_raw, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at`,
      [cols.id, cols.provider, cols.startRaw, cols.endRaw, cols.startAt, cols.endAt],
    );
  });
  res.json({ ok: true, slots: cols.id.length });
});

app.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
     FROM slots s
     WHERE ($1::text IS NULL OR s.provider = $1)
     ORDER BY s.start_at, s.id`,
    [provider],
  );
  res.json({ slots: rows });
});

app.post("/bookings", async (req, res) => {
  const body = req.body;

  const emailKey = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (emailKey) {
    const wait = await takeAttempt(emailKey);
    if (wait > 0) {
      res.set("Retry-After", String(wait));
      return fail(res, 429, "too many booking attempts for this email, try again shortly");
    }
  }

  const idempotencyKey = req.get("Idempotency-Key");
  const result = await withTx(async (db) => {
    if (!idempotencyKey) return createBooking(db, body);

    await lock(db, `idem:${idempotencyKey}`);
    const bodyHash = hashBody(body);
    const { rows } = await db.query(
      "SELECT body_hash, status_code, response FROM idempotency_keys WHERE key = $1",
      [idempotencyKey],
    );
    if (rows[0]) {
      if (rows[0].body_hash !== bodyHash) {
        return failure(422, "Idempotency-Key was already used with a different request body");
      }
      return outcome(rows[0].status_code, rows[0].response);
    }

    const created = await createBooking(db, body);
    await db.query(
      "INSERT INTO idempotency_keys (key, body_hash, status_code, response) VALUES ($1, $2, $3, $4)",
      [idempotencyKey, bodyHash, created.status, JSON.stringify(created.payload)],
    );
    return created;
  });
  res.status(result.status).json(result.payload);
});

app.get("/bookings", async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) return fail(res, 400, "email is required");

  const { limit: rawLimit, cursor: rawCursor } = req.query;
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== undefined) {
    const valid = typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit);
    limit = valid ? Number(rawLimit) : 0;
    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      return fail(res, 400, `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
    }
  }

  let after = "0";
  if (rawCursor !== undefined && rawCursor !== "") {
    after = typeof rawCursor === "string" ? decodeCursor(rawCursor) : null;
    if (after === null) return fail(res, 400, "cursor is not valid");
  }

  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLUMNS}, seq FROM bookings
     WHERE email = $1 AND seq > $2
     ORDER BY seq LIMIT $3`,
    [email, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  res.json({ bookings: page.map(toBooking), next_cursor: nextCursor });
});

app.get("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return fail(res, 404, "booking not found");
  res.json(toBooking(rows[0]));
});

app.delete("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING ${BOOKING_COLUMNS}`,
    [req.params.id],
  );
  if (rows[0]) return res.json(toBooking(rows[0]));

  const { rowCount } = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
  if (rowCount) return fail(res, 409, "booking is already cancelled");
  fail(res, 404, "booking not found");
});

app.use((_req, res) => fail(res, 404, "not found"));

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return fail(res, 400, "request body is not valid JSON");
  console.error(err);
  fail(res, 500, "internal error");
});

export default app;
