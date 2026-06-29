const messages = document.querySelector("#messages");
const chatForm = document.querySelector("#chatForm");
const activityInput = document.querySelector("#activityInput");
const sendButton = document.querySelector("#sendButton");
const industryStatus = document.querySelector("#industryStatus");
const modelName = document.querySelector("#modelName");
const apiNumber = document.querySelector("#apiNumber");
const activeApiNumber = document.querySelector("#activeApiNumber");
const footerApiNumber = document.querySelector("#footerApiNumber");
const charCounter = document.querySelector("#charCounter");
const industryDownload = document.querySelector("#industryDownload");
const todayVisitors = document.querySelector("#todayVisitors");
const monthVisitors = document.querySelector("#monthVisitors");
const analyticsNote = document.querySelector("#analyticsNote");

const maxInputLength = 1200;
const maxStoredMessages = 20;
const maxHistoryMessages = 8;
const storageKey = "ecensus_chat_messages_v1";
const visitorStorageKey = "ecensus_visitor_id_v1";
const history = [];

renderApiNumber();
restoreMessages();
updateCharCounter();
refreshStatus();
recordVisit();

activityInput.addEventListener("input", updateCharCounter);

activityInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  if (!sendButton.disabled) {
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const activity = activityInput.value.trim();
  if (!activity) return;

  addMessage("user", activity, { persist: true });
  activityInput.value = "";
  updateCharCounter();
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activity: activity.slice(0, maxInputLength),
        history: getHistoryForRequest()
      })
    });
    const data = await readApiResponse(response);

    if (!response.ok) {
      throw createClientError(data);
    }

    addMessage("assistant", data.answer, { persist: true });
    if (data.apiKeyIndex && data.apiKeyCount) {
      const apiLabel = `${data.apiKeyIndex}번 / ${data.apiKeyCount}개`;
      activeApiNumber.textContent = apiLabel;
      if (data.apiKeySwitched && data.previousApiKeyIndex) {
        addMessage(
          "system",
          `${data.previousApiKeyIndex}번 API 사용량 초과로 ${data.apiKeyIndex}번 API로 전환했습니다.`
        );
      }
      addMessage("meta", `사용 API: ${apiLabel} · 모델: ${data.modelUsed || "확인 불가"}`);
    }
  } catch (error) {
    addMessage("system", formatErrorMessage(error));
  } finally {
    setBusy(false);
    activityInput.focus();
  }
});

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    modelName.textContent = data.model || "미설정";
    renderIndustryStatus(data);
  } catch {
    industryStatus.textContent = "확인 실패";
    modelName.textContent = "확인 실패";
  }
}

async function recordVisit() {
  try {
    const response = await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: getVisitorId() })
    });
    const data = await response.json();
    renderAnalytics(data);
  } catch {
    todayVisitors.textContent = "확인 실패";
    monthVisitors.textContent = "확인 실패";
    analyticsNote.textContent = "방문 통계를 불러오지 못했습니다.";
  }
}

function renderAnalytics(data = {}) {
  if (!data.enabled) {
    todayVisitors.textContent = "-";
    monthVisitors.textContent = "-";
    analyticsNote.textContent = "통계 저장소가 아직 연결되지 않았습니다.";
    return;
  }

  todayVisitors.textContent = formatCount(data.todayVisitors);
  monthVisitors.textContent = formatCount(data.monthVisitors);
  analyticsNote.textContent = "검색·답변 로그는 최근 3일만 저장합니다.";
}

function getVisitorId() {
  const existing = localStorage.getItem(visitorStorageKey);
  if (existing) return existing;

  const generated = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(visitorStorageKey, generated);
  return generated;
}

function formatErrorMessage(error) {
  const parts = [error.message || "요청에 실패했습니다."];
  if (error.errorCode) parts.push(`오류코드: ${error.errorCode}`);
  if (error.diagnosticId) parts.push(`진단ID: ${error.diagnosticId}`);
  if (error.apiKeyIndex) parts.push(`사용 API: ${error.apiKeyIndex}번`);
  return parts.join("\n");
}

function renderIndustryStatus(data = {}) {
  if (data.hasIndustryFile) {
    industryStatus.textContent = `배포 파일 적용 (${formatBytes(data.industryFileSize || 0)})`;
    industryDownload.hidden = false;
    return;
  }

  industryStatus.textContent = "미적용";
  industryDownload.hidden = true;
}

async function readApiResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: "서버 응답이 일시적으로 불안정합니다. 잠시 후 같은 내용을 다시 전송해주세요.",
      errorCode: "NON_JSON_RESPONSE"
    };
  }
}

function createClientError(data = {}) {
  const error = new Error(data.error || "요청에 실패했습니다.");
  error.errorCode = data.errorCode;
  error.diagnosticId = data.diagnosticId;
  error.apiKeyIndex = data.apiKeyIndex;
  return error;
}

function renderApiNumber() {
  const match = window.location.hostname.match(/^encs(\d+)\./i);
  const isIntegratedHost = window.location.hostname === "encs.vercel.app" || window.location.hostname.startsWith("encs-");
  const label = isIntegratedHost
    ? "통합 API"
    : match
      ? `${match[1]}번 API`
      : "로컬 개발";
  apiNumber.textContent = label;
  footerApiNumber.textContent = label;
}

function restoreMessages() {
  const saved = readStoredMessages();
  if (!saved.length) {
    addMessage(
      "system",
      "산업분류표는 서버에 배포된 JSON 파일만 사용합니다. AI 판정은 참고용이므로 최종 산업분류는 담당자가 확인해 결정해야 합니다.",
      { persist: true }
    );
    return;
  }

  for (const item of saved) {
    addMessage(item.role, item.content);
  }
  rebuildHistory(saved);
}

function addMessage(role, content, options = {}) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  message.textContent = content;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;

  if (options.persist) {
    persistMessage(role, content);
  }
}

function persistMessage(role, content) {
  if (!["user", "assistant", "system"].includes(role)) return;

  const stored = readStoredMessages();
  stored.push({
    role,
    content: String(content || "").slice(0, maxInputLength)
  });
  const trimmed = stored.slice(-maxStoredMessages);
  localStorage.setItem(storageKey, JSON.stringify(trimmed));
  rebuildHistory(trimmed);
}

function readStoredMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && ["user", "assistant", "system"].includes(item.role))
      .map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, maxInputLength)
      }))
      .slice(-maxStoredMessages);
  } catch {
    return [];
  }
}

function rebuildHistory(items) {
  history.length = 0;
  for (const item of items) {
    if (item.role === "system") continue;
    history.push({
      role: item.role,
      content: item.content
    });
  }
  while (history.length > maxStoredMessages) history.shift();
}

function getHistoryForRequest() {
  return history
    .slice(-maxHistoryMessages)
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").slice(0, maxInputLength)
    }));
}

function updateCharCounter() {
  const length = activityInput.value.length;
  charCounter.textContent = `${length} / ${maxInputLength}`;
  charCounter.classList.toggle("near-limit", length >= maxInputLength * 0.9);
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  sendButton.textContent = isBusy ? "처리 중" : "전송";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatCount(value) {
  const number = Number(value || 0);
  return `${number.toLocaleString("ko-KR")}명`;
}
