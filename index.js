const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.app")
    ? { rejectUnauthorized: false }
    : false,
});

app.get("/", async (_req, res) => {
  res.json({
    ok: true,
    service: "CerebroTasks Server",
  });
});

app.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({
      ok: true,
      db: true,
      time: result.rows[0].now,
    });
  } catch (error) {
    res.status(500).json({ ok: false });
  }
});

app.get("/setup", async (_req, res) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      obsidian_note_path TEXT,
      obsidian_task_key TEXT,
      todoist_task_id TEXT UNIQUE,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      last_changed_by TEXT NOT NULL DEFAULT 'server',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Server running");
});
