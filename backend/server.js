/**
 * server.js  (zero-dependency version)
 * ------------------------------------------------------------------
 * Runs with nothing but `node server.js` — no npm install, no
 * node_modules, no package.json. Everything here comes from Node's
 * built-in modules: http, fs, path.
 *
 * It does two jobs:
 *   1. Serves the static frontend (index.html, chat.html, css/, js/).
 *   2. Handles POST /api/chat, streaming Nova's reply from
 *      langchainClient.js straight through to the browser.
 * ------------------------------------------------------------------
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { streamNovaResponse, hasApiKeyConfigured } = require("./langchainClient");

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const ENV_FILE = path.join(__dirname, ".env");

// ------------------------------------------------------------------
// Tiny hand-rolled ".env" reader — stands in for the `dotenv` package.
// Reads KEY=VALUE lines, skips blanks/comments, strips matching quotes,
// and never overwrites a variable already set in the real environment.
// ------------------------------------------------------------------
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(ENV_FILE);

// ------------------------------------------------------------------
// Static file serving
// ------------------------------------------------------------------
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const resolvedPath = path.normalize(path.join(FRONTEND_DIR, requestedPath));

  // Guard against path traversal, e.g. a request for "/../backend/.env".
  if (!resolvedPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }

  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ------------------------------------------------------------------
// POST /api/chat
// ------------------------------------------------------------------

/** Reads the full request body before parsing JSON (requests are small chat payloads). */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000 && !settled) {
        // 1MB safety cap — a chat message should never be this large.
        settled = true;
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!settled) resolve(body);
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

async function handleChat(req, res) {
  // Fail fast, with a proper JSON error, before any headers are sent.
  if (!hasApiKeyConfigured()) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Missing NVIDIA_API_KEY. Copy backend/.env.example to backend/.env and add your key.",
      })
    );
    return;
  }

  let messages;
  try {
    const rawBody = await readRequestBody(req);
    const parsed = JSON.parse(rawBody || "{}");
    messages = parsed.messages;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body." }));
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`messages` must be a non-empty array." }));
    return;
  }

  // From here on headers are committed — mid-stream failures can only
  // append a plain-text notice, not switch to a JSON error response.
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no", // disable proxy buffering, e.g. on Nginx
  });

  try {
    for await (const chunk of streamNovaResponse(messages)) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error("Nova chat error:", error);
    const errorMessage = error && error.message
      ? `\n\n⚠️ ${error.message}`
      : "\n\n⚠️ Nova lost connection mid-reply. Please try again.";
    res.end(errorMessage);
  }
}

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "nova-backend" }));
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`✨ Nova is running at http://localhost:${PORT}`);
  if (!hasApiKeyConfigured()) {
    console.warn("⚠️  NVIDIA_API_KEY not set — copy backend/.env.example to backend/.env and add your key.");
  }
});
