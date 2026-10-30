// Black-box checks against a running API.
// Usage: BASE_URL=http://localhost:3000 API_KEY=... node tests/check.mjs
import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY;

const call = async (method, path, { body, headers = {}, key = KEY } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json };
};

const hour = 3600_000;
const inFuture = (h) => new Date(Date.now() + h * hour).toISOString().replace(/\.\d{3}Z$/, "Z");
const slot = (id, h, provider = "Dr Ade") => ({ id, provider, start: inFuture(h), end: inFuture(h + 0.5) });
const reset = (slots) => call("POST", "/reset", { body: { slots } });

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.log(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
};

await check("level 2: missing or wrong key returns 401", async () => {
  assert.equal((await call("GET", "/slots", { key: null })).status, 401);
  assert.equal((await call("GET", "/slots", { key: "nope" })).status, 401);
  assert.deepEqual((await call("GET", "/slots", { key: "nope" })).json, { error: "missing or invalid API key" });
});

await check("level 1: reset, list in order, provider filter, availability", async () => {
  const r = await reset([slot("b", 5), slot("a", 2), slot("c", 3, "Dr Bola"), slot("past", -2)]);
  assert.equal(r.status, 200);
  const all = (await call("GET", "/slots")).json.slots;
  assert.deepEqual(all.map((s) => s.id), ["past", "a", "c", "b"]);
  assert.ok(all.every((s) => s.available === true));
  assert.equal(all[1].start, slot("a", 2).start);
  const bola = (await call("GET", "/slots?provider=Dr%20Bola")).json.slots;
  assert.deepEqual(bola.map((s) => s.id), ["c"]);
});

await check("level 1+2: book, trim and lower-case, then fetch it", async () => {
  const res = await call("POST", "/bookings", { body: { slot_id: "a", name: "  Ada Obi ", email: "  ADA@Example.com " } });
  assert.equal(res.status, 201);
  assert.equal(res.json.status, "confirmed");
  assert.equal(res.json.name, "Ada Obi");
  assert.equal(res.json.email, "ada@example.com");
  const got = await call("GET", `/bookings/${res.json.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, res.json);
  assert.equal((await call("GET", "/slots")).json.slots.find((s) => s.id === "a").available, false);
  assert.equal((await call("GET", "/bookings/nope")).status, 404);
});

await check("level 2: validation errors", async () => {
  const bad = async (body, status) => assert.equal((await call("POST", "/bookings", { body })).status, status, JSON.stringify(body));
  await bad({ name: "A", email: "a1@x.com" }, 400);
  await bad({ slot_id: "b", name: "  ", email: "a2@x.com" }, 400);
  await bad({ slot_id: "b", name: "A", email: "" }, 400);
  await bad({ slot_id: "b", name: "A", email: "not-an-email" }, 400);
  await bad({ slot_id: "ghost", name: "A", email: "a3@x.com" }, 404);
  await bad({ slot_id: "past", name: "A", email: "a4@x.com" }, 400);
  assert.equal((await call("POST", "/bookings", { body: undefined })).status, 400);
});

await check("level 3: second booking of a taken slot is 409", async () => {
  const res = await call("POST", "/bookings", { body: { slot_id: "a", name: "Bayo", email: "bayo@x.com" } });
  assert.equal(res.status, 409);
});

await check("level 3: 40 simultaneous bookings, exactly one wins", async () => {
  await reset([slot("hot", 4)]);
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      call("POST", "/bookings", { body: { slot_id: "hot", name: `P${i}`, email: `p${i}@x.com` } })),
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(","));
  assert.equal(codes.filter((c) => c === 409).length, 39, codes.join(","));
});

await check("level 3: cancel frees the slot, second cancel is 409, unknown is 404", async () => {
  await reset([slot("s", 4)]);
  const b = (await call("POST", "/bookings", { body: { slot_id: "s", name: "C", email: "c@x.com" } })).json;
  const del = await call("DELETE", `/bookings/${b.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.status, "cancelled");
  assert.equal((await call("GET", "/slots")).json.slots[0].available, true);
  assert.equal((await call("DELETE", `/bookings/${b.id}`)).status, 409);
  assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
  const again = await call("POST", "/bookings", { body: { slot_id: "s", name: "D", email: "d@x.com" } });
  assert.equal(again.status, 201);
});

await check("level 4: idempotency replays, conflicts, and survives concurrency", async () => {
  await reset([slot("i1", 4), slot("i2", 5)]);
  const body = { slot_id: "i1", name: "Ife", email: "ife@x.com" };
  const h = { "Idempotency-Key": "key-1" };
  const first = await call("POST", "/bookings", { body, headers: h });
  const second = await call("POST", "/bookings", { body: { email: "ife@x.com", name: "Ife", slot_id: "i1" }, headers: h });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.json.id, first.json.id);
  const other = await call("POST", "/bookings", { body: { ...body, slot_id: "i2" }, headers: h });
  assert.equal(other.status, 422);
  const race = await Promise.all(Array.from({ length: 4 }, () =>
    call("POST", "/bookings", { body: { slot_id: "i2", name: "Ife", email: "race@x.com" }, headers: { "Idempotency-Key": "key-2" } })));
  assert.ok(race.every((r) => r.status === 201 && r.json.id === race[0].json.id));
  const list = (await call("GET", "/bookings?email=IFE@x.com")).json.bookings;
  assert.equal(list.length, 1);
});

await check("level 4: cursor pagination, oldest first, limit validation", async () => {
  await reset(Array.from({ length: 7 }, (_, i) => slot(`p${i}`, 10 + i)));
  for (let i = 0; i < 4; i++) await call("POST", "/bookings", { body: { slot_id: `p${i}`, name: "Pat", email: "pat@x.com" } });
  const p1 = (await call("GET", "/bookings?email=pat@x.com&limit=3")).json;
  assert.equal(p1.bookings.length, 3);
  assert.ok(p1.next_cursor);
  const p2 = (await call("GET", `/bookings?email=PAT@x.com&limit=3&cursor=${p1.next_cursor}`)).json;
  assert.equal(p2.bookings.length, 1);
  assert.equal(p2.next_cursor, null);
  assert.deepEqual([...p1.bookings, ...p2.bookings].map((b) => b.slot_id), ["p0", "p1", "p2", "p3"]);
  for (const limit of ["0", "51", "abc", "1.5", "-1"]) {
    assert.equal((await call("GET", `/bookings?email=pat@x.com&limit=${limit}`)).status, 400, `limit=${limit}`);
  }
  assert.equal((await call("GET", "/bookings?email=pat@x.com&limit=50")).status, 200);
  assert.equal((await call("GET", "/bookings")).status, 400);
});

await check("level 5: 6th attempt in a minute is 429 with Retry-After, others unaffected", async () => {
  await reset([slot("r", 4)]);
  const attempt = (email) => call("POST", "/bookings", { body: { slot_id: "r", name: "R", email } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await attempt("spam@x.com")).status);
  assert.deepEqual(codes, [201, 409, 409, 409, 409]);
  const sixth = await attempt("spam@x.com");
  assert.equal(sixth.status, 429);
  const wait = Number(sixth.headers.get("retry-after"));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, `Retry-After=${wait}`);
  assert.equal((await attempt("calm@x.com")).status, 409);
});

await check("level 5: 12 simultaneous attempts from one email admit only 5", async () => {
  await reset([slot("q", 4)]);
  const res = await Promise.all(Array.from({ length: 12 }, () =>
    call("POST", "/bookings", { body: { slot_id: "q", name: "Q", email: "burst@x.com" } })));
  assert.equal(res.filter((r) => r.status === 429).length, 7);
});

console.log(`\n${passed} checks passed`);
