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

// Max snapshot size in chars. ~6000 chars ≈ ~1500 tokens.
// Keeps LLM processing fast while preserving all interactive elements.
const SNAPSHOT_MAX_CHARS = 6000;

async function takeSnapshot(page) {
  try {
    const snapshot = await page._snapshotForAI();
    return snapshot.full || snapshot;
  } catch (err) {
    // Fallback: manual accessibility snapshot
    return await fallbackSnapshot(page);
  }
}

async function fallbackSnapshot(page) {
  // Use Playwright's accessibility snapshot as fallback
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
  if (!snapshot) return "Page is empty or not accessible.";
  return formatA11yTree(snapshot, 0);
}

function formatA11yTree(node, depth) {
  const indent = "  ".repeat(depth);
  const parts = [];

  let line = indent;
  if (node.role && node.role !== "none" && node.role !== "generic") {
    line += `${node.role}`;
  }
  if (node.name) {
    line += ` "${node.name}"`;
  }
  if (node.value) {
    line += ` value="${node.value}"`;
  }
  if (node.checked !== undefined) {
    line += ` [${node.checked ? "checked" : "unchecked"}]`;
  }
  if (node.pressed !== undefined) {
    line += ` [${node.pressed ? "pressed" : "not pressed"}]`;
  }
  if (line.trim()) parts.push(line);

  if (node.children) {
    for (const child of node.children) {
      parts.push(formatA11yTree(child, depth + 1));
    }
  }
  return parts.join("\n");
}

// ── Snapshot trimming ───────────────────────────────────────
//
// _snapshotForAI() returns the full accessibility tree which can be
// 15K+ tokens for content-heavy pages (e.g., Hacker News = 59KB).
// The LLM spends 10-20s processing each massive snapshot.
//
// Strategy:
//   1. Parse lines, classify as interactive (has ref) or decorative
//   2. Keep all interactive elements + surrounding text context
//   3. Collapse runs of non-interactive content (show count)
//   4. Remove noise roles (generic wrappers, rowgroup, presentation)
//   5. Hard cap at SNAPSHOT_MAX_CHARS with truncation notice
//
// The agent can request full=true on browser_snapshot if needed.

// Roles that are just structural wrappers with no user-facing meaning
const NOISE_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "rowgroup",
  "group",
  "Section",
  "HeaderAsNonLandmark",
  "FooterAsNonLandmark",
]);

// Roles that indicate interactive or high-value elements
const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
]);

// Regex to detect ref IDs in snapshot lines (e.g., [ref=s1e4])
const REF_PATTERN = /\[ref=\w+\]/;

/**
 * Trim a raw _snapshotForAI() string to keep it under the char limit.
 *
 * Algorithm:
 *   - Split into lines
 *   - Mark each line as "keep" (has a ref, is interactive, is a landmark,
 *     or is within CONTEXT_RADIUS of a kept line) or "skip"
 *   - Replace consecutive skipped lines with a summary like
 *     "  ... (12 more items)"
 *   - If still over limit, hard-truncate with notice
 */
function trimSnapshot(raw) {
  if (!raw || typeof raw !== "string") return raw || "";

  // If already small enough, return as-is
  if (raw.length <= SNAPSHOT_MAX_CHARS) return raw;

  const lines = raw.split("\n");
  const totalLines = lines.length;

  // Phase 1: Classify each line
  const keep = new Array(totalLines).fill(false);

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Always keep lines with element refs (interactive elements)
    if (REF_PATTERN.test(line)) {
      keep[i] = true;
      continue;
    }

    // Keep landmark roles (navigation, main, banner, contentinfo, etc.)
    const firstWord = line.split(/[\s"(\[]/)[0].toLowerCase();
    if (
      firstWord === "navigation" ||
      firstWord === "main" ||
      firstWord === "banner" ||
      firstWord === "contentinfo" ||
      firstWord === "complementary" ||
      firstWord === "form" ||
      firstWord === "search" ||
      firstWord === "dialog" ||
      firstWord === "alertdialog" ||
      firstWord === "alert" ||
      firstWord === "heading" ||
      firstWord === "table" ||
      firstWord === "list" ||
      firstWord === "img"
    ) {
      keep[i] = true;
      continue;
    }
  }

  // Phase 2: Context — keep 1 line above and below each kept line
  // so the agent has enough context to understand the structure
  const keepWithContext = [...keep];
  for (let i = 0; i < totalLines; i++) {
    if (keep[i]) {
      if (i > 0) keepWithContext[i - 1] = true;
      if (i < totalLines - 1) keepWithContext[i + 1] = true;
    }
  }

  // Phase 3: Build trimmed output, collapsing skipped runs
  const output = [];
  let skippedCount = 0;
  let lastIndent = "";

  for (let i = 0; i < totalLines; i++) {
    if (keepWithContext[i] || !lines[i].trim()) {
      // Flush skipped summary if we had any
      if (skippedCount > 0) {
        if (skippedCount >= 3) {
          output.push(`${lastIndent}  ... (${skippedCount} more items)`);
        } else {
          // For 1-2 skipped lines, cheaper to just include them
          for (let j = i - skippedCount; j < i; j++) {
            output.push(lines[j]);
          }
        }
        skippedCount = 0;
      }
      output.push(lines[i]);
    } else {
      if (skippedCount === 0) {
        // Capture indent of first skipped line's parent for alignment
        const match = lines[i].match(/^(\s*)/);
        lastIndent = match ? match[1] : "";
      }
      skippedCount++;
    }
  }

  // Flush trailing skipped
  if (skippedCount > 0 && skippedCount >= 3) {
    output.push(`${lastIndent}  ... (${skippedCount} more items)`);
  } else if (skippedCount > 0) {
    for (let j = totalLines - skippedCount; j < totalLines; j++) {
      output.push(lines[j]);
    }
  }

  let result = output.join("\n");

  // Phase 4: Hard cap — if trimming wasn't enough, truncate
  if (result.length > SNAPSHOT_MAX_CHARS) {
    // Find a clean line break near the limit
    let cutoff = result.lastIndexOf("\n", SNAPSHOT_MAX_CHARS - 100);
    if (cutoff < SNAPSHOT_MAX_CHARS * 0.5) cutoff = SNAPSHOT_MAX_CHARS - 100;
    result =
      result.slice(0, cutoff) +
      "\n\n... [snapshot truncated — use browser_scroll to see more, or browser_snapshot with full=true]";
  }

  const originalLines = totalLines;
  const keptLines = output.length;
  const ratio = Math.round((1 - keptLines / originalLines) * 100);
  if (ratio > 10) {
    result += `\n\n[Trimmed: ${originalLines} → ${keptLines} lines (${ratio}% reduction)]`;
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
