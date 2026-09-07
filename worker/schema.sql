-- Plan storage for the planner page. One row per ClickUp task; `planning` is a
-- JSON object { "YYYY-MM-DD": hours }.
CREATE TABLE IF NOT EXISTS plan (
  task_id    TEXT PRIMARY KEY,
  planning   TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
