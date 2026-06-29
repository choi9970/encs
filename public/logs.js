const logsForm = document.querySelector("#logsForm");
const adminToken = document.querySelector("#adminToken");
const logLimit = document.querySelector("#logLimit");
const logsStatus = document.querySelector("#logsStatus");
const logsList = document.querySelector("#logsList");
const tokenStorageKey = "ecensus_logs_admin_token_v1";

adminToken.value = sessionStorage.getItem(tokenStorageKey) || "";

logsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = adminToken.value.trim();
  const limit = Math.max(1, Math.min(Number(logLimit.value || 100), 500));
  if (!token) {
    logsStatus.textContent = "관리자 토큰을 입력하세요.";
    return;
  }

  sessionStorage.setItem(tokenStorageKey, token);
  logsStatus.textContent = "로그를 불러오는 중입니다.";
  logsList.replaceChildren();

  try {
    const response = await fetch(`/api/analytics?logs=1&limit=${limit}&token=${encodeURIComponent(token)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "로그 조회에 실패했습니다.");
    }
    window.lastLogsStorage = data.logStorage;
    renderLogs(data.logs || []);
  } catch (error) {
    logsStatus.textContent = error.message || "로그 조회에 실패했습니다.";
  }
});

function renderLogs(logs) {
  const storage = logsStorageLabel(window.lastLogsStorage);
  logsStatus.textContent = logs.length
    ? `최근 3일 로그 ${logs.length.toLocaleString("ko-KR")}건 · ${storage}`
    : `최근 3일 로그가 없습니다. · ${storage}`;

  const fragment = document.createDocumentFragment();
  for (const item of logs) {
    const article = document.createElement("article");
    article.className = "log-card";

    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = [
      formatDateTime(item.createdAt),
      item.apiKeyIndex ? `${item.apiKeyIndex}번 API` : "",
      item.model || "",
      item.candidateCount ? `후보 ${item.candidateCount}개` : ""
    ].filter(Boolean).join(" · ");

    const question = createLogBlock("질문", item.activity || "");
    const answer = createLogBlock("답변", item.answer || "");

    article.append(meta, question, answer);
    fragment.append(article);
  }

  logsList.append(fragment);
}

function logsStorageLabel(value) {
  if (value === "postgres") return "Supabase Postgres DB";
  if (value === "supabase") return "Supabase DB";
  if (value === "kv") return "임시 KV 로그";
  return "로그 저장소 확인 불가";
}

function createLogBlock(label, content) {
  const wrapper = document.createElement("section");
  wrapper.className = "log-block";

  const title = document.createElement("strong");
  title.textContent = label;

  const text = document.createElement("pre");
  text.textContent = content || "없음";

  wrapper.append(title, text);
  return wrapper;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 확인 불가";
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
