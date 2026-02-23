// ─────────────────────────────────────────────────────────────
// Tool label formatting (shared by SSE endpoint + Telegram)
//
// Produces a human-readable one-liner for each tool call.
//   Without args:  "Reading file"
//   With args:     "Reading file: ~/.mobyclaw/MEMORY.md"
// ─────────────────────────────────────────────────────────────

const TOOL_LABELS = {
  shell:                 "Running command",
  read_file:             "Reading file",
  write_file:            "Writing file",
  edit_file:             "Editing file",
  read_multiple_files:   "Reading files",
  search_files_content:  "Searching files",
  directory_tree:        "Listing directory",
  list_directory:        "Listing directory",
  fetch:                 "Fetching URL",
  think:                 "Thinking deeply",
};

function formatToolLabel(name, args) {
  const label = TOOL_LABELS[name] || `Using ${name}`;
  if (!args) return label;

  const detail = extractDetail(name, args);
  return detail ? `${label}: ${detail}` : label;
}

function extractDetail(name, args) {
  try {
    switch (name) {
      case "shell":
        return truncate(args.cmd || args.command, 60);

      case "read_file":
      case "write_file":
      case "edit_file":
        return shortPath(args.path);

      case "read_multiple_files":
        if (Array.isArray(args.paths) && args.paths.length > 0) {
          const shown = args.paths.slice(0, 3).map(shortPath);
          const more = args.paths.length > 3 ? ` (+${args.paths.length - 3} more)` : "";
          return shown.join(", ") + more;
        }
        return null;

      case "search_files_content":
        return args.query
          ? `"${truncate(args.query, 30)}" in ${shortPath(args.path || ".")}`
          : null;

      case "directory_tree":
      case "list_directory":
        return shortPath(args.path || ".");

      case "fetch":
        if (Array.isArray(args.urls) && args.urls.length > 0) {
          return truncate(args.urls[0], 60) +
            (args.urls.length > 1 ? ` (+${args.urls.length - 1})` : "");
        }
        return truncate(args.url, 60) || null;

      case "think":
        return null;

      default:
        return null;
    }
  } catch {
    return null;
  }
}

function shortPath(p) {
  if (!p) return null;
  if (p.length <= 40) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function truncate(s, max) {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

module.exports = { formatToolLabel };
