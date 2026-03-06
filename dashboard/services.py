"""
Business logic and utility services for mobyclaw dashboard.
Handles memory compression, context optimization, search, and configuration.
"""

import os
import json
import re
import math
from datetime import datetime, timezone


MEMORY_CACHE = {"content": None, "timestamp": None, "ttl": 300}  # 5 min cache


def read_memory_file(moby_dir):
    """Read MEMORY.md from disk."""
    memory_path = f"{moby_dir}/MEMORY.md"
    if not os.path.exists(memory_path):
        return ""
    with open(memory_path, "r") as f:
        return f.read()


def get_cached_memory(moby_dir):
    """Get MEMORY.md from cache or disk. Cache expires after 5 min."""
    now = datetime.now(timezone.utc).timestamp()
    if (MEMORY_CACHE["content"] is not None and 
        MEMORY_CACHE["timestamp"] is not None and
        now - MEMORY_CACHE["timestamp"] < MEMORY_CACHE["ttl"]):
        return MEMORY_CACHE["content"]
    
    content = read_memory_file(moby_dir)
    MEMORY_CACHE["content"] = content
    MEMORY_CACHE["timestamp"] = now
    return content


def invalidate_memory_cache():
    """Invalidate the MEMORY.md cache (called after writes)."""
    MEMORY_CACHE["content"] = None
    MEMORY_CACHE["timestamp"] = None


def compress_memory(moby_dir):
    """Archive old completed tasks from MEMORY.md to dated archive."""
    memory_path = f"{moby_dir}/MEMORY.md"
    archive_dir = f"{moby_dir}/memory/archives"
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

    invalidate_memory_cache()
    return {"archived": len(matches), "archive_file": archive_path}


def read_soul_yaml(moby_dir):
    """Read the agent's soul.yaml configuration."""
    soul_path = f"{moby_dir}/soul.yaml"
    if not os.path.exists(soul_path):
        return {"error": "soul.yaml not found", "path": soul_path}
    with open(soul_path, "r") as f:
        content = f.read()
    return {"content": content, "path": soul_path, "size": len(content)}


def write_soul_yaml(moby_dir, content):
    """Write updated soul.yaml. Creates a backup first."""
    if not content or not content.strip():
        return {"error": "Empty content not allowed"}

    soul_path = f"{moby_dir}/soul.yaml"
    if os.path.exists(soul_path):
        backup_path = f"{soul_path}.bak"
        with open(soul_path, "r") as f:
            old_content = f.read()
        with open(backup_path, "w") as f:
            f.write(old_content)

    with open(soul_path, "w") as f:
        f.write(content)

    return {"ok": True, "path": soul_path, "size": len(content)}


def search_conversations_for_context(db_path, query, limit=5):
    """Search past conversations for context injection using keyword matching + scoring."""
    from database import get_db
    
    if not query:
        return {"conversations": [], "count": 0}

    # Extract significant keywords from query
    stop_words = {
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
        "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
        "than", "this", "that", "what", "when", "how", "who", "which", "will",
        "with", "from", "they", "would", "there", "their", "about", "could",
        "other", "into", "more", "your", "just", "also", "very", "want", "need",
        "know", "think", "look", "like", "going", "here", "okay", "right",
        "thing", "things", "really", "something", "yeah", "sure", "well",
        "let", "now", "get", "got", "don", "did", "does", "doing", "done",
        "make", "made", "way", "back", "much", "still", "should",
    }
    words = [
        w for w in re.split(r'\W+', query.lower())
        if len(w) >= 3 and w not in stop_words
    ]

    if not words:
        return {"conversations": [], "count": 0}

    conn = get_db(db_path)

    # Search for each keyword independently, collect matching conversation IDs
    matched = {}  # id -> {row, score}
    for word in words[:6]:  # cap at 6 keywords
        pattern = f"%{word}%"
        rows = conn.execute(
            """SELECT id, timestamp, channel, summary, topics, user_message, agent_response
               FROM conversations
               WHERE channel NOT LIKE 'heartbeat%' AND channel NOT LIKE 'schedule%'
                 AND (summary LIKE ? OR topics LIKE ? OR user_message LIKE ? OR agent_response LIKE ?)
               ORDER BY timestamp DESC LIMIT 20""",
            (pattern, pattern, pattern, pattern)
        ).fetchall()
        for row in rows:
            row = dict(row)
            rid = row["id"]
            if rid not in matched:
                matched[rid] = {"row": row, "score": 0}
            matched[rid]["score"] += 1  # more keyword matches = higher score

    conn.close()

    if not matched:
        return {"conversations": [], "count": 0}

    # Sort by score (more keyword matches) then by recency
    ranked = sorted(
        matched.values(),
        key=lambda x: (x["score"], x["row"]["timestamp"]),
        reverse=True
    )

    # Build compact results
    results = []
    for item in ranked[:limit]:
        row = item["row"]
        user_msg = row.get("user_message", "") or ""
        agent_resp = row.get("agent_response", "") or ""

        if user_msg and agent_resp:
            content = f"User: {user_msg[:300]}\nAgent: {agent_resp[:500]}"
        else:
            content = (row.get("summary", "") or "")[:600]

        results.append({
            "id": row["id"],
            "timestamp": row["timestamp"],
            "channel": row["channel"],
            "content": content,
            "topics": row.get("topics", "[]"),
            "score": item["score"],
        })

    return {"conversations": results, "count": len(results)}


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
    """Score a memory section for relevance."""
    header = section["header"].lower()
    body = section["body"].lower()
    full = header + " " + body
    score = 0

    # Always-include sections (core identity)
    always_include = ["identity", "user", "preferences"]
    for term in always_include:
        if term in header:
            score += 1000
            return score

    # Status-based scoring
    if "in progress" in body:
        score += 200
    elif "status:** todo" in body or "status:** planned" in body:
        score += 100
    elif "status:** done" in body:
        score += 10
    elif "status:** cancelled" in body:
        score += 5

    # Section type scoring
    if "active task" in header:
        if "in progress" in body:
            score += 300
        else:
            score += 20
    elif "sprint" in header or "planned" in header:
        score += 80
    elif "projects" in header:
        score += 90
    elif "research" in header:
        score += 30
    elif "feature" in header or "ideas" in header:
        score += 25

    # Recency scoring
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

    # Body size penalty
    body_len = len(section["body"])
    if body_len > 2000:
        score -= 10

    return score


def bm25_scores(sections, query_words, k1=1.5, b=0.75):
    """Compute BM25 relevance scores for query_words across memory sections."""
    if not query_words or not sections:
        return {}

    docs = []
    for s in sections:
        text = (s["header"] + " " + s["body"]).lower()
        words = [w for w in re.split(r'\W+', text) if len(w) > 2]
        docs.append(words)

    N = len(docs)
    avgdl = sum(len(d) for d in docs) / N if N > 0 else 1

    scores = {}
    for i, (s, doc) in enumerate(zip(sections, docs)):
        score = 0.0
        dl = len(doc)
        for qw in query_words:
            tf = doc.count(qw)
            if tf == 0:
                continue
            df = sum(1 for d in docs if qw in d)
            idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
            term_score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
            score += term_score
        scores[s["header"]] = score

    return scores


def estimate_tokens(text):
    """Rough token estimation: ~4 chars per token for English."""
    return len(text) // 4


def get_core_context(moby_dir):
    """Load core.md - identity-critical content."""
    core_path = f"{moby_dir}/core.md"
    try:
        if os.path.exists(core_path):
            with open(core_path) as f:
                return f.read().strip()
    except OSError:
        pass
    return ""


def get_inner_context(moby_dir):
    """Build a compact inner state string for context injection."""
    state_path = f"{moby_dir}/state/inner.json"
    try:
        if os.path.exists(state_path):
            with open(state_path) as f:
                state = json.load(f)
        else:
            state = {"mood": {"primary": "neutral"}, "energy": 0.5, "preoccupations": [], "curiosity_queue": []}
    except (json.JSONDecodeError, OSError):
        state = {"mood": {"primary": "neutral"}, "energy": 0.5, "preoccupations": [], "curiosity_queue": []}

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

    # Recent events
    events = state.get("recent_events", [])
    if events:
        recent = events[-2:]
        for ev in recent:
            line = ev.get("event", "")
            if ev.get("feeling"):
                line += f" (felt: {ev['feeling']})"
            parts.append(f"Recent: {line}")

    return "\n".join(parts)


def get_optimized_context(moby_dir, query=None, budget_tokens=1500):
    """Return the most relevant memory sections within a token budget."""
    memory_content = get_cached_memory(moby_dir)
    
    if not memory_content:
        return {"sections": [], "total_tokens": 0, "budget_tokens": budget_tokens,
                "sections_included": 0, "sections_total": 0, "sections_pruned": 0,
                "context": ""}

    sections = parse_memory_sections(memory_content)
    if not sections:
        return {"sections": [], "total_tokens": 0, "budget_tokens": budget_tokens,
                "sections_included": 0, "sections_total": 0, "sections_pruned": 0,
                "context": ""}

    # Tokenize query for keyword matching
    query_words = []
    if query:
        query_words = [w.lower() for w in re.split(r'\W+', query) if len(w) > 2]

    now_str = datetime.now(timezone.utc).isoformat()

    # Compute BM25 scores
    bm25 = bm25_scores(sections, query_words)

    # Score all sections
    scored = []
    for s in sections:
        structural = score_section(s, query_words, now_str)
        semantic = bm25.get(s["header"], 0) * 60
        scored.append({**s, "score": structural + semantic, "bm25": bm25.get(s["header"], 0)})

    scored.sort(key=lambda x: x["score"], reverse=True)

    # Pack sections within budget
    included = []
    total_tokens = 0
    for s in scored:
        section_text = f"## {s['header']}\n{s['body']}"
        section_tokens = estimate_tokens(section_text)

        if total_tokens + section_tokens > budget_tokens and included:
            continue

        included.append(s)
        total_tokens += section_tokens

    # Re-sort included by original order
    section_order = {s["header"]: i for i, s in enumerate(sections)}
    included.sort(key=lambda x: section_order.get(x["header"], 999))

    # Build context text
    context_parts = []
    for s in included:
        context_parts.append(f"## {s['header']}\n{s['body']}")

    context_text = "\n\n".join(context_parts)

    # Inject core.md (always included)
    core_context = get_core_context(moby_dir)
    if core_context:
        context_text = f"{core_context}\n\n{context_text}"
        total_tokens += estimate_tokens(core_context) + 5

    # Inject inner state (always included)
    inner_context = get_inner_context(moby_dir)
    if inner_context:
        context_text = f"## Inner State (right now)\n{inner_context}\n\n{context_text}"
        total_tokens += estimate_tokens(inner_context) + 10

    return {
        "sections": [{"header": s["header"], "score": s["score"],
                       "tokens": estimate_tokens(f"## {s['header']}\n{s['body']}")} for s in included],
        "total_tokens": total_tokens,
        "budget_tokens": budget_tokens,
        "sections_included": len(included),
        "sections_total": len(sections),
        "sections_pruned": len(sections) - len(included),
        "context": context_text,
    }


def get_explorations(moby_dir, query=None, limit=50):
    """List exploration files, optionally filtered by keyword."""
    explorations_dir = f"{moby_dir}/explorations"
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


def get_exploration(moby_dir, filename):
    """Read a single exploration file."""
    explorations_dir = f"{moby_dir}/explorations"
    fpath = os.path.join(explorations_dir, filename)
    if not os.path.exists(fpath) or not filename.endswith(".md"):
        return None
    with open(fpath) as f:
        return {"file": filename, "content": f.read()}


def get_exploration_stats(moby_dir):
    """Quick stats about explorations."""
    explorations_dir = f"{moby_dir}/explorations"
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
