import { handleChatBody, readJsonRequest, sendJson } from "./_shared.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = await readJsonRequest(req);
    const result = await handleChatBody(body);
    return sendJson(res, result.status, result.data);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: error.message || "서버 오류가 발생했습니다.",
      errorCode: error.code || "SERVER_ERROR",
      diagnosticId: error.diagnosticId || null,
      apiKeyIndex: error.apiKeyIndex || null,
      modelUsed: error.model || null,
      httpStatus: error.httpStatus || null
    });
  }
}
