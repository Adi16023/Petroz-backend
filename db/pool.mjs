import pg from "pg";

export function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }
  return new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}
