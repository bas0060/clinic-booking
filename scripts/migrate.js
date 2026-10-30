import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const sql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
await pool.query(sql);
console.log("Schema is up to date.");
await pool.end();
