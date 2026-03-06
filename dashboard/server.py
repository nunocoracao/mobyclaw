#!/usr/bin/env python3
"""
mobyclaw Dashboard Server - refactored
- HTTP handler (GET/POST/PUT/DELETE routes)
- Database operations: database.py
- Business logic & services: services.py
"""

import http.server
import json
import os
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

# Import modularized code
from database import (
    init_db, get_db, create_task, update_task, get_tasks, get_task, delete_task, retry_task,
    check_dependencies, get_blocked_tasks, get_task_stats, log_conversation, get_conversations,
    get_conversation_stats, log_usage, get_usage_stats, get_usage_recent, add_lesson, get_lessons,
    auto_retry_failed_tasks, get_failed_tasks
)
from services import (
    compress_memory, read_soul_yaml, write_soul_yaml, search_conversations_for_context,
    get_optimized_context, get_explorations, get_exploration, get_exploration_stats,
    invalidate_memory_cache
)

PORT = int(os.environ.get("DASHBOARD_PORT", 7777))
MOBY_DIR = os.environ.get("MOBYCLAW_DATA", "/data/.mobyclaw")
STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")
DB_PATH = f"{MOBY_DIR}/data/tasks.db"
AUTO_RETRY_INTERVAL = int(os.environ.get("AUTO_RETRY_INTERVAL", 300))
DEFAULT_CONTEXT_BUDGET = int(os.environ.get("CONTEXT_BUDGET_TOKENS", 1500))


# ─── Auto-Retry Thread ──────────────────────────────────────

def start_auto_retry_thread():
    """Start background thread that periodically retries failed tasks."""
    def retry_loop():
        while True:
            time.sleep(AUTO_RETRY_INTERVAL)
            try:
                retried = auto_retry_failed_tasks(DB_PATH)
                if retried:
                    print(f"[auto-retry] Retried {len(retried)} tasks")
            except Exception as e:
                print(f"[auto-retry] Error: {e}")

    thread = threading.Thread(target=retry_loop, daemon=True)
    thread.start()
    print(f"[auto-retry] Started (interval: {AUTO_RETRY_INTERVAL}s)")


# ─── HTTP Handler ───────────────────────────────────────────

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        try:
            # Status & Settings
            if path == "/api/status":
                self.send_json(self.get_status())
            elif path == "/api/settings":
                self.send_json(self.get_settings())

            # Task API
            elif path == "/api/tasks/stats":
                self.send_json(get_task_stats(DB_PATH))
            elif path == "/api/tasks":
                filters = {}
                if "status" in params: filters["status"] = params["status"]
                if "priority" in params: filters["priority"] = params["priority"][0]
                if "tag" in params: filters["tag"] = params["tag"][0]
                if "parent_id" in params: filters["parent_id"] = params["parent_id"][0]
                self.send_json(get_tasks(DB_PATH, filters if filters else None))
            elif path.startswith("/api/tasks/") and path.count("/") == 3:
                task_id = path.split("/")[-1]
                task = get_task(DB_PATH, task_id)
                self.send_json(task if task else {"error": "Not found"}, 404 if not task else 200)

            # Conversation API
            elif path == "/api/conversations":
                query = params.get("q", [None])[0]
                channel = params.get("channel", [None])[0]
                limit = int(params.get("limit", ["50"])[0])
                self.send_json(get_conversations(DB_PATH, query, channel, limit))
            elif path == "/api/conversations/stats":
                self.send_json(get_conversation_stats(DB_PATH))

            # Lessons API
            elif path == "/api/lessons":
                category = params.get("category", [None])[0]
                self.send_json(get_lessons(DB_PATH, category))

            # Memory API
            elif path == "/api/memory":
                self.send_json({"content": open(f"{MOBY_DIR}/MEMORY.md").read() if os.path.exists(f"{MOBY_DIR}/MEMORY.md") else ""})

            # Soul.yaml API
            elif path == "/api/soul":
                self.send_json(read_soul_yaml(MOBY_DIR))

            # Task dependency API
            elif path.startswith("/api/tasks/") and path.endswith("/deps"):
                task_id = path.split("/")[-2]
                result = check_dependencies(DB_PATH, task_id)
                self.send_json(result if result else {"error": "Not found"}, 404 if not result else 200)
            elif path == "/api/tasks/blocked":
                self.send_json(get_blocked_tasks(DB_PATH))

            # Inner State API
            elif path == "/api/inner-state":
                state_path = f"{MOBY_DIR}/state/inner.json"
                self.send_json(json.load(open(state_path)) if os.path.exists(state_path) else {"mood": {"primary": "neutral"}, "energy": 0.5})
            elif path == "/api/self-model":
                self_path = f"{MOBY_DIR}/SELF.md"
                self.send_json({"content": open(self_path).read() if os.path.exists(self_path) else ""})
            elif path == "/api/journal":
                day = params.get("date", [datetime.now(timezone.utc).strftime("%Y-%m-%d")])[0]
                journal_path = f"{MOBY_DIR}/journal/{day}.md"
                self.send_json({"date": day, "content": open(journal_path).read() if os.path.exists(journal_path) else ""})

            # Explorations API
            elif path == "/api/explorations":
                query = params.get("q", [None])[0]
                limit = int(params.get("limit", ["50"])[0])
                self.send_json(get_explorations(MOBY_DIR, query, limit))
            elif path == "/api/explorations/stats":
                self.send_json(get_exploration_stats(MOBY_DIR))
            elif path.startswith("/api/explorations/") and path.count("/") == 3:
                filename = path.split("/")[-1]
                result = get_exploration(MOBY_DIR, filename)
                self.send_json(result if result else {"error": "Not found"}, 404 if not result else 200)

            # Context Window Optimizer
            elif path == "/api/context":
                query = params.get("query", [None])[0]
                budget = int(params.get("budget", [str(DEFAULT_CONTEXT_BUDGET)])[0])
                self.send_json(get_optimized_context(MOBY_DIR, query, budget))

            # Conversation RAG - search past conversations for context injection
            elif path == "/api/context/conversations":
                query = params.get("query", [None])[0]
                limit = int(params.get("limit", ["5"])[0])
                self.send_json(search_conversations_for_context(DB_PATH, query, limit))

            # Usage API
            elif path == "/api/usage":
                limit = int(params.get("limit", ["50"])[0])
                self.send_json(get_usage_recent(DB_PATH, limit))
            elif path == "/api/usage/stats":
                days = params.get("days", [None])[0]
                channel = params.get("channel", [None])[0]
                days = int(days) if days else None
                self.send_json(get_usage_stats(DB_PATH, days, channel))

            # Auto-retry status
            elif path == "/api/retry/status":
                failed_data = get_failed_tasks(DB_PATH)
                self.send_json({**failed_data, "auto_retry_interval": AUTO_RETRY_INTERVAL})

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
            elif path == "/usage":
                self.serve_page("usage.html")
            elif path == "/settings":
                self.serve_page("settings.html")
            else:
                super().do_GET()

        except Exception as e:
            print(f"[error] GET {path}: {e}")
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        try:
            if path == "/api/tasks":
                task = create_task(DB_PATH, body)
                self.send_json(task, 201)
            elif path.startswith("/api/tasks/") and path.endswith("/retry"):
                task_id = path.split("/")[-2]
                result = retry_task(DB_PATH, task_id)
                self.send_json(result if result else {"error": "Not found"}, 404 if not result else 200)
            elif path == "/api/conversations":
                log_conversation(DB_PATH, body)
                self.send_json({"ok": True}, 201)
            elif path == "/api/lessons":
                add_lesson(DB_PATH, body)
                self.send_json({"ok": True}, 201)
            elif path == "/api/memory/compress":
                result = compress_memory(MOBY_DIR)
                self.send_json(result)
            elif path == "/api/memory":
                memory_path = f"{MOBY_DIR}/MEMORY.md"
                with open(memory_path, "w") as f:
                    f.write(body.get("content", ""))
                invalidate_memory_cache()
                self.send_json({"ok": True})
            elif path == "/api/soul":
                result = write_soul_yaml(MOBY_DIR, body.get("content", ""))
                code = 400 if "error" in result else 200
                self.send_json(result, code)
            elif path == "/api/retry/run":
                retried = auto_retry_failed_tasks(DB_PATH)
                self.send_json({"retried": retried, "count": len(retried)})
            elif path == "/api/usage":
                log_usage(DB_PATH, body)
                self.send_json({"ok": True}, 201)
            elif path == "/api/inner-state":
                state_path = f"{MOBY_DIR}/state"
                os.makedirs(state_path, exist_ok=True)
                with open(f"{state_path}/inner.json", "w") as f:
                    body["timestamp"] = datetime.now(timezone.utc).isoformat()
                    json.dump(body, f, indent=2)
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
            elif path == "/api/tunnel/start":
                import subprocess
                pid_file = f"{MOBY_DIR}/data/tunnel.pid"
                if os.path.exists(pid_file):
                    try:
                        with open(pid_file) as f:
                            pid = int(f.read().strip())
                        os.kill(pid, 0)
                        tunnel_info = f"{MOBY_DIR}/data/tunnel-info.json"
                        if os.path.exists(tunnel_info):
                            with open(tunnel_info) as f:
                                info = json.load(f)
                            self.send_json({"status": "already running", "url": info.get("url")})
                        else:
                            self.send_json({"status": "already running"})
                        return
                    except (OSError, ValueError):
                        pass
                script = "/app/scripts/start-tunnel.sh"
                subprocess.Popen([script, MOBY_DIR, "7777"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.send_json({"status": "starting", "message": "Tunnel starting - URL will be sent via Telegram when ready"})
            else:
                self.send_json({"error": "Not found"}, 404)
        except Exception as e:
            print(f"[error] POST {path}: {e}")
            self.send_json({"error": str(e)}, 500)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        try:
            if path.startswith("/api/tasks/"):
                task_id = path.split("/")[-1]
                task = update_task(DB_PATH, task_id, body)
                if task is None:
                    self.send_json({"error": "Not found"}, 404)
                elif "error" in task:
                    self.send_json(task, 409)
                else:
                    self.send_json(task)
            else:
                self.send_json({"error": "Not found"}, 404)
        except Exception as e:
            print(f"[error] PUT {path}: {e}")
            self.send_json({"error": str(e)}, 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path.startswith("/api/tasks/"):
                task_id = path.split("/")[-1]
                delete_task(DB_PATH, task_id)
                self.send_json({"ok": True})
            else:
                self.send_json({"error": "Not found"}, 404)
        except Exception as e:
            print(f"[error] DELETE {path}: {e}")
            self.send_json({"error": str(e)}, 500)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            return json.loads(self.rfile.read(length))
        return {}

    def get_status(self):
        task_counts = {}
        conn = get_db(DB_PATH)
        for row in conn.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"):
            task_counts[row["status"]] = row["cnt"]
        total_tasks = sum(task_counts.values())
        conv_count = conn.execute("SELECT COUNT(*) as cnt FROM conversations").fetchone()["cnt"]
        lesson_count = conn.execute("SELECT COUNT(*) as cnt FROM lessons").fetchone()["cnt"]
        conn.close()

        tunnel_url = None
        tunnel_info = f"{MOBY_DIR}/data/tunnel-info.json"
        if os.path.exists(tunnel_info):
            try:
                with open(tunnel_info) as f:
                    tunnel_url = json.load(f).get("url")
            except:
                pass

        memory_size, memory_lines = 0, 0
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

    def get_settings(self):
        return {
            "moby_dir": MOBY_DIR,
            "db_path": DB_PATH,
            "memory_size": os.path.getsize(f"{MOBY_DIR}/MEMORY.md") if os.path.exists(f"{MOBY_DIR}/MEMORY.md") else 0,
            "lessons_count": len(get_lessons(DB_PATH)),
            "db_size": os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0,
        }

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
        self.send_header("Access-Control-Allow-Origin", "localhost:7777")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "localhost:7777")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        pass  # Quiet logging


if __name__ == "__main__":
    init_db(DB_PATH)
    start_auto_retry_thread()
    server = http.server.HTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"mobyclaw dashboard running on http://0.0.0.0:{PORT}")
    print(f"  DB: {DB_PATH}")
    print(f"  Static: {STATIC_DIR}")
    print(f"  Data: {MOBY_DIR}")
    server.serve_forever()
