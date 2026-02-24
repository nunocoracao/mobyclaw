#!/usr/bin/env python3
"""
mobyclaw Dashboard Server
- Static dashboard serving (status, tasks, settings pages)
- Task Tracking Service (SQLite-backed REST API)
- Conversation indexing API
- Lessons learned API
- Memory management API
- Live status API
"""

import http.server
import json
import sqlite3
import subprocess
import os
import re
import uuid
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("DASHBOARD_PORT", 7777))
MOBY_DIR = os.environ.get("MOBYCLAW_DATA", "/data/.mobyclaw")
STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
DB_PATH = f"{MOBY_DIR}/data/tasks.db"
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://gateway:3000")
SOUL_YAML_PATH = f"{MOBY_DIR}/soul.yaml"
AUTO_RETRY_INTERVAL = int(os.environ.get("AUTO_RETRY_INTERVAL", 300))  # 5 min
DEFAULT_CONTEXT_BUDGET = int(os.environ.get("CONTEXT_BUDGET_TOKENS", 1500))  # ~1500 tokens

# ─── SQLite Task DB ────────────────────────────────────────

def init_db():
    """Create the tasks database and tables."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
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
            message_count INTEGER DEFAULT 0
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
    conn.commit()
    conn.close()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ─── Task CRUD ──────────────────────────────────────────────

def create_task(data):
    conn = get_db()
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

def update_task(task_id, data):
    conn = get_db()
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
            dep_check = check_dependencies(task_id)
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

def get_tasks(filters=None):
    conn = get_db()
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

def get_task(task_id):
    conn = get_db()
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

def delete_task(task_id):
    conn = get_db()
    conn.execute("DELETE FROM task_history WHERE task_id=?", (task_id,))
    conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    conn.close()

def retry_task(task_id):
    conn = get_db()
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

# ─── Task Dependency Checking ───────────────────────────────

def check_dependencies(task_id):
    """Check if all dependencies of a task are satisfied (done).
    Returns {"satisfied": bool, "blocking": [...], "total": int, "done": int}"""
    conn = get_db()
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

def get_blocked_tasks():
    """Return all tasks that have unsatisfied dependencies."""
    conn = get_db()
    tasks_with_deps = conn.execute(
        "SELECT id, title, status, depends_on FROM tasks WHERE depends_on != '[]' AND status NOT IN ('done','cancelled')"
    ).fetchall()
    conn.close()

    blocked = []
    for t in tasks_with_deps:
        t = dict(t)
        dep_check = check_dependencies(t["id"])
        if dep_check and not dep_check["satisfied"]:
            blocked.append({
                "id": t["id"],
                "title": t["title"],
                "status": t["status"],
                "blocking": dep_check["blocking"]
            })
    return blocked

# ─── Auto-Retry System ──────────────────────────────────────

def auto_retry_failed_tasks():
    """Automatically retry failed tasks that haven't exceeded max_retries.
    Called periodically by the retry thread."""
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    failed = conn.execute(
        "SELECT * FROM tasks WHERE status='failed' AND retry_count < max_retries"
    ).fetchall()
    conn.close()

    retried = []
    for task in failed:
        task = dict(task)
        result = retry_task(task["id"])
        if result and "error" not in result:
            retried.append({"id": task["id"], "title": task["title"], "retry_count": result["retry_count"]})
            print(f"[auto-retry] Retried task: {task['title']} (attempt {result['retry_count']})")

    return retried

def start_auto_retry_thread():
    """Start background thread that periodically retries failed tasks."""
    def retry_loop():
        while True:
            time.sleep(AUTO_RETRY_INTERVAL)
            try:
                retried = auto_retry_failed_tasks()
                if retried:
                    print(f"[auto-retry] Retried {len(retried)} tasks")
            except Exception as e:
                print(f"[auto-retry] Error: {e}")

    thread = threading.Thread(target=retry_loop, daemon=True)
    thread.start()
    print(f"[auto-retry] Started (interval: {AUTO_RETRY_INTERVAL}s)")

# ─── Soul.yaml API ──────────────────────────────────────────

def read_soul_yaml():
    """Read the agent's soul.yaml configuration."""
    if not os.path.exists(SOUL_YAML_PATH):
        return {"error": "soul.yaml not found", "path": SOUL_YAML_PATH}
    with open(SOUL_YAML_PATH, "r") as f:
        content = f.read()
    return {"content": content, "path": SOUL_YAML_PATH, "size": len(content)}

def write_soul_yaml(content):
    """Write updated soul.yaml. Creates a backup first."""
    if not content or not content.strip():
        return {"error": "Empty content not allowed"}

    # Backup current
    if os.path.exists(SOUL_YAML_PATH):
        backup_path = f"{SOUL_YAML_PATH}.bak"
        with open(SOUL_YAML_PATH, "r") as f:
            old_content = f.read()
        with open(backup_path, "w") as f:
            f.write(old_content)

    with open(SOUL_YAML_PATH, "w") as f:
        f.write(content)

    return {"ok": True, "path": SOUL_YAML_PATH, "size": len(content)}

# ─── Conversation Indexing ──────────────────────────────────

def log_conversation(data):
    conn = get_db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO conversations (timestamp, channel, summary, topics, key_facts, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        data.get("timestamp", now),
        data.get("channel", ""),
        data.get("summary", ""),
        json.dumps(data.get("topics", [])),
        json.dumps(data.get("key_facts", [])),
        data.get("message_count", 0)
    ))
    conn.commit()
    conn.close()

def search_conversations(query):
    conn = get_db()
    results = [dict(row) for row in conn.execute(
        "SELECT * FROM conversations WHERE summary LIKE ? OR topics LIKE ? OR key_facts LIKE ? ORDER BY timestamp DESC LIMIT 20",
        (f"%{query}%", f"%{query}%", f"%{query}%")
    ).fetchall()]
    conn.close()
    return results

# ─── Usage Tracking ─────────────────────────────────────────

def log_usage(data):
    """Log a single usage entry from a prompt response."""
    conn = get_db()
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

def get_usage_stats(days=None, channel=None):
    """Get usage statistics. Optionally filter by days or channel."""
    conn = get_db()
    where_parts = []
    params = []

    if days:
        where_parts.append("timestamp >= datetime('now', ?)")
        params.append(f"-{days} days")
    if channel:
        where_parts.append("channel = ?")
        params.append(channel)

    where = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Summary stats
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

    # Daily breakdown
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

    # By channel
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

    # By model
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

def get_usage_recent(limit=50):
    """Get recent usage entries."""
    conn = get_db()
    rows = [dict(row) for row in conn.execute(
        "SELECT * FROM usage ORDER BY timestamp DESC LIMIT ?", (limit,)
    ).fetchall()]
    conn.close()
    return rows

# ─── Lessons System ─────────────────────────────────────────

def add_lesson(data):
    conn = get_db()
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

def get_lessons(category=None):
    conn = get_db()
    if category:
        lessons = [dict(row) for row in conn.execute("SELECT * FROM lessons WHERE category=? ORDER BY created_at DESC", (category,)).fetchall()]
    else:
        lessons = [dict(row) for row in conn.execute("SELECT * FROM lessons ORDER BY created_at DESC").fetchall()]
    conn.close()
    return lessons

# ─── Memory Compression ────────────────────────────────────

def compress_memory():
    """Archive old completed tasks from MEMORY.md to dated archive."""
    memory_path = f"{MOBY_DIR}/MEMORY.md"
    archive_dir = f"{MOBY_DIR}/memory/archives"
    os.makedirs(archive_dir, exist_ok=True)

    if not os.path.exists(memory_path):
        return {"archived": 0, "message": "No MEMORY.md found"}

    with open(memory_path, "r") as f:
        content = f.read()

    pattern = r'(## Active Task \([^)]+\)\n\*\*Status:\*\* (?:DONE|CANCELLED)\n.*?)(?=\n## |\Z)'
    matches = list(re.finditer(pattern, content, re.DOTALL))

    if not matches:
        return {"archived": 0, "message": "Nothing to archive"}

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archive_path = f"{archive_dir}/{today}-tasks.md"
    archived_content = ""
    for m in matches:
        archived_content += m.group(0).strip() + "\n\n"

    with open(archive_path, "a") as f:
        f.write(archived_content)

    new_content = content
    for m in reversed(matches):
        new_content = new_content[:m.start()] + new_content[m.end():]

    new_content = re.sub(r'\n{3,}', '\n\n', new_content)

    with open(memory_path, "w") as f:
        f.write(new_content)

    return {"archived": len(matches), "archive_file": archive_path}

# ─── Context Window Optimizer ───────────────────────────────

def parse_memory_sections(content):
    """Parse MEMORY.md into sections by ## headers."""
    sections = []
    lines = content.split("\n")
    current_header = None
    current_body = []

    for line in lines:
        if line.startswith("## "):
            if current_header is not None:
                sections.append({
                    "header": current_header,
                    "body": "\n".join(current_body).strip(),
                })
            current_header = line[3:].strip()
            current_body = []
        elif current_header is not None:
            current_body.append(line)

    if current_header is not None:
        sections.append({
            "header": current_header,
            "body": "\n".join(current_body).strip(),
        })

    return sections


def score_section(section, query_words, now_str):
    """Score a memory section for relevance.

    Returns a numeric score (higher = more relevant).
    Scoring factors:
      - Section type (identity/user/prefs always high)
      - Status (IN PROGRESS > todo > done/cancelled)
      - Recency (recent dates score higher)
      - Query keyword overlap
    """
    header = section["header"].lower()
    body = section["body"].lower()
    full = header + " " + body
    score = 0

    # --- Always-include sections (core identity) ---
    always_include = ["identity", "user", "preferences"]
    for term in always_include:
        if term in header:
            score += 1000
            return score  # Always included, no further scoring needed

    # --- Status-based scoring ---
    if "in progress" in body:
        score += 200
    elif "status:** todo" in body or "status:** planned" in body:
        score += 100
    elif "status:** done" in body:
        score += 10
    elif "status:** cancelled" in body:
        score += 5

    # --- Section type scoring ---
    if "active task" in header:
        # Active tasks with IN PROGRESS are super important
        if "in progress" in body:
            score += 300
        else:
            score += 20  # Completed task journal entries
    elif "sprint" in header or "planned" in header:
        score += 80
    elif "projects" in header:
        score += 90
    elif "research" in header:
        score += 30
    elif "feature" in header or "ideas" in header:
        score += 25

    # --- Recency scoring ---
    # Extract dates from header or body (YYYY-MM-DD format)
    date_matches = re.findall(r'(\d{4}-\d{2}-\d{2})', header + " " + section["body"][:200])
    if date_matches:
        try:
            latest = max(date_matches)
            today = now_str[:10] if now_str else datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if latest == today:
                score += 50
            elif latest >= (datetime.now(timezone.utc).strftime("%Y-%m-%d")):
                score += 30
        except:
            pass

    # --- Query keyword overlap ---
    if query_words:
        overlap = sum(1 for w in query_words if w in full)
        score += overlap * 40

    # --- Body size penalty (prefer concise sections) ---
    body_len = len(section["body"])
    if body_len > 2000:
        score -= 10

    return score


def estimate_tokens(text):
    """Rough token estimation: ~4 chars per token for English."""
    return len(text) // 4


# ─── Inner State ────────────────────────────────────────────

def read_inner_state():
    """Read the agent's persistent emotional/inner state."""
    state_path = f"{MOBY_DIR}/state/inner.json"
    try:
        if os.path.exists(state_path):
            with open(state_path) as f:
                return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"[inner-state] Error reading: {e}")
    return {"mood": {"primary": "neutral"}, "energy": 0.5, "preoccupations": [], "curiosity_queue": []}


def write_inner_state(data):
    """Write the agent's inner state."""
    state_dir = f"{MOBY_DIR}/state"
    os.makedirs(state_dir, exist_ok=True)
    state_path = f"{state_dir}/inner.json"
    data["timestamp"] = datetime.now(timezone.utc).isoformat()
    with open(state_path, "w") as f:
        json.dump(data, f, indent=2)


def get_inner_context():
    """Build a compact inner state string for context injection."""
    state = read_inner_state()
    parts = []

    # Mood
    mood = state.get("mood", {})
    if isinstance(mood, dict):
        mood_str = mood.get("primary", "neutral")
        if mood.get("secondary"):
            mood_str += f" / {mood['secondary']}"
        if mood.get("note"):
            mood_str += f" - {mood['note']}"
        parts.append(f"Mood: {mood_str}")
    elif isinstance(mood, str):
        parts.append(f"Mood: {mood}")

    # Energy
    energy = state.get("energy", 0.5)
    parts.append(f"Energy: {energy}")

    # Preoccupations
    preoccupations = state.get("preoccupations", [])
    if preoccupations:
        parts.append("On my mind: " + "; ".join(preoccupations[:3]))

    # Curiosity
    curiosity = state.get("curiosity_queue", [])
    if curiosity:
        parts.append("Curious about: " + "; ".join(curiosity[:3]))

    # Recent events with feelings
    events = state.get("recent_events", [])
    if events:
        recent = events[-2:]  # last 2
        for ev in recent:
            line = ev.get("event", "")
            if ev.get("feeling"):
                line += f" (felt: {ev['feeling']})"
            parts.append(f"Recent: {line}")

    return "\n".join(parts)


def get_self_model_summary():
    """Read SELF.md and return a compact summary (first ~500 chars)."""
    self_path = f"{MOBY_DIR}/SELF.md"
    try:
        if os.path.exists(self_path):
            with open(self_path) as f:
                content = f.read()
            # Return the full thing if it's under budget, otherwise truncate
            if len(content) < 2000:
                return content
            return content[:2000] + "\n[... truncated ...]"
    except OSError:
        pass
    return ""


def get_optimized_context(query=None, budget_tokens=None):
    """Return the most relevant memory sections within a token budget.

    Args:
        query: The user's message (for keyword scoring). Optional.
        budget_tokens: Max tokens to return. Default: DEFAULT_CONTEXT_BUDGET.

    Returns:
        {
            "sections": [{"header": ..., "body": ..., "score": ...}],
            "total_tokens": int,
            "budget_tokens": int,
            "sections_included": int,
            "sections_total": int,
            "sections_pruned": int,
            "context": str  # Ready-to-use context text
        }
    """
    budget = budget_tokens or DEFAULT_CONTEXT_BUDGET
    memory_path = f"{MOBY_DIR}/MEMORY.md"

    if not os.path.exists(memory_path):
        return {"sections": [], "total_tokens": 0, "budget_tokens": budget,
                "sections_included": 0, "sections_total": 0, "sections_pruned": 0,
                "context": ""}

    with open(memory_path, "r") as f:
        content = f.read()

    sections = parse_memory_sections(content)
    if not sections:
        return {"sections": [], "total_tokens": 0, "budget_tokens": budget,
                "sections_included": 0, "sections_total": 0, "sections_pruned": 0,
                "context": ""}

    # Tokenize query for keyword matching
    query_words = []
    if query:
        query_words = [w.lower() for w in re.split(r'\W+', query) if len(w) > 2]

    now_str = datetime.now(timezone.utc).isoformat()

    # Score all sections
    scored = []
    for s in sections:
        sc = score_section(s, query_words, now_str)
        scored.append({**s, "score": sc})

    # Sort by score descending
    scored.sort(key=lambda x: x["score"], reverse=True)

    # Pack sections within budget
    included = []
    total_tokens = 0
    for s in scored:
        section_text = f"## {s['header']}\n{s['body']}"
        section_tokens = estimate_tokens(section_text)

        if total_tokens + section_tokens > budget and included:
            # Over budget - skip unless it's the first section
            continue

        included.append(s)
        total_tokens += section_tokens

    # Re-sort included by original order (preserve logical flow)
    section_order = {s["header"]: i for i, s in enumerate(sections)}
    included.sort(key=lambda x: section_order.get(x["header"], 999))

    # Build context text
    context_parts = []
    for s in included:
        context_parts.append(f"## {s['header']}\n{s['body']}")

    context_text = "\n\n".join(context_parts)

    # Inject inner state (always included, not scored)
    inner_context = get_inner_context()
    if inner_context:
        context_text = f"## Inner State (right now)\n{inner_context}\n\n{context_text}"
        total_tokens += estimate_tokens(inner_context) + 10

    return {
        "sections": [{"header": s["header"], "score": s["score"],
                       "tokens": estimate_tokens(f"## {s['header']}\n{s['body']}")} for s in included],
        "total_tokens": total_tokens,
        "budget_tokens": budget,
        "sections_included": len(included),
        "sections_total": len(sections),
        "sections_pruned": len(sections) - len(included),
        "context": context_text,
    }


# ─── Explorations API ───────────────────────────────────────

def get_explorations(query=None, limit=50):
    """List exploration files, optionally filtered by keyword."""
    explorations_dir = f"{MOBY_DIR}/explorations"
    if not os.path.exists(explorations_dir):
        return []

    files = sorted(
        [f for f in os.listdir(explorations_dir) if f.endswith(".md")],
        reverse=True
    )[:limit]

    results = []
    for fname in files:
        fpath = os.path.join(explorations_dir, fname)
        try:
            with open(fpath) as f:
                content = f.read()
        except:
            continue

        # Parse frontmatter
        meta = {"file": fname, "content": content}
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                for line in parts[1].strip().split("\n"):
                    if ":" in line:
                        key, val = line.split(":", 1)
                        meta[key.strip()] = val.strip()
                meta["body"] = parts[2].strip()

        # Filter by query if provided
        if query:
            q = query.lower()
            searchable = (content + " " + fname).lower()
            if q not in searchable:
                continue

        results.append(meta)

    return results


def get_exploration(filename):
    """Read a single exploration file."""
    explorations_dir = f"{MOBY_DIR}/explorations"
    fpath = os.path.join(explorations_dir, filename)
    if not os.path.exists(fpath) or not filename.endswith(".md"):
        return None
    with open(fpath) as f:
        return {"file": filename, "content": f.read()}


def get_exploration_stats():
    """Quick stats about explorations."""
    explorations_dir = f"{MOBY_DIR}/explorations"
    if not os.path.exists(explorations_dir):
        return {"count": 0, "topics": [], "latest": None}

    files = sorted(
        [f for f in os.listdir(explorations_dir) if f.endswith(".md")],
        reverse=True
    )

    topics = []
    for fname in files[:20]:
        try:
            with open(os.path.join(explorations_dir, fname)) as f:
                content = f.read()
            match = re.search(r'^topic:\s*(.+)$', content, re.MULTILINE)
            if match:
                topics.append(match.group(1).strip())
        except:
            pass

    return {
        "count": len(files),
        "topics": topics,
        "latest": files[0] if files else None,
    }


# ─── Settings API ───────────────────────────────────────────

def get_settings():
    settings = {
        "moby_dir": MOBY_DIR,
        "db_path": DB_PATH,
        "gateway_url": GATEWAY_URL,
        "memory_size": os.path.getsize(f"{MOBY_DIR}/MEMORY.md") if os.path.exists(f"{MOBY_DIR}/MEMORY.md") else 0,
        "lessons_count": len(get_lessons()),
        "db_size": os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0,
    }
    tunnel_info = f"{MOBY_DIR}/data/tunnel-info.json"
    if os.path.exists(tunnel_info):
        with open(tunnel_info) as f:
            settings["tunnel"] = json.load(f)
    return settings

# ─── HTTP Handler ───────────────────────────────────────────

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        # API routes
        if path == "/api/status":
            self.send_json(self.get_status())
        elif path == "/api/settings":
            self.send_json(get_settings())

        # Task API
        elif path == "/api/tasks/stats":
            self.send_json(self.get_task_stats())
        elif path == "/api/tasks":
            filters = {}
            if "status" in params: filters["status"] = params["status"]
            if "priority" in params: filters["priority"] = params["priority"][0]
            if "tag" in params: filters["tag"] = params["tag"][0]
            if "parent_id" in params: filters["parent_id"] = params["parent_id"][0]
            self.send_json(get_tasks(filters if filters else None))
        elif path.startswith("/api/tasks/") and path.count("/") == 3:
            task_id = path.split("/")[-1]
            task = get_task(task_id)
            if task:
                self.send_json(task)
            else:
                self.send_json({"error": "Not found"}, 404)

        # Conversation API
        elif path == "/api/conversations":
            query = params.get("q", [None])[0]
            channel = params.get("channel", [None])[0]
            limit = int(params.get("limit", ["50"])[0])
            conn = get_db()
            if query:
                results = [dict(row) for row in conn.execute(
                    "SELECT * FROM conversations WHERE summary LIKE ? OR topics LIKE ? OR key_facts LIKE ? ORDER BY timestamp DESC LIMIT ?",
                    (f"%{query}%", f"%{query}%", f"%{query}%", limit)
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
            self.send_json(results)
        elif path == "/api/conversations/stats":
            conn = get_db()
            stats = {
                "total": conn.execute("SELECT COUNT(*) as cnt FROM conversations").fetchone()["cnt"],
                "today": conn.execute("SELECT COUNT(*) as cnt FROM conversations WHERE timestamp LIKE ?",
                    (datetime.now(timezone.utc).strftime("%Y-%m-%d") + "%",)).fetchone()["cnt"],
                "by_channel": {row["channel"]: row["cnt"] for row in conn.execute(
                    "SELECT channel, COUNT(*) as cnt FROM conversations GROUP BY channel"
                ).fetchall()},
            }
            conn.close()
            self.send_json(stats)

        # Lessons API
        elif path == "/api/lessons":
            category = params.get("category", [None])[0]
            self.send_json(get_lessons(category))

        # Memory API
        elif path == "/api/memory":
            memory_path = f"{MOBY_DIR}/MEMORY.md"
            if os.path.exists(memory_path):
                with open(memory_path) as f:
                    self.send_json({"content": f.read()})
            else:
                self.send_json({"content": ""})

        # Soul.yaml API
        elif path == "/api/soul":
            self.send_json(read_soul_yaml())

        # Task dependency API
        elif path.startswith("/api/tasks/") and path.endswith("/deps"):
            task_id = path.split("/")[-2]
            result = check_dependencies(task_id)
            if result:
                self.send_json(result)
            else:
                self.send_json({"error": "Not found"}, 404)
        elif path == "/api/tasks/blocked":
            self.send_json(get_blocked_tasks())

        # Inner State API
        elif path == "/api/inner-state":
            self.send_json(read_inner_state())
        elif path == "/api/self-model":
            self_path = f"{MOBY_DIR}/SELF.md"
            if os.path.exists(self_path):
                with open(self_path) as f:
                    self.send_json({"content": f.read()})
            else:
                self.send_json({"content": ""})
        elif path == "/api/journal":
            day = params.get("date", [datetime.now(timezone.utc).strftime("%Y-%m-%d")])[0]
            journal_path = f"{MOBY_DIR}/journal/{day}.md"
            if os.path.exists(journal_path):
                with open(journal_path) as f:
                    self.send_json({"date": day, "content": f.read()})
            else:
                self.send_json({"date": day, "content": ""})

        # Explorations API
        elif path == "/api/explorations":
            query = params.get("q", [None])[0]
            limit = int(params.get("limit", ["50"])[0])
            self.send_json(get_explorations(query, limit))
        elif path == "/api/explorations/stats":
            self.send_json(get_exploration_stats())
        elif path.startswith("/api/explorations/") and path.count("/") == 3:
            filename = path.split("/")[-1]
            result = get_exploration(filename)
            if result:
                self.send_json(result)
            else:
                self.send_json({"error": "Not found"}, 404)

        # Context Window Optimizer
        elif path == "/api/context":
            query = params.get("query", [None])[0]
            budget = int(params.get("budget", [str(DEFAULT_CONTEXT_BUDGET)])[0])
            self.send_json(get_optimized_context(query, budget))

        # Usage API
        elif path == "/api/usage":
            limit = int(params.get("limit", ["50"])[0])
            self.send_json(get_usage_recent(limit))
        elif path == "/api/usage/stats":
            days = params.get("days", [None])[0]
            channel = params.get("channel", [None])[0]
            days = int(days) if days else None
            self.send_json(get_usage_stats(days, channel))

        # Auto-retry status
        elif path == "/api/retry/status":
            conn = get_db()
            failed = conn.execute(
                "SELECT id, title, retry_count, max_retries FROM tasks WHERE status='failed'"
            ).fetchall()
            eligible = conn.execute(
                "SELECT id, title, retry_count, max_retries FROM tasks WHERE status='failed' AND retry_count < max_retries"
            ).fetchall()
            conn.close()
            self.send_json({
                "auto_retry_interval": AUTO_RETRY_INTERVAL,
                "failed_total": len(failed),
                "eligible_for_retry": len(eligible),
                "failed_tasks": [dict(r) for r in failed],
                "eligible_tasks": [dict(r) for r in eligible]
            })

        # Tunnel info
        elif path == "/api/tunnel":
            tunnel_info = f"{MOBY_DIR}/data/tunnel-info.json"
            if os.path.exists(tunnel_info):
                with open(tunnel_info) as f:
                    self.send_json(json.load(f))
            else:
                self.send_json({"url": None, "status": "not running"})

        # Dashboard pages
        elif path == "/tasks":
            self.serve_page("tasks.html")
        elif path == "/settings":
            self.serve_page("settings.html")
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if path == "/api/tasks":
            task = create_task(body)
            self.send_json(task, 201)
        elif path.startswith("/api/tasks/") and path.endswith("/retry"):
            task_id = path.split("/")[-2]
            result = retry_task(task_id)
            if result:
                self.send_json(result)
            else:
                self.send_json({"error": "Not found"}, 404)
        elif path == "/api/conversations":
            log_conversation(body)
            self.send_json({"ok": True}, 201)
        elif path == "/api/lessons":
            add_lesson(body)
            self.send_json({"ok": True}, 201)
        elif path == "/api/memory/compress":
            result = compress_memory()
            self.send_json(result)
        elif path == "/api/memory":
            memory_path = f"{MOBY_DIR}/MEMORY.md"
            with open(memory_path, "w") as f:
                f.write(body.get("content", ""))
            self.send_json({"ok": True})
        elif path == "/api/soul":
            result = write_soul_yaml(body.get("content", ""))
            if "error" in result:
                self.send_json(result, 400)
            else:
                self.send_json(result)
        elif path == "/api/retry/run":
            retried = auto_retry_failed_tasks()
            self.send_json({"retried": retried, "count": len(retried)})
        elif path == "/api/usage":
            log_usage(body)
            self.send_json({"ok": True}, 201)
        elif path == "/api/inner-state":
            write_inner_state(body)
            self.send_json({"ok": True})
        elif path == "/api/self-model":
            self_path = f"{MOBY_DIR}/SELF.md"
            with open(self_path, "w") as f:
                f.write(body.get("content", ""))
            self.send_json({"ok": True})
        elif path == "/api/journal":
            day = body.get("date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            journal_dir = f"{MOBY_DIR}/journal"
            os.makedirs(journal_dir, exist_ok=True)
            journal_path = f"{journal_dir}/{day}.md"
            mode = body.get("mode", "append")
            if mode == "append" and os.path.exists(journal_path):
                with open(journal_path, "a") as f:
                    f.write("\n" + body.get("content", ""))
            else:
                with open(journal_path, "w") as f:
                    f.write(body.get("content", ""))
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "Not found"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if path.startswith("/api/tasks/"):
            task_id = path.split("/")[-1]
            task = update_task(task_id, body)
            if task is None:
                self.send_json({"error": "Not found"}, 404)
            elif "error" in task:
                self.send_json(task, 409)
            else:
                self.send_json(task)
        else:
            self.send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/tasks/"):
            task_id = path.split("/")[-1]
            delete_task(task_id)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "Not found"}, 404)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            return json.loads(self.rfile.read(length))
        return {}

    def get_status(self):
        conn = get_db()
        task_counts = {}
        for row in conn.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"):
            task_counts[row["status"]] = row["cnt"]
        total_tasks = sum(task_counts.values())
        conv_count = conn.execute("SELECT COUNT(*) as cnt FROM conversations").fetchone()["cnt"]
        lesson_count = conn.execute("SELECT COUNT(*) as cnt FROM lessons").fetchone()["cnt"]
        conn.close()

        # Read tunnel info
        tunnel_url = None
        tunnel_info = f"{MOBY_DIR}/data/tunnel-info.json"
        if os.path.exists(tunnel_info):
            try:
                with open(tunnel_info) as f:
                    tunnel_url = json.load(f).get("url")
            except:
                pass

        # Check memory size
        memory_size = 0
        memory_lines = 0
        memory_path = f"{MOBY_DIR}/MEMORY.md"
        if os.path.exists(memory_path):
            memory_size = os.path.getsize(memory_path)
            with open(memory_path) as f:
                memory_lines = sum(1 for _ in f)

        return {
            "agent": "mobyclaw",
            "status": "online",
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
            "tasks": task_counts,
            "total_tasks": total_tasks,
            "conversations_indexed": conv_count,
            "lessons_learned": lesson_count,
            "tunnel_url": tunnel_url,
            "memory_size": memory_size,
            "memory_lines": memory_lines,
            "usage": self.get_usage_summary(),
        }

    def get_usage_summary(self):
        """Quick usage summary for the status endpoint."""
        try:
            conn = get_db()
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            today_row = conn.execute(
                "SELECT COUNT(*) as requests, COALESCE(SUM(cost), 0) as cost, "
                "COALESCE(SUM(input_tokens), 0) as input_tokens, "
                "COALESCE(SUM(output_tokens), 0) as output_tokens "
                "FROM usage WHERE timestamp LIKE ?",
                (f"{today}%",)
            ).fetchone()
            total_row = conn.execute(
                "SELECT COUNT(*) as requests, COALESCE(SUM(cost), 0) as cost "
                "FROM usage"
            ).fetchone()
            conn.close()
            return {
                "today": dict(today_row) if today_row else {},
                "total": dict(total_row) if total_row else {},
            }
        except Exception:
            return {}

    def get_task_stats(self):
        conn = get_db()
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

    def serve_page(self, filename):
        filepath = os.path.join(STATIC_DIR, filename)
        if os.path.exists(filepath):
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", len(content))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()

    def send_json(self, data, code=200):
        body = json.dumps(data, indent=2, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        pass  # Quiet logging


if __name__ == "__main__":
    init_db()
    start_auto_retry_thread()
    server = http.server.HTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"mobyclaw dashboard running on http://0.0.0.0:{PORT}")
    print(f"  DB: {DB_PATH}")
    print(f"  Static: {STATIC_DIR}")
    print(f"  Data: {MOBY_DIR}")
    server.serve_forever()
