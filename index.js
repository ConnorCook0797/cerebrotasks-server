const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const crypto = require("crypto");

dotenv.config();

const app = express();

app.use((req, res, next) => {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { data += chunk; });
  req.on("end", () => {
    req.rawBody = data || "";
    if (req.rawBody) {
      try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; }
    } else {
      req.body = {};
    }
    next();
  });
});

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const APP_BASE_URL = process.env.APP_BASE_URL;
const TODOIST_CLIENT_ID = process.env.TODOIST_CLIENT_ID;
const TODOIST_CLIENT_SECRET = process.env.TODOIST_CLIENT_SECRET;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

async function getIntegration(provider = "todoist") {
  const result = await pool.query(
    "SELECT * FROM integrations WHERE provider = $1 LIMIT 1",
    [provider]
  );
  return result.rows[0] || null;
}

async function upsertIntegration({ provider = "todoist", access_token, token_type = "Bearer", scope = "", user_id = null }) {
  const result = await pool.query(
    `
    INSERT INTO integrations (provider, access_token, token_type, scope, external_user_id, connected_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (provider)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      token_type = EXCLUDED.token_type,
      scope = EXCLUDED.scope,
      external_user_id = EXCLUDED.external_user_id,
      updated_at = NOW()
    RETURNING *
    `,
    [provider, access_token, token_type, scope, user_id]
  );
  return result.rows[0];
}

async function createTodoistTask(content) {
  const integration = await getIntegration("todoist");
  if (!integration?.access_token) {
    throw new Error("Todoist is not connected yet");
  }

  const response = await fetch("https://api.todoist.com/api/v1/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${integration.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content
    })
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function verifyTodoistWebhook(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

app.get("/", async (_req, res) => {
  res.json({ ok: true, service: "CerebroTasks Server", version: "1.2.1" });
});

app.get("/health", async (_req, res) => {
  if (!DATABASE_URL) return jsonError(res, 500, "DATABASE_URL is not set");
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: true, time: result.rows[0].now });
  } catch (error) {
    console.error("Health check DB error:", error);
    jsonError(res, 500, "Database connection failed");
  }
});

app.get("/setup", async (_req, res) => {
  if (!DATABASE_URL) return jsonError(res, 500, "DATABASE_URL is not set");
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        origin TEXT NOT NULL DEFAULT 'server',
        last_changed_by TEXT NOT NULL DEFAULT 'server',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        external_id TEXT,
        obsidian_note_path TEXT,
        obsidian_task_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_type, external_id),
        UNIQUE (source_type, obsidian_note_path, obsidian_task_key)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS integrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL UNIQUE,
        access_token TEXT,
        token_type TEXT,
        scope TEXT,
        external_user_id TEXT,
        connected_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    res.json({ ok: true, message: "Database setup complete" });
  } catch (error) {
    console.error("Setup error:", error);
    jsonError(res, 500, "Failed to create tables");
  }
});

app.get("/todoist/status", async (_req, res) => {
  try {
    const integration = await getIntegration("todoist");
    res.json({
      ok: true,
      connected: !!integration?.access_token,
      provider: "todoist",
      integration: integration ? {
        provider: integration.provider,
        scope: integration.scope,
        external_user_id: integration.external_user_id,
        connected_at: integration.connected_at,
        updated_at: integration.updated_at
      } : null
    });
  } catch (error) {
    console.error("Todoist status error:", error);
    jsonError(res, 500, "Failed to check Todoist status");
  }
});

app.get("/todoist/connect", async (_req, res) => {
  if (!TODOIST_CLIENT_ID || !APP_BASE_URL) {
    return jsonError(res, 500, "TODOIST_CLIENT_ID or APP_BASE_URL is missing");
  }

  const redirectUri = `${APP_BASE_URL}/todoist/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: TODOIST_CLIENT_ID,
    scope: "data:read_write,data:delete",
    state,
    redirect_uri: redirectUri
  });

  res.redirect(`https://app.todoist.com/oauth/authorize?${params.toString()}`);
});

app.get("/todoist/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return jsonError(res, 400, `Todoist OAuth error: ${error}`);
  }

  if (!code) {
    return jsonError(res, 400, "Missing Todoist OAuth code");
  }

  if (!TODOIST_CLIENT_ID || !TODOIST_CLIENT_SECRET || !APP_BASE_URL) {
    return jsonError(res, 500, "Missing Todoist app environment variables");
  }

  try {
    const redirectUri = `${APP_BASE_URL}/todoist/callback`;

    const tokenResponse = await fetch("https://api.todoist.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TODOIST_CLIENT_ID,
        client_secret: TODOIST_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Todoist token exchange failed:", tokenData);
      return jsonError(res, 500, "Todoist token exchange failed", { details: tokenData });
    }

    await upsertIntegration({
      provider: "todoist",
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || "Bearer",
      scope: tokenData.scope || "",
      user_id: tokenData.user_id ? String(tokenData.user_id) : null
    });

    res.json({ ok: true, message: "Todoist connected successfully" });
  } catch (err) {
    console.error("Todoist callback error:", err);
    jsonError(res, 500, "Failed to complete Todoist OAuth");
  }
});

app.post("/todoist/create-task", async (req, res) => {
  const { title, completed = false } = req.body;

  if (!title) {
    return jsonError(res, 400, "Missing title");
  }

  try {
    const todoistResult = await createTodoistTask(title);

    if (!todoistResult.ok || !todoistResult.data?.id) {
      return jsonError(res, 500, "Todoist task creation failed", {
        details: todoistResult.data
      });
    }

    const insertedTask = await pool.query(
      `
      INSERT INTO tasks (title, completed, deleted, origin, last_changed_by)
      VALUES ($1, $2, FALSE, 'server', 'server')
      RETURNING *
      `,
      [title, completed]
    );

    const task = insertedTask.rows[0];

    await pool.query(
      `
      INSERT INTO task_links (task_id, source_type, external_id)
      VALUES ($1, 'todoist', $2)
      `,
      [task.id, String(todoistResult.data.id)]
    );

    await pool.query(
      `
      INSERT INTO task_events (task_id, source, event_type, payload)
      VALUES ($1, 'server', 'todoist_task_created', $2)
      `,
      [task.id, { todoist: todoistResult.data }]
    );

    res.json({
      ok: true,
      task,
      todoist_task: todoistResult.data
    });
  } catch (error) {
    console.error("Create Todoist task error:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to create Todoist task",
      details: error?.message || String(error),
      stack: error?.stack || null
    });
  }
});

app.post("/todoist/webhook", async (req, res) => {
  try {
    const signatureHeader = req.headers["x-todoist-hmac-sha256"];
    if (TODOIST_CLIENT_SECRET) {
      const valid = verifyTodoistWebhook(req.rawBody, signatureHeader, TODOIST_CLIENT_SECRET);
      if (!valid) return jsonError(res, 401, "Invalid webhook signature");
    }

    const payload = req.body || {};
    const eventName = payload.event_name || "unknown";
    const eventData = payload.event_data || {};
    const todoistTaskId = eventData.id ? String(eventData.id) : null;
    let taskId = null;

    if (todoistTaskId) {
      const link = await pool.query(
        "SELECT task_id FROM task_links WHERE source_type = 'todoist' AND external_id = $1 LIMIT 1",
        [todoistTaskId]
      );
      taskId = link.rows[0]?.task_id || null;
    }

    if (eventName === "item:added" && todoistTaskId && !taskId) {
      const title = String(eventData.content || "Untitled Task").trim() || "Untitled Task";
      const insertedTask = await pool.query(
        "INSERT INTO tasks (title, completed, deleted, origin, last_changed_by) VALUES ($1, FALSE, FALSE, 'todoist', 'todoist') RETURNING *",
        [title]
      );
      taskId = insertedTask.rows[0].id;

      await pool.query(
        "INSERT INTO task_links (task_id, source_type, external_id) VALUES ($1, 'todoist', $2) ON CONFLICT (source_type, external_id) DO NOTHING",
        [taskId, todoistTaskId]
      );
    }

    if (taskId) {
      if (eventName === "item:updated") {
        await pool.query(
          "UPDATE tasks SET title = COALESCE($1, title), last_changed_by = 'todoist', updated_at = NOW() WHERE id = $2",
          [eventData.content || null, taskId]
        );
      }

      if (eventName === "item:completed") {
        await pool.query(
          "UPDATE tasks SET completed = TRUE, last_changed_by = 'todoist', updated_at = NOW() WHERE id = $1",
          [taskId]
        );
      }

      if (eventName === "item:uncompleted") {
        await pool.query(
          "UPDATE tasks SET completed = FALSE, last_changed_by = 'todoist', updated_at = NOW() WHERE id = $1",
          [taskId]
        );
      }

      if (eventName === "item:deleted") {
        await pool.query(
          "UPDATE tasks SET deleted = TRUE, last_changed_by = 'todoist', updated_at = NOW() WHERE id = $1",
          [taskId]
        );
      }

      await pool.query(
        "INSERT INTO task_events (task_id, source, event_type, payload) VALUES ($1, 'todoist', $2, $3)",
        [taskId, eventName, payload]
      );
    }

    res.status(200).json({ ok: true, event: eventName });
  } catch (error) {
    console.error("Todoist webhook error:", error);
    jsonError(res, 500, "Failed to process Todoist webhook");
  }
});

app.post("/obsidian/task-change", async (req, res) => {
  const { obsidian_note_path, obsidian_task_key, title, completed = false } = req.body;
  if (!obsidian_note_path || !obsidian_task_key || !title) {
    return jsonError(res, 400, "Missing required fields");
  }

  try {
    const linkResult = await pool.query(
      `
      SELECT tl.task_id
      FROM task_links tl
      WHERE tl.source_type = 'obsidian'
        AND tl.obsidian_note_path = $1
        AND tl.obsidian_task_key = $2
      LIMIT 1
      `,
      [obsidian_note_path, obsidian_task_key]
    );

    let task;
    if (linkResult.rows.length > 0) {
      const existingTaskId = linkResult.rows[0].task_id;
      const updateResult = await pool.query(
        `
        UPDATE tasks
        SET title = $1,
            completed = $2,
            deleted = FALSE,
            last_changed_by = 'obsidian',
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
        `,
        [title, completed, existingTaskId]
      );
      task = updateResult.rows[0];
    } else {
      const inserted = await pool.query(
        `
        INSERT INTO tasks (title, completed, deleted, origin, last_changed_by)
        VALUES ($1, $2, FALSE, 'obsidian', 'obsidian')
        RETURNING *
        `,
        [title, completed]
      );
      task = inserted.rows[0];
      await pool.query(
        `
        INSERT INTO task_links (task_id, source_type, obsidian_note_path, obsidian_task_key)
        VALUES ($1, 'obsidian', $2, $3)
        `,
        [task.id, obsidian_note_path, obsidian_task_key]
      );
    }

    await pool.query(
      "INSERT INTO task_events (task_id, source, event_type, payload) VALUES ($1, 'obsidian', 'task_change', $2)",
      [task.id, req.body]
    );

    res.json({ ok: true, task });
  } catch (error) {
    console.error("Obsidian task change error:", error);
    jsonError(res, 500, "Failed to process task change");
  }
});

app.get("/obsidian/changes", async (req, res) => {
  const since = req.query.since || null;
  try {
    const result = since
      ? await pool.query("SELECT * FROM tasks WHERE updated_at > $1 ORDER BY updated_at ASC", [since])
      : await pool.query("SELECT * FROM tasks ORDER BY updated_at ASC LIMIT 200");
    res.json({ ok: true, tasks: result.rows });
  } catch (error) {
    console.error("Obsidian changes error:", error);
    jsonError(res, 500, "Failed to fetch changes");
  }
});

app.listen(PORT, () => {
  console.log(`CerebroTasks server running on port ${PORT}`);
});