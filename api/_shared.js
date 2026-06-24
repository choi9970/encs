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

  if (isObviouslyNotBusinessActivity(activity, history)) {
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

  const industryResult = await getIndustryCandidates(activity, history, apiKeys, diagnosticId);
  if (industryResult.error) {
    return { status: 400, data: { error: industryResult.error } };
  }

  const prompt = buildPrompt(activity, history, industryResult.candidates);
  const geminiResult = await callGemini(apiKeys, prompt, diagnosticId, {
    timeoutMs: industryResult.expanded ? 20000 : undefined
  });
  const verifiedAnswer = await verifyIndustryFields(geminiResult.text, industryResult.candidates);

  return {
    status: 200,
    data: {
      answer: verifiedAnswer,
      hasIndustryFile: industryResult.hasIndustryFile,
      industrySource: industryResult.source,
      candidateCount: industryResult.candidates.length,
      candidateSearchExpanded: industryResult.expanded,
      expandedKeywords: industryResult.expandedKeywords,
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

async function callGemini(apiKeys, prompt, diagnosticId, options = {}) {
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
          model: candidateModel,
          timeoutMs: options.timeoutMs,
          maxOutputTokens: options.maxOutputTokens
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
  const timeoutMs = Number(context.timeoutMs || process.env.GEMINI_TIMEOUT_MS || 25000);
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
          topP: 0.9,
          ...(context.maxOutputTokens ? { maxOutputTokens: context.maxOutputTokens } : {})
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

async function verifyIndustryFields(answer, candidates = []) {
  const records = await loadBundledIndustryRecords();
  if (!records.length) return answer;

  const allByCode = groupRecordsByCode(records);
  const candidateByCode = groupRecordsByCode(candidates);
  const lines = String(answer || "").split("\n");
  const repaired = [...lines];
  const sectionStarts = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\[(주사업|부사업1|부사업2|제외후보)\]/.test(lines[index].trim())) {
      sectionStarts.push(index);
    }
  }

  for (let sectionIndex = 0; sectionIndex < sectionStarts.length; sectionIndex += 1) {
    const start = sectionStarts[sectionIndex];
    const end = sectionStarts[sectionIndex + 1] ?? lines.length;
    repairIndustrySection(repaired, start, end, allByCode, candidateByCode);
  }

  return repaired.join("\n");
}

function groupRecordsByCode(records) {
  const grouped = new Map();
  for (const record of records) {
    const code = String(record.산업분류코드 || "").trim();
    if (!code) continue;
    if (!grouped.has(code)) grouped.set(code, []);
    grouped.get(code).push(record);
  }
  return grouped;
}

function repairIndustrySection(lines, start, end, allByCode, candidateByCode) {
  const fieldLines = {};
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^(산업분류코드|산업색인명|산업분류명|차수|색인|상세설명):(.*)$/);
    if (match) fieldLines[match[1]] = index;
  }

  const code = getFieldValue(lines, fieldLines.산업분류코드);
  if (!code || code === "없음" || code === "산업분류파일 필요") return;

  const validRecords = allByCode.get(code) || [];
  if (!validRecords.length) return;

  const candidateRecords = candidateByCode.get(code) || [];
  const preferred = choosePreferredRecord(lines, fieldLines, candidateRecords, validRecords);
  if (!preferred) return;

  setInvalidField(lines, fieldLines, "산업색인명", preferred.산업색인명, validRecords.map((record) => record.산업색인명));
  setInvalidField(lines, fieldLines, "산업분류명", preferred.산업분류명, validRecords.map((record) => record.산업분류명));
  setInvalidField(lines, fieldLines, "차수", preferred.차수, validRecords.map((record) => record.차수));
  setInvalidField(lines, fieldLines, "색인", preferred.색인 || preferred.산업색인명, validRecords.map((record) => record.색인 || record.산업색인명));
}

function choosePreferredRecord(lines, fieldLines, candidateRecords, validRecords) {
  const currentIndex = getFieldValue(lines, fieldLines.색인);
  const currentIndexName = getFieldValue(lines, fieldLines.산업색인명);
  const pool = candidateRecords.length ? candidateRecords : validRecords;

  return (
    pool.find((record) => record.산업색인명 === currentIndexName || record.색인 === currentIndex) ||
    candidateRecords[0] ||
    validRecords[0]
  );
}

function setInvalidField(lines, fieldLines, field, replacement, validValues) {
  const index = fieldLines[field];
  if (index === undefined || replacement === undefined) return;

  const current = getFieldValue(lines, index);
  if (!current || current === "없음") return;

  const validSet = new Set(validValues.map((value) => String(value || "").trim()).filter(Boolean));
  if (validSet.has(current)) return;

  lines[index] = `${field}: ${replacement}`;
}

function getFieldValue(lines, index) {
  if (index === undefined) return "";
  return String(lines[index].split(":").slice(1).join(":")).trim();
}

function buildPrompt(activity, history, candidates) {
  const industryRule = candidates.length
    ? `서버에 배포된 산업분류표 JSON에서 검색한 아래 후보 목록만 보고 산업분류를 판정하라. 외부 지식, 일반 상식, 다른 표준산업분류 지식을 코드/명칭 판정 근거로 사용하지 말라.
후보 목록 안에 사용자 활동과 직접 또는 유사하게 맞는 분류가 있으면 산업분류코드/명에 '없음'을 쓰지 말고 가장 가까운 후보를 선택하라.
추가질문 필요 여부가 '예'여도 주사업/부사업의 산업분류코드, 산업색인명, 산업분류명, 차수, 색인, 상세설명은 가장 가까운 후보로 잠정 작성하라. 불확실성은 판정근거와 확신도에 적어라.
산업분류코드, 산업색인명, 산업분류명, 차수, 색인은 반드시 후보 JSON에 있는 값을 그대로 복사하라. 산업색인명에는 산업분류명을 복사하지 말고 후보 JSON의 산업색인명 값을 써라.
사용자가 '공부방 운영'을 말했다면 후보 목록에 '공부방(장소만 제공)' 또는 '독서실 운영업'이 있는 경우 부사업 후보로 우선 제시하라. 교육 방식이 불명확하다는 이유만으로 해당 후보를 [제외후보]로 보내지 말라.
추가질문 필요 여부가 '아니오'이면 바로 다음 줄에 '조사표:'를 반드시 작성하라. 조사표는 [주사업]의 산업분류코드 앞 2자리 또는 앞 3자리를 기준으로 아래 조사표 기준에서 고른다.
사용자가 본사·지사·지역본부·관리본부처럼 공장/광산/지점을 관리하는 본사 관리활동이라고 명시하면 종사자 수를 묻지 말고 본사 부호로 판정하라. 제조업 본사·지사는 71511 제조업 회사 본부, 광업 등 비제조업 본사·지사는 71519 기타 산업 회사본부를 우선 적용하고 조사표는 조사표 2로 작성하라.
주사업 산업분류코드가 광업(05-08) 또는 제조업(10-34)이면서 본사·지사 관리활동이 아니면 조사표 2/3 대상이다. 이 경우 종사자 수가 9인 이하인지 10인 이상인지 사용자가 말하지 않았으면 조사표 2 또는 3을 임의로 고르지 말고 추가질문 필요 여부를 '예'로 하라.
광업/제조업 부호일 때는 해당 사업장이 실제 광업/제조업을 하는 공장·광산인지, 아니면 지사나 공장을 관리하는 본사·지사인지 반드시 추가질문 또는 판정근거에 주의 문구를 붙여라.
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
추가질문 필요 여부가 '아니오'이면 그 바로 아래 줄에 조사표를 작성하라. 예: 조사표: 조사표 4 - G 도/소매업(45-47)
추가질문 필요 여부가 '예'이면 조사표 줄은 쓰지 말고, 추가질문에서 조사표 판정에 필요한 내용을 물어보라.
사용자가 본사·지사·지역본부·관리본부라고 명시하면 종사자 수를 묻지 말고 본사 부호와 조사표 2를 작성하라.
주사업이 광업(05-08) 또는 제조업(10-34)인데 본사·지사 관리활동이 아니고 종사자 수가 없으면 조사표 2/3을 임의로 선택하지 말고 반드시 추가질문에서 "종사자 수가 9인 이하인지 10인 이상인지"를 물어보라.

[조사표 기준]
조사표 1: A 농림어업(01-03), D 전기·가스·증기업(35), F 건설업(41-42), H 운수업(49-52), K 금융·보험업(64-66), O 공공행정(84), P 교육서비스업 학교 등(851-854), S 협회·단체(94)
조사표 2: B 광업(05-08), C 제조업(10-34), 9인 이하
조사표 3: B 광업(05-08), C 제조업(10-34), 10인 이상
조사표 4: G 도·소매업(45-47)
조사표 5: I 숙박·음식점업(55-56)
조사표 6: E 수도·하수·폐기업(36-39), J 정보통신업(58-63), L 부동산업(68), M 전문·과학·기술업(70-73), N 사업시설·지원업(74-76), P 교육서비스업 학원 등(855-857), Q 보건·사회복지업(86-87), R 예술·스포츠·여가업(90-91), S 수리·개인서비스업(95-96)

${industryRule}

[이전 대화 요약]
${compactHistory || "없음"}

[사용자 입력]
${activity}

[출력 형식]
추가질문 필요 여부:
예 / 아니오
조사표:
(추가질문 필요 여부가 아니오인 경우만 작성. 예인 경우 이 줄 자체를 쓰지 말 것)

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

function isObviouslyNotBusinessActivity(activity, history = []) {
  const normalized = normalizeText(activity);
  if (!normalized) return true;

  const compact = normalized.replace(/\s+/g, "");
  if (isFollowUpAnswer(activity, history)) return false;

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

function isFollowUpAnswer(activity, history = []) {
  const compact = normalizeText(activity).replace(/\s+/g, "");
  if (!compact) return false;

  const looksLikeShortAnswer =
    /^\d+명?$/.test(compact) ||
    /^(\d+인이하|\d+인이상|\d+명 이하|\d+명 이상)$/.test(activity.trim()) ||
    ["예", "아니오", "네", "아니요", "본사", "공장", "지사", "직접제조", "장소만제공", "교육제공"].includes(compact);

  if (!looksLikeShortAnswer) return false;

  return history.some((item) => {
    const text = String(item?.content || "");
    return (
      text.includes("추가질문 필요 여부:") ||
      text.includes("[추가질문]") ||
      text.includes("종사자 수") ||
      text.includes("9인 이하") ||
      text.includes("10인 이상") ||
      text.includes("본사") ||
      text.includes("공장")
    );
  });
}

async function getIndustryCandidates(activity, history, apiKeys, diagnosticId) {
  const query = [
    activity,
    ...history
      .filter((item) => item.role !== "assistant")
      .map((item) => String(item.content || ""))
  ].join(" ");

  const records = await loadBundledIndustryRecords();
  if (!records.length) {
    return {
      hasIndustryFile: false,
      source: "none",
      candidates: [],
      expanded: false,
      expandedKeywords: []
    };
  }

  const initialRank = rankIndustryRecords(records, query);
  let finalRank = initialRank;
  let expandedKeywords = [];

  if (shouldExpandCandidateSearch(initialRank)) {
    try {
      expandedKeywords = await extractSearchKeywordsWithGemini(apiKeys, activity, history, diagnosticId);
      if (expandedKeywords.length) {
        const expandedRank = rankIndustryRecords(records, query, expandedKeywords);
        if (isBetterCandidateRank(expandedRank, initialRank)) {
          finalRank = expandedRank;
        }
      }
    } catch (error) {
      logGeminiError(error, {
        diagnosticId,
        apiKeyIndex: error.apiKeyIndex || null,
        model: error.model || getModel(),
        retryable: isRetryableGeminiError(error.message),
        timeout: isGeminiTimeoutError(error.message)
      });
    }
  }

  return {
    hasIndustryFile: true,
    source: "bundled",
    candidates: finalRank.candidates,
    expanded: expandedKeywords.length > 0,
    expandedKeywords
  };
}

async function extractSearchKeywordsWithGemini(apiKeys, activity, history, diagnosticId) {
  const compactHistory = history
    .filter((item) => item.role !== "assistant")
    .map((item) => String(item.content || "").slice(0, 400))
    .join("\n");
  const prompt = `경제총조사 산업분류표 JSON 검색용 키워드를 만들어라.
분류 판정이나 설명은 하지 말고, 아래 JSON 형식만 출력하라.
사용자가 말한 사업활동을 산업분류표에서 찾기 쉽도록 유의어, 표준적인 업종 표현, 색인어 후보를 포함하라.
키워드는 한국어 위주로 4개 이상 16개 이하로 작성하라.

[사용자 입력]
${activity}

[이전 사용자 대화]
${compactHistory || "없음"}

[출력]
{"keywords":["키워드1","키워드2"]}`;

  const result = await callGemini(apiKeys, prompt, diagnosticId, {
    timeoutMs: 3000,
    maxOutputTokens: 256
  });
  const parsed = parseJsonObjectFromText(result.text);
  const keywords = Array.isArray(parsed?.keywords) ? parsed.keywords : [];
  return [...new Set(
    keywords
      .map((keyword) => normalizeText(keyword))
      .filter((keyword) => keyword.length >= 2)
  )].slice(0, 16);
}

function parseJsonObjectFromText(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}

function shouldExpandCandidateSearch(rank) {
  return rank.matchedCount === 0 || rank.topScore < 45 || rank.candidates.length < 8;
}

function isBetterCandidateRank(candidate, current) {
  if (candidate.matchedCount > current.matchedCount) return true;
  if (candidate.topScore > current.topScore) return true;
  return candidate.candidates.length > current.candidates.length && candidate.topScore >= current.topScore;
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

function rankIndustryRecords(records, query, extraTerms = []) {
  const terms = buildSearchTerms(query, extraTerms);
  const forcedCandidates = findForcedIndustryCandidates(records, query, extraTerms);
  const similarityRank = rankSimilarIndustryRecords(records, query, extraTerms);
  if (!terms.length) {
    return {
      candidates: mergeCandidateRecords(forcedCandidates, similarityRank.map((item) => item.record)).slice(0, 60),
      matchedCount: forcedCandidates.length + similarityRank.length,
      topScore: Math.max(forcedCandidates.length ? 100 : 0, similarityRank[0]?.score || 0)
    };
  }

  const scored = records
    .map((record) => ({ record, score: scoreRecord(record, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const topScore = scored[0]?.score || 0;
  const rankedRecords = scored.map((item) => item.record);
  const candidates = scored.length
    ? mergeCandidateRecords(forcedCandidates, rankedRecords, similarityRank.map((item) => item.record)).slice(0, 60)
    : mergeCandidateRecords(forcedCandidates, similarityRank.map((item) => item.record)).slice(0, 60);

  return {
    candidates,
    matchedCount: scored.length + forcedCandidates.length + similarityRank.length,
    topScore: Math.max(topScore, forcedCandidates.length ? 100 : 0, similarityRank[0]?.score || 0)
  };
}

function rankSimilarIndustryRecords(records, query, extraTerms = []) {
  const profile = buildSimilarityProfile(query, extraTerms);
  if (!profile.tokens.length && !profile.grams.length) return [];

  return records
    .map((record) => ({ record, score: scoreRecordSimilarity(record, profile) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
}

function buildSimilarityProfile(query, extraTerms = []) {
  const normalized = normalizeText([query, ...extraTerms].join(" "));
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !isWeakSearchToken(token));
  const compact = normalized.replace(/\s+/g, "");
  const grams = [];

  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      const gram = compact.slice(index, index + size);
      if (!isWeakSearchToken(gram)) grams.push(gram);
    }
  }

  return {
    tokens: [...new Set(tokens)].slice(0, 80),
    grams: [...new Set(grams)].slice(0, 160)
  };
}

function scoreRecordSimilarity(record, profile) {
  const name = normalizeText(record.산업분류명);
  const index = normalizeText(`${record.색인} ${record.산업색인명}`);
  const detail = normalizeText(`${record.상세설명} ${record.상세보기_데이터}`).slice(0, 2400);
  const combined = `${name} ${index} ${detail}`;
  let score = 0;

  for (const token of profile.tokens) {
    if (record.산업분류코드 === token) score += 220;
    if (index.includes(token)) score += 38 + Math.min(token.length, 10);
    if (name.includes(token)) score += 34 + Math.min(token.length, 10);
    if (detail.includes(token)) score += 9 + Math.min(token.length, 8);
  }

  let gramHits = 0;
  for (const gram of profile.grams) {
    if (index.includes(gram)) {
      score += 5;
      gramHits += 1;
    } else if (name.includes(gram)) {
      score += 4;
      gramHits += 1;
    } else if (combined.includes(gram)) {
      score += 1;
      gramHits += 1;
    }
  }

  if (gramHits >= 4) score += Math.min(gramHits, 24);
  return score;
}

function isWeakSearchToken(token) {
  return [
    "하고",
    "하는",
    "한다",
    "함",
    "및",
    "또",
    "도",
    "같이",
    "주로",
    "운영",
    "제공",
    "서비스",
    "사업",
    "업체",
    "회사",
    "판매",
    "제조"
  ].includes(token);
}

function findForcedIndustryCandidates(records, query, extraTerms = []) {
  const normalized = normalizeText([query, ...extraTerms].join(" "));
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

  if (hasAny(compact, ["제조", "생산", "가공", "공장", "본사", "지사", "관리활동", "관리업무"])) {
    addMatches((record) =>
      record.산업분류코드 === "71511" ||
      normalizeText(`${record.산업색인명} ${record.색인} ${record.산업분류명}`).includes("제조업 회사 본부")
    );
  }

  if (hasAny(compact, ["광업", "광산", "채굴", "채광", "본사", "지사", "관리활동", "관리업무"])) {
    addMatches((record) =>
      record.산업분류코드 === "71519" ||
      normalizeText(`${record.산업색인명} ${record.색인} ${record.산업분류명}`).includes("기타 산업 회사본부")
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

function buildSearchTerms(query, extraTerms = []) {
  const normalized = normalizeText([query, ...extraTerms].join(" "));
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
  const rootPath = path.join(process.cwd(), industryFileName);
  if (existsSync(rootPath)) return rootPath;
  return path.join(process.cwd(), "public", industryFileName);
}
