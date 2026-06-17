import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const industryFileName = "ecensus_industry_full.json";
export const unclassifiableMessage =
  "어떤 기업의 활동에 대해 알려주시면 산업분류를 판정해 드릴 수 있습니다. 기업이 주로 어떤 제품이나 서비스를 생산하거나 제공하는지 구체적으로 설명해 주세요.";
const geminiTimeoutMessage =
  "Gemini 응답 시간이 길어 요청을 중단했습니다. 잠시 후 같은 내용을 다시 전송해주세요.";
let bundledIndustryCache;
let preferredKeyIndex = 0;

export function getModel() {
  return process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
}

export async function handleChatBody(body) {
  const diagnosticId = createDiagnosticId();
  const apiKeys = getGeminiApiKeys();
  if (!apiKeys.length) {
    return {
      status: 400,
      data: {
        error: "Vercel 환경변수 또는 .env 파일에 GEMINI_API_KEY 또는 GEMINI_API_KEYS를 설정해주세요.",
        errorCode: "CONFIG_MISSING_API_KEY",
        diagnosticId
      }
    };
  }

  const activity = String(body.activity || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

  if (!activity) {
    return { status: 400, data: { error: "기업 활동 내용을 입력해주세요." } };
  }

  if (isObviouslyNotBusinessActivity(activity)) {
    return {
      status: 200,
      data: {
        answer: unclassifiableMessage,
        hasIndustryFile: false,
        industrySource: "none",
        candidateCount: 0
      }
    };
  }

  const industryResult = await getIndustryCandidates(activity, history);
  if (industryResult.error) {
    return { status: 400, data: { error: industryResult.error } };
  }

  const prompt = buildPrompt(activity, history, industryResult.candidates);
  const geminiResult = await callGemini(apiKeys, prompt, diagnosticId);

  return {
    status: 200,
    data: {
      answer: geminiResult.text,
      hasIndustryFile: industryResult.hasIndustryFile,
      industrySource: industryResult.source,
      candidateCount: industryResult.candidates.length,
      apiKeyIndex: geminiResult.keyIndex,
      previousApiKeyIndex: geminiResult.previousKeyIndex,
      apiKeySwitched: geminiResult.keyIndex !== geminiResult.previousKeyIndex,
      apiKeyCount: apiKeys.length,
      modelUsed: geminiResult.model
    }
  };
}

export async function getStatusData() {
  const filePath = getIndustryPath();
  if (!existsSync(filePath)) {
    return {
      hasIndustryFile: false,
      industryFileName,
      industryFileSize: 0,
      industrySource: "none",
      model: getModel()
    };
  }

  const fileStat = statSync(filePath);
  return {
    hasIndustryFile: true,
    industryFileName,
    industryFileSize: fileStat.size,
    industrySource: "bundled",
    model: getModel(),
    apiKeyCount: getGeminiApiKeys().length
  };
}

export async function readJsonRequest(req, limit = 20 * 1024 * 1024) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) {
      throw new Error("요청 본문이 너무 큽니다.");
    }
  }

  return raw ? JSON.parse(raw) : {};
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function callGemini(apiKeys, prompt, diagnosticId) {
  const model = getModel();
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
  const models = [...new Set([model, fallbackModel].filter(Boolean))];
  const start = Math.min(preferredKeyIndex, apiKeys.length - 1);
  let lastError;

  for (let offset = 0; offset < apiKeys.length; offset += 1) {
    const keyIndex = (start + offset) % apiKeys.length;
    const apiKey = apiKeys[keyIndex];

    for (const candidateModel of models) {
      try {
        const text = await callGeminiModel(apiKey, candidateModel, prompt, {
          diagnosticId,
          apiKeyIndex: keyIndex + 1,
          model: candidateModel
        });
        preferredKeyIndex = keyIndex;
        return {
          text,
          keyIndex: keyIndex + 1,
          previousKeyIndex: start + 1,
          model: candidateModel
        };
      } catch (error) {
        lastError = error;
        logGeminiError(error, {
          diagnosticId,
          apiKeyIndex: keyIndex + 1,
          model: candidateModel,
          retryable: isRetryableGeminiError(error.message),
          timeout: isGeminiTimeoutError(error.message)
        });
        if (isGeminiTimeoutError(error.message)) break;
        if (!isRetryableGeminiError(error.message)) throw error;
        break;
      }
    }

    if (isGeminiTimeoutError(lastError?.message)) break;
    preferredKeyIndex = (keyIndex + 1) % apiKeys.length;
    await delay(250);
  }

  throw lastError || new Error("Gemini API 호출에 실패했습니다.");
}

function createDiagnosticId() {
  return `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getGeminiApiKeys() {
  const multiKeyText = process.env.GEMINI_API_KEYS || "";
  const multiKeys = multiKeyText
    .split(/[,\n\r]+/)
    .map((key) => key.trim())
    .filter(Boolean);

  if (multiKeys.length) return [...new Set(multiKeys)];

  const singleKey = String(process.env.GEMINI_API_KEY || "").trim();
  return singleKey ? [singleKey] : [];
}

async function callGeminiModel(apiKey, model, prompt, context) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9
        }
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createAppError(geminiTimeoutMessage, {
        code: "GEMINI_TIMEOUT",
        diagnosticId: context.diagnosticId,
        apiKeyIndex: context.apiKeyIndex,
        model
      });
    }
    throw createAppError("Gemini API 연결 중 네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", {
      code: "GEMINI_NETWORK_ERROR",
      diagnosticId: context.diagnosticId,
      apiKeyIndex: context.apiKeyIndex,
      model,
      causeMessage: error?.message
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || "Gemini API 호출에 실패했습니다.";
    const code = classifyGeminiError(message, response.status);
    throw createAppError(toUserFacingGeminiError(message, code), {
      code,
      diagnosticId: context.diagnosticId,
      apiKeyIndex: context.apiKeyIndex,
      model,
      httpStatus: response.status,
      causeMessage: message
    });
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw createAppError("Gemini 응답이 비어 있습니다.", {
      code: "GEMINI_EMPTY_RESPONSE",
      diagnosticId: context.diagnosticId,
      apiKeyIndex: context.apiKeyIndex,
      model
    });
  }

  return text;
}

function createAppError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function logGeminiError(error, context) {
  console.error(JSON.stringify({
    event: "gemini_call_failed",
    diagnosticId: error.diagnosticId || context.diagnosticId,
    errorCode: error.code || "GEMINI_UNKNOWN_ERROR",
    apiKeyIndex: error.apiKeyIndex || context.apiKeyIndex,
    model: error.model || context.model,
    httpStatus: error.httpStatus || null,
    retryable: context.retryable,
    timeout: context.timeout,
    message: error.message,
    causeMessage: error.causeMessage || null
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("high demand") ||
    normalized.includes("spikes in demand") ||
    normalized.includes("try again later") ||
    normalized.includes("overloaded") ||
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("temporarily")
  );
}

function isGeminiTimeoutError(message) {
  return String(message || "").includes(geminiTimeoutMessage);
}

function classifyGeminiError(message, httpStatus) {
  const normalized = String(message || "").toLowerCase();
  if (httpStatus === 401 || httpStatus === 403 || normalized.includes("api key")) return "GEMINI_AUTH_ERROR";
  if (httpStatus === 429 || normalized.includes("rate limit") || normalized.includes("quota")) return "GEMINI_RATE_LIMIT";
  if (
    normalized.includes("high demand") ||
    normalized.includes("spikes in demand") ||
    normalized.includes("try again later") ||
    normalized.includes("overloaded")
  ) return "GEMINI_OVERLOADED";
  if (httpStatus >= 500) return "GEMINI_SERVER_ERROR";
  return "GEMINI_API_ERROR";
}

function toUserFacingGeminiError(message, code = classifyGeminiError(message)) {
  if (
    code === "GEMINI_RATE_LIMIT" ||
    code === "GEMINI_OVERLOADED"
  ) {
    return "현재 Gemini 무료 사용량 또는 일시적 접속량 문제로 응답이 지연되고 있습니다. 잠시 후 같은 내용을 다시 전송해주세요.";
  }

  if (code === "GEMINI_AUTH_ERROR") {
    return "Gemini API 키 인증에 실패했습니다. 관리자에게 문의해주세요.";
  }

  return message;
}

function buildPrompt(activity, history, candidates) {
  const industryRule = candidates.length
    ? `서버에 배포된 산업분류표 JSON에서 검색한 아래 후보 목록만 보고 산업분류를 판정하라. 외부 지식, 일반 상식, 다른 표준산업분류 지식을 코드/명칭 판정 근거로 사용하지 말라.
후보 목록 안에 사용자 활동과 직접 또는 유사하게 맞는 분류가 있으면 산업분류코드/명에 '없음'을 쓰지 말고 가장 가까운 후보를 선택하라.
추가질문 필요 여부가 '예'여도 주사업/부사업의 산업분류코드, 산업색인명, 산업분류명, 차수, 색인, 상세설명은 가장 가까운 후보로 잠정 작성하라. 불확실성은 판정근거와 확신도에 적어라.
사용자가 '공부방 운영'을 말했다면 후보 목록에 '공부방(장소만 제공)' 또는 '독서실 운영업'이 있는 경우 부사업 후보로 우선 제시하라. 교육 방식이 불명확하다는 이유만으로 해당 후보를 [제외후보]로 보내지 말라.
후보에 전혀 관련 분류가 없거나 사업활동 정보가 부족할 때만 추가질문 필요 또는 확신도 낮음으로 답하라.\n\n[산업분류표 후보 JSON]\n${JSON.stringify(candidates, null, 2)}`
    : "아직 산업분류표 JSON이 제공되지 않았다. 코드, 산업분류명, 색인은 임의로 만들지 말고 '산업분류파일 필요'라고 적어라.";

  const compactHistory = history
    .map((item) => `${item.role === "assistant" ? "assistant" : "user"}: ${String(item.content || "").slice(0, 1200)}`)
    .join("\n");

  return `너는 경제총조사 산업분류 판정을 돕는 한국어 업무 보조자다.

가장 중요한 규칙:
사용자 입력이 기업의 산업분류를 판정할 수 있는 사업활동 설명이 아니면 아래 문장만 정확히 출력하라. 다른 문장, 제목, 판정 포맷, 마크다운을 절대 붙이지 마라.
${unclassifiableMessage}

사용자가 어떤 기업의 활동을 이야기하면 다음 형식을 정확히 지켜 답하라.
추가질문은 판정에 필요한 핵심 정보가 빠졌을 때만 작성하라.
주사업과 부사업은 사용자가 말한 매출 비중, 주된 활동, 반복성, 독립적 수익활동 여부를 기준으로 판단하라.
서로 다른 활동이 2개 이상이면 주사업, 부사업1, 부사업2로 나누고 각 사업마다 투입/과정/산출을 따로 정리하라.
단일 활동이면 [주사업]만 작성하고 [부사업1], [부사업2]에는 '없음'이라고 적어라.
제외후보는 헷갈리지만 최종적으로 배제한 분류가 있을 때만 작성하라. 없으면 '없음'이라고 적어라.
확신도는 높음 / 중간 / 낮음 중 하나만 사용하라.

${industryRule}

[이전 대화 요약]
${compactHistory || "없음"}

[사용자 입력]
${activity}

[출력 형식]
추가질문 필요 여부:
예 / 아니오

[추가질문]
(필요한 경우만 작성)

[주사업]
-[투입] 무엇을 가지고 (영업장소, 원재료 등) :
-[과정] 어떤 방법으로 (생산 및 영업활동) :
-[산출] 생산·제공하였는가 (최종 재화 및 용역) :
산업분류코드:
산업색인명:
산업분류명:
차수:
색인:
상세설명:
판정근거:

[부사업1]
-[투입] 무엇을 가지고 (영업장소, 원재료 등) :
-[과정] 어떤 방법으로 (생산 및 영업활동) :
-[산출] 생산·제공하였는가 (최종 재화 및 용역) :
산업분류코드:
산업색인명:
산업분류명:
차수:
색인:
상세설명:
판정근거:

[부사업2]
-[투입] 무엇을 가지고 (영업장소, 원재료 등) :
-[과정] 어떤 방법으로 (생산 및 영업활동) :
-[산출] 생산·제공하였는가 (최종 재화 및 용역) :
산업분류코드:
산업색인명:
산업분류명:
차수:
색인:
상세설명:
판정근거:

[제외후보]
산업분류코드:
산업색인명:
산업분류명:
차수:
색인:
제외이유:

[판정사유]
전체 판단 논리 설명

[확신도]
높음 / 중간 / 낮음`;
}

function isObviouslyNotBusinessActivity(activity) {
  const normalized = normalizeText(activity);
  if (!normalized) return true;

  const compact = normalized.replace(/\s+/g, "");
  const nonBusinessInputs = new Set([
    "안녕",
    "안녕하세요",
    "하이",
    "hello",
    "hi",
    "테스트",
    "test",
    "뭐해",
    "뭐야",
    "도와줘",
    "분류해줘",
    "판정해줘",
    "시작",
    "ㅇㅇ",
    "ㅋㅋ",
    "ㅎㅎ"
  ]);

  if (nonBusinessInputs.has(compact)) return true;

  const businessSignals = [
    "판매",
    "제조",
    "생산",
    "가공",
    "수리",
    "임대",
    "운영",
    "제공",
    "개발",
    "건설",
    "시공",
    "도매",
    "소매",
    "배달",
    "운송",
    "중개",
    "컨설팅",
    "교육",
    "진료",
    "치료",
    "숙박",
    "음식",
    "커피",
    "서비스",
    "제품",
    "상품",
    "매장",
    "공장",
    "온라인",
    "플랫폼",
    "사업",
    "업체",
    "회사"
  ];

  return compact.length < 4 && !businessSignals.some((signal) => compact.includes(signal));
}

async function getIndustryCandidates(activity, history) {
  const query = [
    activity,
    ...history
      .filter((item) => item.role !== "assistant")
      .map((item) => String(item.content || ""))
  ].join(" ");

  const records = await loadBundledIndustryRecords();
  return {
    hasIndustryFile: records.length > 0,
    source: records.length > 0 ? "bundled" : "none",
    candidates: records.length > 0 ? rankIndustryRecords(records, query) : []
  };
}

async function loadBundledIndustryRecords() {
  if (bundledIndustryCache) return bundledIndustryCache;

  const filePath = getIndustryPath();
  if (!existsSync(filePath)) {
    bundledIndustryCache = [];
    return bundledIndustryCache;
  }

  const text = await readFile(filePath, "utf8");
  bundledIndustryCache = normalizeIndustryRecords(JSON.parse(text));
  return bundledIndustryCache;
}

function normalizeIndustryRecords(raw) {
  const records = Array.isArray(raw) ? raw : Object.values(raw || {});
  return records
    .filter((record) => record && typeof record === "object")
    .map((record) => ({
      산업분류코드: String(record.산업분류코드 || record.code || "").trim(),
      산업색인명: String(record.산업색인명 || "").trim(),
      산업분류명: String(record.산업분류명 || record.name || "").trim(),
      차수: String(record.차수 || "").trim(),
      색인: String(record.색인 || record.산업색인명 || record.index || "").trim(),
      상세설명: String(record.상세설명 || "").trim(),
      상세보기_데이터: String(record.상세보기_데이터 || "").trim()
    }))
    .filter((record) => record.산업분류코드 && record.산업분류명);
}

function rankIndustryRecords(records, query) {
  const terms = buildSearchTerms(query);
  const forcedCandidates = findForcedIndustryCandidates(records, query);
  if (!terms.length) {
    return mergeCandidateRecords(forcedCandidates, records.slice(0, 60));
  }

  const scored = records
    .map((record) => ({ record, score: scoreRecord(record, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map((item) => item.record);

  return scored.length
    ? mergeCandidateRecords(forcedCandidates, scored).slice(0, 60)
    : mergeCandidateRecords(forcedCandidates, records.slice(0, 40));
}

function findForcedIndustryCandidates(records, query) {
  const normalized = normalizeText(query);
  const compact = normalized.replace(/\s+/g, "");
  const forced = [];

  const addMatches = (predicate) => {
    for (const record of records) {
      if (predicate(record)) forced.push(record);
    }
  };

  if (hasAny(compact, ["교회", "기독교", "예배", "목회"])) {
    addMatches((record) =>
      record.산업분류코드 === "94912" ||
      normalizeText(`${record.산업색인명} ${record.색인} ${record.산업분류명}`).includes("교회 기독교") ||
      normalizeText(`${record.산업색인명} ${record.색인} ${record.산업분류명}`).includes("기독교 단체")
    );
  }

  if (hasAny(compact, ["공부방", "방과후", "방과후공부", "아이들공부", "학생공부", "학습공간", "독서실"])) {
    addMatches((record) =>
      record.산업분류코드 === "90212" ||
      normalizeText(`${record.산업색인명} ${record.색인}`).includes("공부방") ||
      normalizeText(record.산업분류명).includes("독서실 운영업")
    );
  }

  return forced;
}

function mergeCandidateRecords(...groups) {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    for (const record of group) {
      const key = `${record.산업분류코드}|${record.산업색인명}|${record.색인}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trimIndustryRecord(record));
    }
  }

  return merged;
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(normalizeText(keyword).replace(/\s+/g, "")));
}

function scoreRecord(record, terms) {
  const name = normalizeText(record.산업분류명);
  const index = normalizeText(`${record.색인} ${record.산업색인명}`);
  const detail = normalizeText(`${record.상세설명} ${record.상세보기_데이터}`);
  let score = 0;

  for (const term of terms) {
    if (record.산업분류코드 === term) score += 200;
    if (name.includes(term)) score += 30 + term.length;
    if (index.includes(term)) score += 24 + term.length;
    if (detail.includes(term)) score += 7 + Math.min(term.length, 8);
  }

  return score;
}

function buildSearchTerms(query) {
  const normalized = normalizeText(query);
  const compact = normalized.replace(/\s+/g, "");
  const words = normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

  const grams = [];
  const compactWords = words.filter((word) => word.length >= 3);
  for (const word of compactWords) {
    for (let size = 2; size <= Math.min(5, word.length); size += 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        grams.push(word.slice(index, index + size));
      }
    }
  }

  const expansions = [];
  if (hasAny(compact, ["교회", "기독교", "예배", "목회"])) {
    expansions.push("교회", "기독교", "기독교 단체", "종교", "종교 단체", "포교소", "예배");
  }

  if (hasAny(compact, ["공부방", "방과후", "아이들", "학생", "학습", "독서실"])) {
    expansions.push("공부방", "독서실", "장소만 제공", "학습 장소", "교육", "방과후", "학생");
  }

  return [...new Set([...words, ...expansions.map(normalizeText), ...grams])].slice(0, 150);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimIndustryRecord(record) {
  return {
    산업분류코드: record.산업분류코드,
    산업색인명: record.산업색인명,
    산업분류명: record.산업분류명,
    차수: record.차수,
    색인: record.색인 || record.산업색인명,
    상세설명: record.상세설명.slice(0, 650),
    상세보기_데이터: record.상세보기_데이터.slice(0, 750)
  };
}

function getIndustryPath() {
  return path.join(process.cwd(), industryFileName);
}
