// ─────────────────────────────────────────────────────────────
// Agent Client — talks to cagent's HTTP API
//
// Streaming callbacks:
//   onToken(text)              — response text token
//   onToolStart(name)          — tool call begins (name known)
//   onToolDetail(name, args)   — tool call ready with full arguments
//   onToolEnd(name, success)   — tool call finished (success=bool)
//   onError(err)               — stream error
// ─────────────────────────────────────────────────────────────

const http = require("http");

const AGENT_NAME = process.env.AGENT_NAME || "soul";
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || "600000", 10);

class AgentClient {
  constructor(baseUrl) {
    const url = new URL(baseUrl);
    this.host = url.hostname;
    this.port = url.port || 80;
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        agent: false,
        headers: { "Content-Type": "application/json" },
      };
      const req = http.request(options, resolve);
      req.on("error", reject);
      if (body) {
        req.write(typeof body === "string" ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  _readBody(res) {
    return new Promise((resolve, reject) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
  }

  async waitForReady(timeoutMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this._request("GET", "/api/ping");
        await this._readBody(res);
        if (res.statusCode === 200) return;
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Agent not ready after ${timeoutMs / 1000}s`);
  }

  async createSession() {
    const res = await this._request("POST", "/api/sessions", {
      tools_approved: true,
    });
    if (res.statusCode !== 200) {
      const body = await this._readBody(res);
      throw new Error(`Failed to create session: ${res.statusCode} ${body}`);
    }
    const body = await this._readBody(res);
    return JSON.parse(body).id;
  }

  async prompt(message, sessionId) {
    return this.promptStream(message, sessionId);
  }

  /**
   * Streaming prompt.
   *
   * cagent SSE event lifecycle for tool calls:
   *   partial_tool_call  → tool name being assembled (streaming)
   *   tool_call          → complete tool call with full args, about to execute
   *   tool_call_response → result with { result: { isError: bool } }
   *
   * We fire:
   *   onToolStart  on first partial_tool_call (fast: shows ⏳ immediately)
   *   onToolDetail on tool_call (has parsed args for display)
   *   onToolEnd    on tool_call_response (success/failure)
   */
  promptStream(message, sessionId, callbacks = {}) {
    const { onToken, onToolStart, onToolDetail, onToolEnd, onError } =
      callbacks;
    const path = `/api/sessions/${sessionId}/agent/${AGENT_NAME}`;
    const body = JSON.stringify([{ role: "user", content: message }]);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method: "POST",
        agent: false,
        timeout: RUN_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (c) => (errBody += c));
          res.on("end", () =>
            reject(new Error(`Agent returned ${res.statusCode}: ${errBody}`))
          );
          return;
        }

        let result = "";
        let buffer = "";
        let lastActivity = Date.now();
        let currentToolName = null;

        res.setEncoding("utf8");

        const activityCheck = setInterval(() => {
          if (Date.now() - lastActivity > 15 * 60 * 1000) {
            clearInterval(activityCheck);
            res.destroy(new Error("No data from agent for 15 minutes"));
          }
        }, 30_000);

        res.on("data", (chunk) => {
          lastActivity = Date.now();
          buffer += chunk;

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));

              switch (event.type) {
                case "agent_choice":
                  if (event.content) {
                    result += event.content;
                    if (onToken) onToken(event.content);
                  }
                  break;

                case "partial_tool_call": {
                  const name = event.tool_call?.function?.name;
                  if (name && name !== currentToolName) {
                    currentToolName = name;
                    if (onToolStart) onToolStart(name);
                  }
                  break;
                }

                case "tool_call": {
                  // Complete tool call with full arguments — about to execute
                  const name =
                    event.tool_call?.function?.name || currentToolName;
                  const argsStr = event.tool_call?.function?.arguments;
                  if (onToolDetail && name) {
                    let args = null;
                    try {
                      args = argsStr ? JSON.parse(argsStr) : null;
                    } catch {
                      /* unparseable */
                    }
                    onToolDetail(name, args);
                  }
                  break;
                }

                case "tool_call_response": {
                  const isError = event.result?.isError === true;
                  const toolName =
                    event.tool_call?.function?.name || currentToolName;
                  if (onToolEnd) onToolEnd(toolName, !isError);
                  currentToolName = null;
                  break;
                }

                case "error":
                  if (onError)
                    onError(
                      event.message || event.error || JSON.stringify(event)
                    );
                  break;
              }
            } catch {
              // skip malformed
            }
          }
        });

        res.on("end", () => {
          clearInterval(activityCheck);
          if (buffer.startsWith("data: ")) {
            try {
              const event = JSON.parse(buffer.slice(6));
              if (event.type === "agent_choice" && event.content) {
                result += event.content;
                if (onToken) onToken(event.content);
              }
            } catch {
              /* skip */
            }
          }
          resolve(result.trim());
        });

        res.on("error", (err) => {
          clearInterval(activityCheck);
          reject(err);
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(
          new Error(`Agent request timed out after ${RUN_TIMEOUT_MS / 1000}s`)
        );
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { AgentClient };
