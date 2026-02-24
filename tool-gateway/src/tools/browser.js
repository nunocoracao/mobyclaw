// ─────────────────────────────────────────────────────────────
// Browser tools — web fetching and search
//
// Inspired by OpenClaw's browser tool but simplified:
// no headless browser, no Playwright. Uses HTTP fetch +
// Readability for clean text extraction.
//
// Tools:
//   browser_fetch  — fetch a URL, return clean readable text
//   browser_search — search the web via DuckDuckGo
// ─────────────────────────────────────────────────────────────

const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const { z } = require("zod");

const FETCH_TIMEOUT_MS = 15000;
const MAX_CONTENT_LENGTH = 100000; // ~100KB of text
const USER_AGENT =
  "Mozilla/5.0 (compatible; Mobyclaw/1.0; +https://github.com/nunocoracao/mobyclaw)";

/**
 * Register browser tools on an MCP server.
 */
function registerBrowserTools(server) {
  // -- browser_fetch ------------------------------------------------

  server.tool(
    "browser_fetch",
    "Fetch a URL and return its content as clean, readable text (like reader mode). " +
      "Strips navigation, ads, and boilerplate. Returns the main content of the page. " +
      "Use for reading articles, documentation, blog posts, etc.",
    {
      url: z.string().describe("The URL to fetch"),
      raw: z
        .boolean()
        .optional()
        .describe(
          "If true, return raw HTML instead of extracted text. Default: false"
        ),
    },
    async ({ url, raw }) => {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: "follow",
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error: HTTP ${response.status} ${response.statusText} for ${url}`,
              },
            ],
            isError: true,
          };
        }

        const contentType = response.headers.get("content-type") || "";
        const html = await response.text();

        // If not HTML, return as-is (text, JSON, etc.)
        if (!contentType.includes("html")) {
          const text = html.slice(0, MAX_CONTENT_LENGTH);
          return {
            content: [
              {
                type: "text",
                text: `Content-Type: ${contentType}\n\n${text}`,
              },
            ],
          };
        }

        if (raw) {
          return {
            content: [
              {
                type: "text",
                text: html.slice(0, MAX_CONTENT_LENGTH),
              },
            ],
          };
        }

        // Extract readable content using Readability
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article && article.textContent) {
          const title = article.title ? `# ${article.title}\n\n` : "";
          const text = (title + article.textContent)
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, MAX_CONTENT_LENGTH);

          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
          };
        }

        // Fallback: basic text extraction
        const dom2 = new JSDOM(html);
        const body = dom2.window.document.body;

        // Remove script, style, nav, footer
        for (const tag of ["script", "style", "nav", "footer", "header"]) {
          for (const el of body.querySelectorAll(tag)) {
            el.remove();
          }
        }

        const text = (body.textContent || "")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]+/g, " ")
          .trim()
          .slice(0, MAX_CONTENT_LENGTH);

        return {
          content: [
            {
              type: "text",
              text: text || "Could not extract text content from this page.",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching ${url}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -- browser_search -----------------------------------------------

  server.tool(
    "browser_search",
    "Search the web using DuckDuckGo. Returns a list of results with titles, " +
      "URLs, and snippets. Use for finding information, looking up topics, etc.",
    {
      query: z.string().describe("The search query"),
      max_results: z
        .number()
        .optional()
        .describe(
          "Maximum number of results to return (default: 8, max: 20)"
        ),
    },
    async ({ query, max_results }) => {
      const limit = Math.min(max_results || 8, 20);

      try {
        // DuckDuckGo HTML lite — reliable, no API key needed
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Search failed: HTTP ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const html = await response.text();
        const { load } = require("cheerio");
        const $ = load(html);

        const results = [];
        $(".result").each((i, el) => {
          if (results.length >= limit) return;

          const titleEl = $(el).find(".result__a");
          const snippetEl = $(el).find(".result__snippet");
          const urlEl = $(el).find(".result__url");

          const title = titleEl.text().trim();
          let href = titleEl.attr("href") || "";
          const snippet = snippetEl.text().trim();
          const displayUrl = urlEl.text().trim();

          // DuckDuckGo wraps URLs in a redirect
          if (href.includes("uddg=")) {
            try {
              const parsed = new URL("https://duckduckgo.com" + href);
              href = decodeURIComponent(parsed.searchParams.get("uddg") || href);
            } catch {
              // keep original
            }
          }

          if (title && (href || displayUrl)) {
            results.push({
              title,
              url: href || `https://${displayUrl}`,
              snippet: snippet || "",
            });
          }
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results found for: "${query}"`,
              },
            ],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Search results for "${query}":\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Search error: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

module.exports = { registerBrowserTools };
