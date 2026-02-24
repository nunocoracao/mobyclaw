// ─────────────────────────────────────────────────────────────
// Playwright browser automation tools
//
// Full headless browser via Playwright. The agent can navigate
// pages, see their content (accessibility snapshot + screenshots),
// click, type, fill forms, manage tabs, etc.
//
// Architecture:
//   - Single persistent browser context (personal agent = one user)
//   - Accessibility snapshots with aria-ref for element targeting
//   - Screenshots returned as base64 images
//   - Auto-launch on first use, idle timeout for cleanup
//
// Inspired by @playwright/mcp but integrated directly into
// our McpServer (no subprocess bridge needed).
// ─────────────────────────────────────────────────────────────

const { chromium } = require("playwright");
const { z } = require("zod");

// ── Browser lifecycle ──────────────────────────────────────

let browser = null;
let context = null;
let currentPage = null;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // close browser after 10min idle
const ACTION_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.log("[playwright] Idle timeout — closing browser");
    await closeBrowser();
  }, IDLE_TIMEOUT_MS);
}

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log("[playwright] Launching Chromium...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Europe/Lisbon",
    });
    // Block common annoyances
    await context.route(
      /\.(woff2?|ttf|otf)$/,
      (route) => route.abort()
    );
    currentPage = null;
    console.log("[playwright] Browser ready");
  }
  resetIdleTimer();
}

async function ensurePage() {
  await ensureBrowser();
  if (!currentPage || currentPage.isClosed()) {
    currentPage = await context.newPage();
    currentPage.setDefaultTimeout(ACTION_TIMEOUT_MS);
    currentPage.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  }
  return currentPage;
}

async function closeBrowser() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    context = null;
    currentPage = null;
    console.log("[playwright] Browser closed");
  }
}

// ── Snapshot helpers ────────────────────────────────────────

// Max compact snapshot size in chars. ~5000 chars ≈ ~1250 tokens.
const SNAPSHOT_MAX_CHARS = 5000;

async function takeSnapshot(page) {
  try {
    const snapshot = await page._snapshotForAI();
    return typeof snapshot === "string" ? snapshot : (snapshot.full || String(snapshot));
  } catch {
    // Fallback: Playwright accessibility tree
    try {
      const tree = await page.accessibility.snapshot({ interestingOnly: true });
      return tree ? renderA11yFallback(tree, 0) : "(empty page)";
    } catch {
      return "(snapshot unavailable)";
    }
  }
}

function renderA11yFallback(node, depth) {
  const indent = "  ".repeat(depth);
  const parts = [];
  let line = indent;
  if (node.role && node.role !== "none" && node.role !== "generic") line += node.role;
  if (node.name) line += ` "${node.name}"`;
  if (node.value) line += ` value="${node.value}"`;
  if (node.checked !== undefined) line += ` [${node.checked ? "checked" : "unchecked"}]`;
  if (line.trim()) parts.push(line);
  if (node.children) for (const c of node.children) parts.push(renderA11yFallback(c, depth + 1));
  return parts.join("\n");
}

// ── Tree-based snapshot trimming ────────────────────────────
//
// _snapshotForAI() returns the full accessibility tree.  Real-world sizes:
//   Hacker News  — 59 KB / 1044 lines / 650 refs
//   GitHub repo  — 53 KB / 908 lines / 657 refs
//   Wikipedia    — 135 KB / 2102 lines / 1151 refs
//
// The LLM bottleneck is processing these (10-20s per 15K tokens).
//
// This trimmer:
//   1. Parses the indentation-based text into a tree
//   2. Strips /url: metadata lines (agent uses refs, not raw URLs)
//   3. Unwraps pure-wrapper nodes (generic, cell, rowgroup, etc.)
//      that have no useful name — hoists their children up
//   4. Removes empty/spacer rows
//   5. Detects repeated sibling patterns and collapses them:
//      shows first N + "... and M more <role> items"
//   6. Re-serializes the pruned tree
//   7. Hard-caps with a truncation notice
//
// Result: 85-95% reduction while keeping every actionable element.

// Roles that are pure structural wrappers — unwrap if they have no useful name
const WRAPPER_ROLES = new Set([
  "generic", "none", "presentation", "rowgroup", "group",
  "cell", "row", "strong", "emphasis", "paragraph",
  "Section", "HeaderAsNonLandmark", "FooterAsNonLandmark",
]);

// Roles that are interactive (agent needs the ref to act on them)
const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "treeitem",
]);

// Structural roles that the agent doesn't need refs for
const STRUCTURAL_ROLES = new Set([
  "generic", "none", "presentation", "rowgroup", "group",
  "cell", "row", "table", "list", "listitem",
  "strong", "emphasis", "paragraph", "blockquote",
  "Section", "HeaderAsNonLandmark", "FooterAsNonLandmark",
  "region", "separator", "superscript", "subscript",
  "deletion", "insertion", "note",
]);

// ── Parse snapshot text → tree ──────────────────────────────

function parseSnapshotTree(text) {
  const lines = text.split("\n");
  const root = { role: "root", attrs: "", name: "", ref: "", children: [], depth: -1 };
  const stack = [root];

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    // Determine depth from leading spaces (2 spaces per indent level)
    const stripped = rawLine.replace(/^\s*-\s*/, "");
    const indent = rawLine.match(/^(\s*)/)[1].length;
    const depth = Math.floor(indent / 2);

    // Parse the line: "role "name" [ref=X] [attr] [cursor=Y]: trailing"
    const refMatch = stripped.match(/\[ref=(\w+)\]/);
    const ref = refMatch ? refMatch[1] : "";

    // Extract role (first word)
    const roleMatch = stripped.match(/^(\/url|[\w]+)/);
    const role = roleMatch ? roleMatch[1] : "";

    // Extract quoted name
    const nameMatch = stripped.match(/"([^"]*)"/); 
    const name = nameMatch ? nameMatch[1] : "";

    // Get remaining attributes (everything in [...] except ref)
    const allAttrs = [];
    for (const m of stripped.matchAll(/\[(\w+(?:=[^\]]*)?)\]/g)) {
      if (!m[1].startsWith("ref=")) allAttrs.push(m[1]);
    }

    // Trailing text after ":"
    let trailing = "";
    const colonIdx = stripped.lastIndexOf(":");
    // Only treat as trailing if it's at the end and not part of /url:
    if (colonIdx > 0 && role !== "/url" && !stripped.substring(colonIdx).includes("//")) {
      const after = stripped.substring(colonIdx + 1).trim();
      // Only if there's actual content after the colon and it's not just whitespace
      if (after && !after.startsWith("-")) trailing = after;
    }

    const node = {
      role,
      ref,
      name: name || trailing,
      attrs: allAttrs,
      children: [],
      depth,
    };

    // Find parent: pop stack until we find a node at depth-1
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

// ── Prune the tree ──────────────────────────────────────────

function pruneTree(node) {
  // 1. Remove /url: metadata lines (agent uses refs, not raw URLs)
  node.children = node.children.filter(c => c.role !== "/url");

  // 2. Recursively prune children first
  for (const child of node.children) pruneTree(child);

  // 3. Remove noise text nodes (pure punctuation/separators)
  node.children = node.children.filter(c => {
    if (c.role === "text" && c.name) {
      const t = c.name.trim();
      // Remove separator-only text: "|", "(", ")", "·", "-", "/"
      if (/^[|()·\-\/\\,;:!?.\s]+$/.test(t)) return false;
    }
    return true;
  });

  // 4. Remove completely empty nodes (no children, no name, no ref, not interactive)
  node.children = node.children.filter(c => {
    if (c.children.length > 0) return true;
    if (c.name) return true;
    if (c.ref && !STRUCTURAL_ROLES.has(c.role)) return true;
    if (INTERACTIVE_ROLES.has(c.role)) return true;
    if (c.role === "text") return !!c.name;
    if (c.role === "img") return true;
    return false;
  });

  // 5. Unwrap pure wrappers: if a node is a wrapper role,
  //    replace it with its children (hoist children up)
  //    A wrapper is unwrapped if:
  //    - It's a WRAPPER_ROLE with children
  //    - Its name is either empty OR the same text as its children would produce
  //      (like a cell whose name is just the concatenation of child text)
  const newChildren = [];
  for (const child of node.children) {
    if (
      WRAPPER_ROLES.has(child.role) &&
      child.children.length > 0 &&
      !INTERACTIVE_ROLES.has(child.role)
    ) {
      // Always hoist — the wrapper's name is just duplicated from children
      newChildren.push(...child.children);
    } else {
      newChildren.push(child);
    }
  }
  node.children = newChildren;

  // 6. Remove generics that are inside interactive elements (label noise)
  //    e.g., link -> generic "upvote" is just the link's label
  if (INTERACTIVE_ROLES.has(node.role)) {
    node.children = node.children.filter(c => {
      if (c.role === "generic" && c.name && c.children.length === 0) {
        // If this generic's name is already in the parent's name, skip it
        if (node.name && node.name.includes(c.name)) return false;
        // Otherwise, absorb its name into parent if parent has none
        if (!node.name) { node.name = c.name; return false; }
      }
      return true;
    });
  }

  // 7. Strip refs from structural-only nodes
  if (STRUCTURAL_ROLES.has(node.role) && !INTERACTIVE_ROLES.has(node.role)) {
    node.ref = "";
  }

  // 8. Remove empty rows (spacer rows in tables)
  node.children = node.children.filter(c => {
    if (c.role === "row" && c.children.length === 0 && !c.name) return false;
    return true;
  });

  // 9. Collapse single-child chains: if a node has exactly one child and
  //    the node itself has no meaningful info, replace with the child
  if (
    node.children.length === 1 &&
    !node.name &&
    !node.ref &&
    STRUCTURAL_ROLES.has(node.role) &&
    node.role !== "root"
  ) {
    const child = node.children[0];
    node.role = child.role;
    node.name = child.name;
    node.ref = child.ref;
    node.attrs = child.attrs;
    node.children = child.children;
  }
}

// ── Collapse repeated siblings ──────────────────────────────
//
// If a parent has many children with the same structure (e.g. 30 HN stories,
// 50 search results), show the first few and collapse the rest.

const MAX_SIMILAR_SIBLINGS = 20;

function nodeSignature(node) {
  // Structural fingerprint: role + direct child roles (ignore names/refs)
  const childRoles = node.children.slice(0, 5).map(c => c.role).join(",");
  return `${node.role}[${childRoles}]`;
}

function collapseSiblings(node) {
  // Recurse into children first
  for (const child of node.children) collapseSiblings(child);

  if (node.children.length <= MAX_SIMILAR_SIBLINGS + 2) return;

  // Strategy 1: Group consecutive identical-signature children
  const runs = [];
  let currentSig = null;
  let currentRun = [];

  for (const child of node.children) {
    const sig = nodeSignature(child);
    if (sig === currentSig) {
      currentRun.push(child);
    } else {
      if (currentRun.length > 0) runs.push({ sig: currentSig, nodes: currentRun });
      currentSig = sig;
      currentRun = [child];
    }
  }
  if (currentRun.length > 0) runs.push({ sig: currentSig, nodes: currentRun });

  // Strategy 2: If no single run is large enough, look for alternating patterns
  // (e.g., HN: row-A, row-B, row-A, row-B — pairs of rows per story)
  const maxRunLen = Math.max(...runs.map(r => r.nodes.length));
  if (maxRunLen <= MAX_SIMILAR_SIBLINGS && node.children.length > MAX_SIMILAR_SIBLINGS * 2) {
    // Just cap total children: keep first N, collapse rest, keep last 1
    const kept = node.children.slice(0, MAX_SIMILAR_SIBLINGS);
    const collapsed = node.children.length - MAX_SIMILAR_SIBLINGS - 1;
    const last = node.children[node.children.length - 1];
    if (collapsed > 0) {
      node.children = [
        ...kept,
        {
          role: "_collapsed",
          ref: "",
          name: `... ${collapsed} more items (use browser_scroll to see more)`,
          attrs: [],
          children: [],
          depth: 0,
        },
        last,
      ];
    }
    return;
  }

  // Apply per-run collapsing
  const newChildren = [];
  for (const run of runs) {
    if (run.nodes.length > MAX_SIMILAR_SIBLINGS + 2) {
      const kept = run.nodes.slice(0, MAX_SIMILAR_SIBLINGS);
      const collapsed = run.nodes.length - MAX_SIMILAR_SIBLINGS - 1;
      const last = run.nodes[run.nodes.length - 1];
      const itemRole = run.nodes[0].role || "items";
      newChildren.push(...kept);
      newChildren.push({
        role: "_collapsed",
        ref: "",
        name: `... ${collapsed} more ${itemRole}${collapsed > 1 ? "s" : ""} (use browser_scroll to see more)`,
        attrs: [],
        children: [],
        depth: 0,
      });
      newChildren.push(last);
    } else {
      newChildren.push(...run.nodes);
    }
  }
  node.children = newChildren;
}

// ── Serialize tree back to text ─────────────────────────────

function serializeTree(node, depth) {
  const lines = [];

  if (node.role !== "root") {
    const indent = "  ".repeat(depth);

    if (node.role === "_collapsed") {
      lines.push(indent + "- " + node.name);
      return lines;
    }

    if (node.role === "text") {
      // Text nodes: inline the content. Skip if empty.
      if (node.name) lines.push(indent + `- text: ${node.name}`);
      return lines;
    }

    // Skip nameless img nodes inside interactive elements (decorative icons)
    if (node.role === "img" && !node.name && node.children.length === 0) {
      return lines;
    }

    let line = indent + "- " + node.role;
    if (node.name) line += ` "${node.name}"`;
    if (node.ref) line += ` [ref=${node.ref}]`;
    for (const attr of (node.attrs || [])) {
      if (attr.startsWith("checked") || attr.startsWith("expanded") ||
          attr.startsWith("level=") || attr.startsWith("selected") ||
          attr.startsWith("disabled") || attr.startsWith("required") ||
          attr === "active") {
        line += ` [${attr}]`;
      }
    }
    lines.push(line);
  }

  for (const child of node.children) {
    lines.push(...serializeTree(child, node.role === "root" ? 0 : depth + 1));
  }

  return lines;
}

// ── Main trimSnapshot function ──────────────────────────────

function trimSnapshot(raw) {
  if (!raw || typeof raw !== "string") return raw || "";
  if (raw.length <= SNAPSHOT_MAX_CHARS) return raw;

  const origLines = raw.split("\n").length;

  // Parse → prune → collapse → serialize
  const tree = parseSnapshotTree(raw);
  pruneTree(tree);
  collapseSiblings(tree);
  const lines = serializeTree(tree, 0);
  let result = lines.join("\n");

  // Hard cap with truncation
  if (result.length > SNAPSHOT_MAX_CHARS) {
    let cutoff = result.lastIndexOf("\n", SNAPSHOT_MAX_CHARS - 120);
    if (cutoff < SNAPSHOT_MAX_CHARS * 0.4) cutoff = SNAPSHOT_MAX_CHARS - 120;
    result = result.slice(0, cutoff) +
      "\n... [truncated — use browser_scroll to see more content below]";
  }

  const finalLines = result.split("\n").length;
  const pct = Math.round((1 - finalLines / origLines) * 100);
  if (pct > 10) {
    result += `\n[${origLines}→${finalLines} lines, ${pct}% smaller]`;
  }

  return result;
}

async function pageHeader(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  return `Page: ${title || "(no title)"}\nURL: ${url}`;
}

/**
 * Build a snapshot response, optionally trimmed.
 * @param {Page} page
 * @param {boolean} compact - If true (default), trim the snapshot for speed
 */
async function snapshotResponse(page, compact = true) {
  const header = await pageHeader(page);
  const raw = await takeSnapshot(page);
  const snapshot = compact ? trimSnapshot(raw) : raw;
  return `${header}\n\n${snapshot}`;
}

// ── Element schema (shared) ─────────────────────────────────

const elementRef = z.object({
  ref: z
    .string()
    .describe(
      "Exact target element reference from the page snapshot (e.g. 's1e4')"
    ),
  element: z
    .string()
    .optional()
    .describe(
      "Human-readable element description (e.g. 'Sign up button')"
    ),
});

// ── Tool registration ───────────────────────────────────────

function registerPlaywrightTools(server) {

  // ── browser_navigate ──────────────────────────────────────

  server.tool(
    "browser_navigate",
    "Navigate to a URL in the browser. Returns an accessibility snapshot of the page " +
      "showing all interactive elements with ref IDs. Use these refs with browser_click, " +
      "browser_type, etc. to interact with the page.",
    {
      url: z.string().describe("The URL to navigate to"),
    },
    async ({ url }) => {
      try {
        let normalizedUrl = url;
        try {
          new URL(normalizedUrl);
        } catch {
          normalizedUrl = normalizedUrl.startsWith("localhost")
            ? "http://" + normalizedUrl
            : "https://" + normalizedUrl;
        }
        const page = await ensurePage();
        await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });
        // Short wait for JS to settle — don't use networkidle, it hangs
        // on sites with persistent connections (analytics, service workers)
        await page.waitForTimeout(1500);
        const text = await snapshotResponse(page);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Navigation error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── browser_snapshot ──────────────────────────────────────

  server.tool(
    "browser_snapshot",
    "Capture an accessibility snapshot of the current page. Returns a structured text " +
      "representation of the page with ref IDs for all interactive elements. Use this " +
      "to understand what's on the page before interacting. Better than screenshot for actions. " +
      "By default returns a compact snapshot (interactive elements + landmarks only). " +
      "Set full=true to get the complete accessibility tree (WARNING: can be very large, 15K+ tokens for complex pages).",
    {
      full: z
        .boolean()
        .optional()
        .describe("Return full uncompacted snapshot. Default: false (compact). Only use if you need every detail."),
    },
    async ({ full }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const text = await snapshotResponse(page, !full);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Snapshot error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── browser_screenshot ────────────────────────────────────

  server.tool(
    "browser_screenshot",
    "Take a screenshot of the current page. Returns the image as base64 PNG. " +
      "Useful for seeing visual layout, images, CAPTCHAs, etc. For identifying " +
      "interactive elements, use browser_snapshot instead.",
    {
      fullPage: z
        .boolean()
        .optional()
        .describe("Take full scrollable page screenshot instead of viewport only"),
    },
    async ({ fullPage }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const buffer = await page.screenshot({
          type: "png",
          fullPage: fullPage || false,
          scale: "css",
        });
        const base64 = buffer.toString("base64");
        const header = await pageHeader(page);
        return {
          content: [
            { type: "text", text: header },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Screenshot error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_click ─────────────────────────────────────────

  server.tool(
    "browser_click",
    "Click an element on the page. Use ref from browser_snapshot/browser_navigate. " +
      "Returns updated page snapshot after click.",
    {
      ref: z.string().describe("Element ref from page snapshot (e.g. 's1e4')"),
      element: z
        .string()
        .optional()
        .describe("Human-readable element description"),
      button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button to click (default: left)"),
      doubleClick: z
        .boolean()
        .optional()
        .describe("Double-click instead of single click"),
      modifiers: z
        .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
        .optional()
        .describe("Modifier keys to hold during click"),
    },
    async ({ ref, element, button, doubleClick, modifiers }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const locator = page.locator(`aria-ref=${ref}`);

        const opts = {};
        if (button) opts.button = button;
        if (modifiers) opts.modifiers = modifiers;

        if (doubleClick) {
          await locator.dblclick(opts);
        } else {
          await locator.click(opts);
        }

        // Wait for any navigation/update to settle
        await page
          .waitForLoadState("domcontentloaded", { timeout: 5000 })
          .catch(() => {});

        const text = await snapshotResponse(page);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Click error on ref "${ref}": ${err.message}\n\nTry taking a new snapshot to get updated refs.`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_type ──────────────────────────────────────────

  server.tool(
    "browser_type",
    "Type text into an editable element (input, textarea, contenteditable). " +
      "Clears the field first, then types the new text. Use ref from snapshot. " +
      "Optionally press Enter after typing to submit.",
    {
      ref: z.string().describe("Element ref from page snapshot"),
      element: z.string().optional().describe("Human-readable element description"),
      text: z.string().describe("Text to type into the element"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing (to submit form)"),
      slowly: z
        .boolean()
        .optional()
        .describe(
          "Type one character at a time (useful for triggering autocomplete/validation)"
        ),
    },
    async ({ ref, text, submit, slowly }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const locator = page.locator(`aria-ref=${ref}`);

        if (slowly) {
          await locator.pressSequentially(text);
        } else {
          await locator.fill(text);
        }

        if (submit) {
          await locator.press("Enter");
          await page
            .waitForLoadState("domcontentloaded", { timeout: 5000 })
            .catch(() => {});
        }

        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Type error on ref "${ref}": ${err.message}\n\nTry taking a new snapshot to get updated refs.`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_fill_form ─────────────────────────────────────

  server.tool(
    "browser_fill_form",
    "Fill multiple form fields at once. More efficient than calling browser_type " +
      "for each field. Provide an array of field refs and values.",
    {
      fields: z
        .array(
          z.object({
            ref: z.string().describe("Element ref from page snapshot"),
            name: z.string().describe("Human-readable field name"),
            type: z
              .enum(["textbox", "checkbox", "radio", "combobox"])
              .describe("Type of the field"),
            value: z
              .string()
              .describe(
                "Value to set. For checkboxes: 'true' or 'false'. For combobox: option text."
              ),
          })
        )
        .describe("Fields to fill"),
    },
    async ({ fields }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const results = [];

        for (const field of fields) {
          const locator = page.locator(`aria-ref=${field.ref}`);
          try {
            if (field.type === "textbox") {
              await locator.fill(field.value);
            } else if (
              field.type === "checkbox" ||
              field.type === "radio"
            ) {
              await locator.setChecked(field.value === "true");
            } else if (field.type === "combobox") {
              await locator.selectOption({ label: field.value });
            }
            results.push(`✓ ${field.name}: set to "${field.value}"`);
          } catch (err) {
            results.push(`✗ ${field.name}: ${err.message}`);
          }
        }

        const snapshot = await snapshotResponse(page);
        return {
          content: [
            {
              type: "text",
              text: `Form fill results:\n${results.join("\n")}\n\n${snapshot}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Fill form error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_select_option ─────────────────────────────────

  server.tool(
    "browser_select_option",
    "Select option(s) in a dropdown/select element.",
    {
      ref: z.string().describe("Element ref from page snapshot"),
      element: z.string().optional().describe("Human-readable element description"),
      values: z
        .array(z.string())
        .describe("Values to select in the dropdown"),
    },
    async ({ ref, values }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const locator = page.locator(`aria-ref=${ref}`);
        await locator.selectOption(values);
        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Select error on ref "${ref}": ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_hover ─────────────────────────────────────────

  server.tool(
    "browser_hover",
    "Hover over an element. Useful for revealing tooltips, dropdown menus, etc.",
    {
      ref: z.string().describe("Element ref from page snapshot"),
      element: z.string().optional().describe("Human-readable element description"),
    },
    async ({ ref }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const locator = page.locator(`aria-ref=${ref}`);
        await locator.hover();
        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Hover error on ref "${ref}": ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_press_key ─────────────────────────────────────

  server.tool(
    "browser_press_key",
    "Press a keyboard key. Use for Enter, Escape, Tab, ArrowDown, etc. " +
      "Also supports key combinations like 'Control+a'.",
    {
      key: z
        .string()
        .describe(
          "Key to press (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Control+a')"
        ),
    },
    async ({ key }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        await page.keyboard.press(key);

        await page
          .waitForLoadState("domcontentloaded", { timeout: 3000 })
          .catch(() => {});

        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Key press error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_scroll ────────────────────────────────────────

  server.tool(
    "browser_scroll",
    "Scroll the page or a specific element. Useful for seeing content below the fold.",
    {
      direction: z
        .enum(["up", "down"])
        .describe("Direction to scroll"),
      amount: z
        .number()
        .optional()
        .describe("Pixels to scroll (default: 500)"),
    },
    async ({ direction, amount }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const px = amount || 500;
        const delta = direction === "down" ? px : -px;
        await page.mouse.wheel(0, delta);
        // Wait for any lazy-loading
        await page.waitForTimeout(500);
        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Scroll error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_back ──────────────────────────────────────────

  server.tool(
    "browser_back",
    "Navigate back to the previous page (like clicking the back button).",
    {},
    async () => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        await page.goBack({ waitUntil: "domcontentloaded" });
        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Back navigation error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_forward ───────────────────────────────────────

  server.tool(
    "browser_forward",
    "Navigate forward (like clicking the forward button).",
    {},
    async () => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        await page.goForward({ waitUntil: "domcontentloaded" });
        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Forward navigation error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_wait ──────────────────────────────────────────

  server.tool(
    "browser_wait",
    "Wait for a condition: specific text to appear/disappear, or a fixed time. " +
      "Useful after clicking a button to wait for the page to update.",
    {
      time: z
        .number()
        .optional()
        .describe("Time to wait in seconds (max 30)"),
      text: z
        .string()
        .optional()
        .describe("Text to wait for to appear on the page"),
      textGone: z
        .string()
        .optional()
        .describe("Text to wait for to disappear from the page"),
    },
    async ({ time, text, textGone }) => {
      try {
        if (!time && !text && !textGone) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide at least one of: time, text, or textGone",
              },
            ],
            isError: true,
          };
        }

        const page = await ensurePage();
        resetIdleTimer();

        if (time) {
          await page.waitForTimeout(Math.min(time * 1000, 30000));
        }
        if (text) {
          await page
            .getByText(text)
            .first()
            .waitFor({ state: "visible", timeout: 15000 });
        }
        if (textGone) {
          await page
            .getByText(textGone)
            .first()
            .waitFor({ state: "hidden", timeout: 15000 });
        }

        const snapshot = await snapshotResponse(page);
        return { content: [{ type: "text", text: snapshot }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Wait error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_tabs ──────────────────────────────────────────

  server.tool(
    "browser_tabs",
    "List, create, close, or select browser tabs.",
    {
      action: z
        .enum(["list", "new", "close", "select"])
        .describe("Tab operation to perform"),
      url: z
        .string()
        .optional()
        .describe("URL to open in new tab (for action='new')"),
      index: z
        .number()
        .optional()
        .describe("Tab index for close/select (0-based)"),
    },
    async ({ action, url, index }) => {
      try {
        await ensureBrowser();
        resetIdleTimer();

        const pages = context.pages();

        switch (action) {
          case "list": {
            const tabs = await Promise.all(
              pages.map(async (p, i) => {
                const title = await p.title().catch(() => "");
                const isCurrent = p === currentPage ? " (current)" : "";
                return `[${i}] ${title || "(blank)"} — ${p.url()}${isCurrent}`;
              })
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Open tabs (${pages.length}):\n${tabs.join("\n")}`,
                },
              ],
            };
          }

          case "new": {
            const page = await context.newPage();
            page.setDefaultTimeout(ACTION_TIMEOUT_MS);
            page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
            currentPage = page;
            if (url) {
              await page.goto(url, { waitUntil: "domcontentloaded" });
              await page.waitForTimeout(1500);
            }
            const snapshot = await snapshotResponse(page);
            return { content: [{ type: "text", text: snapshot }] };
          }

          case "close": {
            const idx = index ?? pages.indexOf(currentPage);
            if (idx < 0 || idx >= pages.length) {
              return {
                content: [{ type: "text", text: `Invalid tab index: ${idx}` }],
                isError: true,
              };
            }
            await pages[idx].close();
            // Switch to last remaining tab
            const remaining = context.pages();
            currentPage = remaining.length > 0 ? remaining[remaining.length - 1] : null;
            if (currentPage) {
              const snapshot = await snapshotResponse(currentPage);
              return { content: [{ type: "text", text: `Tab closed. ${snapshot}` }] };
            }
            return {
              content: [{ type: "text", text: "All tabs closed." }],
            };
          }

          case "select": {
            if (index === undefined || index < 0 || index >= pages.length) {
              return {
                content: [{ type: "text", text: `Invalid tab index: ${index}` }],
                isError: true,
              };
            }
            currentPage = pages[index];
            await currentPage.bringToFront();
            const snapshot = await snapshotResponse(currentPage);
            return { content: [{ type: "text", text: snapshot }] };
          }
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tab error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── browser_close ─────────────────────────────────────────

  server.tool(
    "browser_close",
    "Close the browser entirely. Frees resources. A new browser will be " +
      "launched automatically on the next browser_navigate call.",
    {},
    async () => {
      try {
        await closeBrowser();
        return {
          content: [{ type: "text", text: "Browser closed." }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Close error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ── browser_eval ──────────────────────────────────────────

  server.tool(
    "browser_eval",
    "Execute JavaScript in the browser page. Returns the result. Use for " +
      "advanced interactions, reading page data, or debugging.",
    {
      expression: z
        .string()
        .describe("JavaScript expression to evaluate in the page context"),
    },
    async ({ expression }) => {
      try {
        const page = await ensurePage();
        resetIdleTimer();
        const result = await page.evaluate(expression);
        const text =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2) ?? "undefined";
        return {
          content: [
            { type: "text", text: `Result:\n${text}` },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Eval error: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );
}

// Export for admin status
function getBrowserStatus() {
  if (!browser || !browser.isConnected()) return { status: "closed" };
  const pages = context?.pages() || [];
  return {
    status: "open",
    tabs: pages.length,
    currentUrl: currentPage?.url() || null,
  };
}

module.exports = { registerPlaywrightTools, getBrowserStatus, closeBrowser };
