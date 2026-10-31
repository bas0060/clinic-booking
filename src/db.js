import pg from "pg";

// Cloudflare Workers can't reuse a connection across requests, so there each query gets its own.
export const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

// Serverless functions open many short-lived instances, so keep each pool small there.
const max = process.env.AWS_LAMBDA_FUNCTION_NAME ? 2 : 10;
const nodePool = onWorkers ? null : new pg.Pool({ connectionString: process.env.DATABASE_URL, max });

const openClient = async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
};

const connect = async () => {
  if (nodePool) return nodePool.connect();
  const client = await openClient();
  client.release = () => client.end().catch(() => {});
  return client;
};

export const pool = {
  connect,
  end: () => nodePool?.end(),
  query: async (text, params) => {
    if (nodePool) return nodePool.query(text, params);
    const client = await openClient();
    try {
      return await client.query(text, params);
    } finally {
      await client.end().catch(() => {});
    }
  },
};

export const withTx = async (fn) => {
  const client = await connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
