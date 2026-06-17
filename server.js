import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStatusData, handleChatBody, readJsonRequest, sendJson } from "./api/_shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, await getStatusData());
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonRequest(req);
      const result = await handleChatBody(body);
      return sendJson(res, result.status, result.data);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error.message || "서버 오류가 발생했습니다.",
      errorCode: error.code || "SERVER_ERROR",
      diagnosticId: error.diagnosticId || null,
      apiKeyIndex: error.apiKeyIndex || null,
      modelUsed: error.model || null,
      httpStatus: error.httpStatus || null
    });
  }
});

server.listen(port, () => {
  console.log(`경제총조사 산업분류 챗봇: http://localhost:${port}`);
});

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(publicDir, decoded));

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
