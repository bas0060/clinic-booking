import pg from "pg";

const max = process.env.AWS_LAMBDA_FUNCTION_NAME ? 2 : 10;

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max });

export const withTx = async (fn) => {
  const client = await pool.connect();
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
