import pg from "pg";

const url = process.env.DATABASE_URL;

export function createPool() {
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }
  return new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}
