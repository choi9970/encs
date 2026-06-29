import { getAnalyticsData, readJsonRequest, recordVisit, sendJson } from "./_shared.js";

export default async function handler(req, res) {
  if (req.method === "POST") {
    const body = await readJsonRequest(req, 64 * 1024);
    return sendJson(res, 200, await recordVisit(body));
  }

  if (req.method === "GET") {
    const url = new URL(req.url || "/api/analytics", "https://encs.local");
    const wantsLogs = url.searchParams.get("logs") === "1";
    if (wantsLogs && !isValidAdminToken(url.searchParams.get("token"))) {
      return sendJson(res, 403, { error: "로그 조회 권한이 없습니다." });
    }

    return sendJson(res, 200, await getAnalyticsData({
      includeLogs: wantsLogs,
      limit: Number(url.searchParams.get("limit") || 100)
    }));
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}

function isValidAdminToken(token) {
  const expected = process.env.ANALYTICS_ADMIN_TOKEN || "";
  return Boolean(expected && token && token === expected);
}
