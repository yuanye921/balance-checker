const form = document.querySelector("#queryForm");
const serverSelect = document.querySelector("#serverSelect");
const apiKeyInput = document.querySelector("#apiKeyInput");
const queryButton = document.querySelector("#queryButton");
const buttonLabel = document.querySelector("#buttonLabel");
const messageBox = document.querySelector("#messageBox");
const connectionStatus = document.querySelector("#connectionStatus");
const csvButton = document.querySelector("#csvButton");
const logsBody = document.querySelector("#logsBody");
const previousPageButton = document.querySelector("#previousPageButton");
const nextPageButton = document.querySelector("#nextPageButton");
const pageSummary = document.querySelector("#pageSummary");
const recordSummary = document.querySelector("#recordSummary");

const totalValue = document.querySelector("#totalValue");
const usedValue = document.querySelector("#usedValue");
const remainingValue = document.querySelector("#remainingValue");
const accessValue = document.querySelector("#accessValue");

let currentLogs = [];
let serverMeta = [];
let currentPage = 1;
let currentPagination = {
  page: 1,
  pageSize: 100,
  total: 0,
  totalPages: 1
};
let isLoading = false;

init();

async function init() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    serverMeta = config.servers || [];
    renderServerOptions(serverMeta);
    updateModeStatus();
  } catch {
    showMessage("配置读取失败", "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runQuery(1);
});

previousPageButton.addEventListener("click", async () => {
  if (currentPage > 1) {
    await runQuery(currentPage - 1);
  }
});

nextPageButton.addEventListener("click", async () => {
  if (currentPage < currentPagination.totalPages) {
    await runQuery(currentPage + 1);
  }
});

async function runQuery(page) {
  hideMessage();

  const selected = serverMeta.find((item) => item.id === serverSelect.value);
  const apiKey = apiKeyInput.value.trim();

  if (!selected) {
    showMessage("没有可用的接口服务", "error");
    return false;
  }

  if (!selected.demo && !apiKey) {
    showMessage("请输入令牌", "warning");
    return false;
  }

  setLoading(true);
  try {
    const response = await fetch("/api/check-balance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        serverId: selected.id,
        apiKey,
        page
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "查询失败");
    }
    renderBalance(payload.balance);
    renderLogs(payload.logs || []);
    renderPagination(payload.pagination);
    if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
      showMessage(payload.warnings.join("；"), "warning");
    } else {
      showMessage("查询完成", "success");
    }
    return true;
  } catch (error) {
    showMessage(error.message || "查询失败", "error");
    renderLogs([]);
    renderPagination();
    return false;
  } finally {
    setLoading(false);
  }
}

serverSelect.addEventListener("change", updateModeStatus);

csvButton.addEventListener("click", () => {
  if (currentLogs.length === 0) {
    return;
  }

  const header = ["时间", "模型", "用时", "提示", "补全", "花费", "详情"];
  const rows = currentLogs.map((log) => [
    formatTime(log.createdAt),
    log.model,
    `${log.useTime}s`,
    log.promptTokens,
    log.completionTokens,
    formatMoney(log.quota),
    log.content
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "api-balance-logs.csv";
  link.click();
  URL.revokeObjectURL(url);
});

function renderServerOptions(servers) {
  serverSelect.innerHTML = "";

  if (servers.length === 0) {
    const option = document.createElement("option");
    option.textContent = "未配置";
    option.value = "";
    serverSelect.append(option);
    queryButton.disabled = true;
    return;
  }

  for (const server of servers) {
    const option = document.createElement("option");
    option.value = server.id;
    option.textContent = `${server.label} · ${server.host}`;
    serverSelect.append(option);
  }
}

function updateModeStatus() {
  const selected = serverMeta.find((item) => item.id === serverSelect.value);
  connectionStatus.textContent = selected?.demo ? "演示模式" : selected?.label || "真实接口";
  apiKeyInput.disabled = Boolean(selected?.demo);
  apiKeyInput.placeholder = selected?.demo ? "演示模式无需令牌" : "sk-xxxxxxxxxxxxxxxxxxxxxxxx";
  if (selected?.demo) {
    apiKeyInput.value = "";
  }
}

function setLoading(loading) {
  isLoading = Boolean(loading);
  queryButton.disabled = isLoading;
  buttonLabel.textContent = isLoading ? "查询中" : "查询";
  form.classList.toggle("is-loading", isLoading);
  updatePaginationControls();
}

function renderBalance(balance = {}) {
  totalValue.textContent = formatMoney(balance.total);
  usedValue.textContent = formatMoney(balance.used);
  remainingValue.textContent = formatMoney(balance.remaining);
  accessValue.textContent = formatAccess(balance.accessDate);
}

function renderLogs(logs) {
  currentLogs = logs;
  csvButton.disabled = logs.length === 0;
  logsBody.innerHTML = "";

  if (logs.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="empty">暂无数据</td>`;
    logsBody.append(row);
    return;
  }

  for (const log of logs) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(formatTime(log.createdAt))}</td>
      <td><span class="model-pill">${escapeHtml(log.model)}</span></td>
      <td>${escapeHtml(`${log.useTime}s`)}</td>
      <td>${escapeHtml(String(log.promptTokens))}</td>
      <td>${escapeHtml(String(log.completionTokens))}</td>
      <td>${escapeHtml(formatMoney(log.quota))}</td>
      <td class="detail">${escapeHtml(log.content || "-")}</td>
    `;
    logsBody.append(row);
  }
}

function renderPagination(pagination = {}) {
  const pageSize = Math.max(1, Number(pagination.pageSize) || 100);
  const total = Math.max(0, Number(pagination.total) || 0);
  const totalPages = Math.max(1, Number(pagination.totalPages) || Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(pagination.page) || 1));

  currentPage = page;
  currentPagination = { page, pageSize, total, totalPages };
  recordSummary.textContent = total > 0 ? `共 ${total} 条记录，每页 ${pageSize} 条` : "暂无调用记录";
  pageSummary.textContent = `第 ${page} / ${totalPages} 页`;
  updatePaginationControls();
}

function updatePaginationControls() {
  previousPageButton.disabled = isLoading || currentPage <= 1 || currentPagination.total === 0;
  nextPageButton.disabled = isLoading || currentPage >= currentPagination.totalPages || currentPagination.total === 0;
}

function showMessage(text, type) {
  messageBox.hidden = false;
  messageBox.textContent = text;
  messageBox.dataset.type = type;
}

function hideMessage() {
  messageBox.hidden = true;
  messageBox.textContent = "";
}

function formatMoney(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return "--";
  }
  return `$${numberValue.toFixed(3)}`;
}

function formatAccess(value) {
  if (!value || value === "未知" || value === "永不过期") {
    return value || "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatTime(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return "-";
  }
  return new Date(numberValue * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
