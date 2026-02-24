// ─────────────────────────────────────────────────────────────
// mobyclaw tool-gateway — MCP aggregator (stateless mode)
//
// Each POST creates a fresh MCP server+transport pair.
// No session tracking needed — tools are stateless anyway.
//
// Browser tools are the exception: they maintain a persistent
// browser context across requests (one browser per agent).
// ─────────────────────────────────────────────────────────────

const http = require("http");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express = require("express");

const { registerBrowserTools } = require("./tools/browser.js");
const { registerWeatherTools } = require("./tools/weather.js");
const {
  registerPlaywrightTools,
  getBrowserStatus,
  closeBrowser,
} = require("./tools/playwright.js");

const MCP_PORT = parseInt(process.env.MCP_PORT || "8081", 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3100", 10);

// Collect tool names for admin API
const TOOL_NAMES = [
  // Lightweight web tools
  "browser_fetch",
  "browser_search",
  "weather_get",
  // Playwright browser automation
  "browser_navigate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_hover",
  "browser_press_key",
  "browser_scroll",
  "browser_back",
  "browser_forward",
  "browser_wait",
  "browser_tabs",
  "browser_close",
  "browser_eval",
];

function createMcpServer() {
  const server = new McpServer({
    name: "mobyclaw-tool-gateway",
    version: "0.2.0",
  });
  registerBrowserTools(server);
  registerWeatherTools(server);
  registerPlaywrightTools(server);
  return server;
}

function startMcpHttpServer() {
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // Only POST supported in stateless mode
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
      return;
    }

    try {
      // Stateless: new server + transport per request
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
      // Clean up after request
      await transport.close();
      await server.close();
    } catch (err) {
      console.error("[mcp] Error:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err.message },
            id: null,
          })
        );
      }
    }
  });

  httpServer.listen(MCP_PORT, "0.0.0.0", () => {
    console.log(`[mcp] Streamable HTTP on :${MCP_PORT} (stateless)`);
  });
}

function startAdminServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const browserStatus = getBrowserStatus();
    res.json({
      status: "ok",
      uptime: process.uptime(),
      browser: browserStatus,
    });
  });

  app.get("/servers", (_req, res) => {
    const browserStatus = getBrowserStatus();
    res.json({
      servers: [
        {
          id: "builtin",
          name: "Built-in Tools",
          status: "connected",
          tools: TOOL_NAMES,
          browser: browserStatus,
        },
      ],
    });
  });

  // Force-close browser (useful for debugging)
  app.post("/browser/close", async (_req, res) => {
    await closeBrowser();
    res.json({ status: "closed" });
  });

  app.listen(ADMIN_PORT, "0.0.0.0", () => {
    console.log(`[admin] Admin API on :${ADMIN_PORT}`);
  });
}

async function main() {
  console.log("+--------------------------------------+");
  console.log("|  mobyclaw tool-gateway starting...    |");
  console.log("+--------------------------------------+\n");

  const server = createMcpServer();
  console.log(`[mcp] Registered ${TOOL_NAMES.length} tools: ${TOOL_NAMES.join(", ")}`);

  startMcpHttpServer();
  startAdminServer();

  console.log("\nTool gateway ready.");
  console.log("[playwright] Browser will launch on first use\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
