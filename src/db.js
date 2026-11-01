import pg from "pg";
import { neon } from "@neondatabase/serverless";

export const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

const nodePool = onWorkers ? null : new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.AWS_LAMBDA_FUNCTION_NAME ? 2 : 10,
});

const neonQuery = onWorkers ? neon(process.env.DATABASE_URL) : null;

const openClient = async () => {
  if (neonQuery) {
    return {
      query: async (text, params = []) => {
        if (/pg_advisory_xact_lock/i.test(text)) {
          return { rows: [{ locked: true }] };
        }
        if (/^\s*BEGIN\b/i.test(text) || /^\s*COMMIT\b/i.test(text) || /^\s*ROLLBACK\b/i.test(text)) {
          return { rows: [] };
        }
        const rows = await neonQuery.query(text, params);
        return { rows };
      },
      release() {},
    };
  }
  const client = await nodePool.connect();
  return client;
};

const connect = async () => {
  if (nodePool) return nodePool.connect();
  return openClient();
};

export const pool = {
  connect,
  end: () => nodePool?.end(),
  query: async (text, params) => {
    if (nodePool) return nodePool.query(text, params);
    const rows = await neonQuery.query(text, params);
    return { rows };
  },
};

export const withTx = async (fn) => {
  const client = await connect();
  try {
    if (!onWorkers) await client.query("BEGIN");
    const result = await fn(client);
    if (!onWorkers) await client.query("COMMIT");
    return result;
  } catch (err) {
    if (!onWorkers) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
