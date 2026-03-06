"""
Database operations for mobyclaw dashboard.
Handles all SQLite CRUD operations for tasks, conversations, usage, lessons.
"""

import sqlite3
import json
import os
import uuid
from datetime import datetime, timezone

def init_db(db_path):
    """Create the tasks database and tables."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done','failed','cancelled')),
            priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
            tags TEXT DEFAULT '[]',
            parent_id TEXT REFERENCES tasks(id),
            depends_on TEXT DEFAULT '[]',
            due_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            retry_count INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 3,
            last_error TEXT,
            metadata TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

        CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            action TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT,
            timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            channel TEXT DEFAULT '',
            summary TEXT NOT NULL,
            topics TEXT DEFAULT '[]',
            key_facts TEXT DEFAULT '[]',
            message_count INTEGER DEFAULT 0,
            user_message TEXT DEFAULT '',
            agent_response TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_conv_topics ON conversations(topics);
        CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);

        CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            channel TEXT DEFAULT '',
            session_id TEXT DEFAULT '',
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cached_input_tokens INTEGER DEFAULT 0,
            cached_write_tokens INTEGER DEFAULT 0,
            context_length INTEGER DEFAULT 0,
            context_limit INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            model TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
        CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage(channel);

        CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            severity TEXT DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
            source TEXT DEFAULT '',
            auto_detected INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            applied_count INTEGER DEFAULT 0,
            last_applied TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
    """)

    # Migration: add user_message and agent_response columns if missing
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
        if "user_message" not in cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN user_message TEXT DEFAULT ''")
            print("[db] Migrated: added user_message column to conversations")
        if "agent_response" not in cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN agent_response TEXT DEFAULT ''")
            print("[db] Migrated: added agent_response column to conversations")
        conn.commit()
    except Exception as e:
        print(f"[db] Migration warning: {e}")

    conn.commit()
    conn.close()

def get_db(db_path):
    """Get a database connection."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

# ─── Task CRUD ──────────────────────────────────────────────

def create_task(db_path, data):
    conn = get_db(db_path)
    task_id = f"task_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO tasks (id, title, description, status, priority, tags, parent_id, depends_on, due_date, created_at, updated_at, max_retries, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        task_id,
        data.get("title", "Untitled"),
        data.get("description", ""),
        data.get("status", "todo"),
        data.get("priority", "medium"),
        json.dumps(data.get("tags", [])),
        data.get("parent_id"),
        json.dumps(data.get("depends_on", [])),
        data.get("due_date"),
        now, now,
        data.get("max_retries", 3),
        json.dumps(data.get("metadata", {}))
    ))
    conn.execute("INSERT INTO task_history (task_id, action, new_value, timestamp) VALUES (?, 'created', ?, ?)",
                 (task_id, json.dumps(data), now))
    conn.commit()
    task = dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
    conn.close()
    return task

def update_task(db_path, task_id, data):
    conn = get_db(db_path)
    now = datetime.now(timezone.utc).isoformat()

    old = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not old:
        conn.close()
        return None

    # Dependency check: block transition to in_progress/done if deps not met
    if "status" in data and data["status"] in ("in_progress", "done"):
        old_dict = dict(old)
        deps = json.loads(old_dict.get("depends_on", "[]"))
        if deps:
            dep_check = check_dependencies(db_path, task_id)
            if dep_check and not dep_check["satisfied"]:
                conn.close()
                blocking_names = [b["title"] for b in dep_check["blocking"]]
                return {
                    "error": "blocked_by_dependencies",
                    "message": f"Cannot set status to '{data['status']}': blocked by {len(dep_check['blocking'])} unfinished dependencies",
                    "blocking": dep_check["blocking"]
                }

    fields = []
    values = []
    for key in ["title", "description", "status", "priority", "tags", "parent_id", "depends_on", "due_date", "max_retries", "last_error", "metadata"]:
        if key in data:
            val = data[key]
            if key in ("tags", "depends_on", "metadata") and isinstance(val, (list, dict)):
                val = json.dumps(val)
            fields.append(f"{key}=?")
            values.append(val)
            conn.execute("INSERT INTO task_history (task_id, action, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?)",
                        (task_id, f"updated_{key}", str(dict(old).get(key)), str(val), now))

    if "status" in data:
        if data["status"] in ("done", "failed", "cancelled"):
            fields.append("completed_at=?")
            values.append(now)
        elif data["status"] == "in_progress" and dict(old).get("status") != "in_progress":
            fields.append("completed_at=?")
            values.append(None)

    fields.append("updated_at=?")
    values.append(now)
    values.append(task_id)

    conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", values)
    conn.commit()
    task = dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
    conn.close()
    return task

def get_tasks(db_path, filters=None):
    conn = get_db(db_path)
    query = "SELECT * FROM tasks WHERE 1=1"
    params = []

    if filters:
        if "status" in filters:
            statuses = filters["status"] if isinstance(filters["status"], list) else [filters["status"]]
            placeholders = ",".join("?" * len(statuses))
            query += f" AND status IN ({placeholders})"
            params.extend(statuses)
        if "priority" in filters:
            query += " AND priority=?"
            params.append(filters["priority"])
        if "parent_id" in filters:
            query += " AND parent_id=?"
            params.append(filters["parent_id"])
        if "tag" in filters:
            query += " AND tags LIKE ?"
            params.append(f'%"{filters["tag"]}"%')

    query += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, created_at DESC"

    tasks = [dict(row) for row in conn.execute(query, params).fetchall()]
    conn.close()
    return tasks

def get_task(db_path, task_id):
    conn = get_db(db_path)
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    history = [dict(h) for h in conn.execute("SELECT * FROM task_history WHERE task_id=? ORDER BY timestamp DESC LIMIT 20", (task_id,)).fetchall()]
    subtasks = [dict(s) for s in conn.execute("SELECT * FROM tasks WHERE parent_id=?", (task_id,)).fetchall()]
    conn.close()
    if not row:
        return None
    result = dict(row)
    result["history"] = history
    result["subtasks"] = subtasks
    return result

def delete_task(db_path, task_id):
    conn = get_db(db_path)
    conn.execute("DELETE FROM task_history WHERE task_id=?", (task_id,))
    conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    conn.close()

def retry_task(db_path, task_id):
    conn = get_db(db_path)
    now = datetime.now(timezone.utc).isoformat()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        conn.close()
        return None
    task = dict(task)
    if task["retry_count"] >= task["max_retries"]:
        conn.close()
        return {"error": "Max retries exceeded", "retry_count": task["retry_count"], "max_retries": task["max_retries"]}

    conn.execute("UPDATE tasks SET status='todo', retry_count=retry_count+1, updated_at=?, completed_at=NULL WHERE id=?", (now, task_id))
    conn.execute("INSERT INTO task_history (task_id, action, old_value, new_value, timestamp) VALUES (?, 'retry', ?, ?, ?)",
                (task_id, str(task["retry_count"]), str(task["retry_count"] + 1), now))
    conn.commit()
    result = dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
    conn.close()
    return result

def check_dependencies(db_path, task_id):
    """Check if all dependencies of a task are satisfied (done)."""
    conn = get_db(db_path)
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        conn.close()
        return None

    deps = json.loads(dict(task).get("depends_on", "[]"))
    if not deps:
        conn.close()
        return {"satisfied": True, "blocking": [], "total": 0, "done": 0}

    blocking = []
    done_count = 0
    for dep_id in deps:
        dep = conn.execute("SELECT id, title, status FROM tasks WHERE id=?", (dep_id,)).fetchone()
        if dep:
            dep = dict(dep)
            if dep["status"] == "done":
                done_count += 1
            else:
                blocking.append({"id": dep["id"], "title": dep["title"], "status": dep["status"]})
        else:
            blocking.append({"id": dep_id, "title": "(not found)", "status": "missing"})

    conn.close()
    return {
        "satisfied": len(blocking) == 0,
        "blocking": blocking,
        "total": len(deps),
        "done": done_count
    }

def get_blocked_tasks(db_path):
    """Return all tasks that have unsatisfied dependencies."""
    conn = get_db(db_path)
    tasks_with_deps = conn.execute(
        "SELECT id, title, status, depends_on FROM tasks WHERE depends_on != '[]' AND status NOT IN ('done','cancelled')"
    ).fetchall()
    conn.close()

    blocked = []
    for t in tasks_with_deps:
        t = dict(t)
        dep_check = check_dependencies(db_path, t["id"])
        if dep_check and not dep_check["satisfied"]:
            blocked.append({
                "id": t["id"],
                "title": t["title"],
                "status": t["status"],
                "blocking": dep_check["blocking"]
            })
    return blocked

def get_task_stats(db_path):
    """Get task statistics."""
    conn = get_db(db_path)
    stats = {
        "by_status": {},
        "by_priority": {},
        "overdue": 0,
        "completed_today": 0,
    }
    for row in conn.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"):
        stats["by_status"][row["status"]] = row["cnt"]
    for row in conn.execute("SELECT priority, COUNT(*) as cnt FROM tasks GROUP BY priority"):
        stats["by_priority"][row["priority"]] = row["cnt"]

    now = datetime.now(timezone.utc).isoformat()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stats["overdue"] = conn.execute("SELECT COUNT(*) as cnt FROM tasks WHERE due_date < ? AND status NOT IN ('done','cancelled')", (now,)).fetchone()["cnt"]
    stats["completed_today"] = conn.execute("SELECT COUNT(*) as cnt FROM tasks WHERE completed_at LIKE ? AND status='done'", (f"{today}%",)).fetchone()["cnt"]
    conn.close()
    return stats

# ─── Conversation CRUD ──────────────────────────────────────

def log_conversation(db_path, data):
    conn = get_db(db_path)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO conversations (timestamp, channel, summary, topics, key_facts, message_count, user_message, agent_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data.get("timestamp", now),
        data.get("channel", ""),
        data.get("summary", ""),
        json.dumps(data.get("topics", [])),
        json.dumps(data.get("key_facts", [])),
        data.get("message_count", 0),
        data.get("user_message", ""),
        data.get("agent_response", ""),
    ))
    conn.commit()
    conn.close()

def get_conversations(db_path, query=None, channel=None, limit=50):
    """Get conversations, optionally filtered."""
    conn = get_db(db_path)
    if query:
        results = [dict(row) for row in conn.execute(
            "SELECT * FROM conversations WHERE summary LIKE ? OR topics LIKE ? OR key_facts LIKE ? OR user_message LIKE ? OR agent_response LIKE ? ORDER BY timestamp DESC LIMIT ?",
            (f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%", limit)
        ).fetchall()]
    elif channel:
        results = [dict(row) for row in conn.execute(
            "SELECT * FROM conversations WHERE channel=? ORDER BY timestamp DESC LIMIT ?",
            (channel, limit)
        ).fetchall()]
    else:
        results = [dict(row) for row in conn.execute(
            "SELECT * FROM conversations ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()]
    conn.close()
    return results

def get_conversation_stats(db_path):
    """Get conversation statistics."""
    conn = get_db(db_path)
    stats = {
        "total": conn.execute("SELECT COUNT(*) as cnt FROM conversations").fetchone()["cnt"],
        "today": conn.execute("SELECT COUNT(*) as cnt FROM conversations WHERE timestamp LIKE ?",
            (datetime.now(timezone.utc).strftime("%Y-%m-%d") + "%",)).fetchone()["cnt"],
        "by_channel": {row["channel"]: row["cnt"] for row in conn.execute(
            "SELECT channel, COUNT(*) as cnt FROM conversations GROUP BY channel"
        ).fetchall()},
    }
    conn.close()
    return stats

# ─── Usage Tracking ─────────────────────────────────────────

def log_usage(db_path, data):
    """Log a single usage entry."""
    conn = get_db(db_path)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO usage (timestamp, channel, session_id, input_tokens, output_tokens,
                          cached_input_tokens, cached_write_tokens, context_length,
                          context_limit, cost, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data.get("timestamp", now),
        data.get("channel", ""),
        data.get("session_id", ""),
        data.get("input_tokens", 0),
        data.get("output_tokens", 0),
        data.get("cached_input_tokens", 0),
        data.get("cached_write_tokens", 0),
        data.get("context_length", 0),
        data.get("context_limit", 0),
        data.get("cost", 0),
        data.get("model", ""),
    ))
    conn.commit()
    conn.close()

def get_usage_stats(db_path, days=None, channel=None):
    """Get usage statistics."""
    conn = get_db(db_path)
    where_parts = []
    params = []

    if days:
        where_parts.append("timestamp >= datetime('now', ?)")
        params.append(f"-{days} days")
    if channel:
        where_parts.append("channel = ?")
        params.append(channel)

    where = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    summary = conn.execute(f"""
        SELECT
            COUNT(*) as total_requests,
            COALESCE(SUM(input_tokens), 0) as total_input_tokens,
            COALESCE(SUM(output_tokens), 0) as total_output_tokens,
            COALESCE(SUM(cached_input_tokens), 0) as total_cached_tokens,
            COALESCE(SUM(cost), 0) as total_cost,
            COALESCE(AVG(cost), 0) as avg_cost_per_request,
            COALESCE(AVG(input_tokens + output_tokens), 0) as avg_tokens_per_request
        FROM usage{where}
    """, params).fetchone()

    daily = [dict(row) for row in conn.execute(f"""
        SELECT
            DATE(timestamp) as date,
            COUNT(*) as requests,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cached_input_tokens) as cached_tokens,
            SUM(cost) as cost
        FROM usage{where}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
        LIMIT 30
    """, params).fetchall()]

    by_channel = [dict(row) for row in conn.execute(f"""
        SELECT
            channel,
            COUNT(*) as requests,
            SUM(cost) as cost,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens
        FROM usage{where}
        GROUP BY channel
        ORDER BY cost DESC
    """, params).fetchall()]

    by_model = [dict(row) for row in conn.execute(f"""
        SELECT
            model,
            COUNT(*) as requests,
            SUM(cost) as cost,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens
        FROM usage{where}
        GROUP BY model
        ORDER BY cost DESC
    """, params).fetchall()]

    conn.close()
    return {
        "summary": dict(summary) if summary else {},
        "daily": daily,
        "by_channel": by_channel,
        "by_model": by_model,
    }

def get_usage_recent(db_path, limit=50):
    """Get recent usage entries."""
    conn = get_db(db_path)
    rows = [dict(row) for row in conn.execute(
        "SELECT * FROM usage ORDER BY timestamp DESC LIMIT ?", (limit,)
    ).fetchall()]
    conn.close()
    return rows

# ─── Lessons System ─────────────────────────────────────────

def add_lesson(db_path, data):
    conn = get_db(db_path)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO lessons (lesson, category, severity, source, auto_detected, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        data.get("lesson", ""),
        data.get("category", "general"),
        data.get("severity", "info"),
        data.get("source", ""),
        1 if data.get("auto_detected") else 0,
        now
    ))
    conn.commit()
    conn.close()

def get_lessons(db_path, category=None):
    """Get lessons, optionally filtered by category."""
    conn = get_db(db_path)
    if category:
        lessons = [dict(row) for row in conn.execute("SELECT * FROM lessons WHERE category=? ORDER BY created_at DESC", (category,)).fetchall()]
    else:
        lessons = [dict(row) for row in conn.execute("SELECT * FROM lessons ORDER BY created_at DESC").fetchall()]
    conn.close()
    return lessons

# ─── Auto-Retry System ──────────────────────────────────────

def auto_retry_failed_tasks(db_path):
    """Automatically retry failed tasks that haven't exceeded max_retries."""
    conn = get_db(db_path)
    failed = conn.execute(
        "SELECT * FROM tasks WHERE status='failed' AND retry_count < max_retries"
    ).fetchall()
    conn.close()

    retried = []
    for task in failed:
        task = dict(task)
        result = retry_task(db_path, task["id"])
        if result and "error" not in result:
            retried.append({"id": task["id"], "title": task["title"], "retry_count": result["retry_count"]})
            print(f"[auto-retry] Retried task: {task['title']} (attempt {result['retry_count']})")

    return retried

def get_failed_tasks(db_path):
    """Get all failed tasks and those eligible for retry."""
    conn = get_db(db_path)
    failed = conn.execute(
        "SELECT id, title, retry_count, max_retries FROM tasks WHERE status='failed'"
    ).fetchall()
    eligible = conn.execute(
        "SELECT id, title, retry_count, max_retries FROM tasks WHERE status='failed' AND retry_count < max_retries"
    ).fetchall()
    conn.close()
    return {
        "failed_total": len(failed),
        "eligible_for_retry": len(eligible),
        "failed_tasks": [dict(r) for r in failed],
        "eligible_tasks": [dict(r) for r in eligible]
    }
