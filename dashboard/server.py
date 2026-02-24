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
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("DASHBOARD_PORT", 7777))
MOBY_DIR = os.environ.get("MOBYCLAW_DATA", "/data/.mobyclaw")
STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
DB_PATH = f"{MOBY_DIR}/data/tasks.db"
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://gateway:3000")

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
            if query:
                self.send_json(search_conversations(query))
            else:
                conn = get_db()
                convs = [dict(row) for row in conn.execute("SELECT * FROM conversations ORDER BY timestamp DESC LIMIT 50").fetchall()]
                conn.close()
                self.send_json(convs)

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
        else:
            self.send_json({"error": "Not found"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if path.startswith("/api/tasks/"):
            task_id = path.split("/")[-1]
            task = update_task(task_id, body)
            if task:
                self.send_json(task)
            else:
                self.send_json({"error": "Not found"}, 404)
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
        }

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
    server = http.server.HTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"mobyclaw dashboard running on http://0.0.0.0:{PORT}")
    print(f"  DB: {DB_PATH}")
    print(f"  Static: {STATIC_DIR}")
    print(f"  Data: {MOBY_DIR}")
    server.serve_forever()
