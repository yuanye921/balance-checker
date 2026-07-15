const http = require("http");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 64 * 1024;
const LOG_PAGE_SIZE = 100;

const allowedServers = buildAllowedServers();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") {
      return sendJson(res, 200, {
        servers: allowedServers.map(({ id, label, url }) => ({
          id,
          label,
          host: url.startsWith("mock://") ? "demo" : new URL(url).host,
          demo: url.startsWith("mock://")
        }))
      });
    }

    if (req.method === "POST" && req.url === "/api/check-balance") {
      const body = await readJsonBody(req);
      const selectedServer = allowedServers.find((serverItem) => serverItem.id === body.serverId);

      if (!selectedServer) {
        return sendJson(res, 400, { error: "没有找到这个接口服务" });
      }

      if (selectedServer.url.startsWith("mock://")) {
        return sendJson(res, 200, mockBalance());
      }

      const apiKey = String(body.apiKey || "").trim();
      if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
        return sendJson(res, 400, { error: "令牌格式看起来不对" });
      }

      const page = Math.max(1, Math.floor(Number(body.page) || 1));
      const result = await queryRelayBalance(selectedServer.url, apiKey, page);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET") {
      return serveStatic(req, res);
    }

    sendJson(res, 405, { error: "不支持这个请求方式" });
  } catch (error) {
    sendJson(res, 500, {
      error: error.publicMessage || "查询失败，请确认接口地址和令牌是否正确"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Balance checker is running at http://localhost:${PORT}`);
});

function buildAllowedServers() {
  const raw = process.env.BASE_URLS_JSON;
  const fallback = {
    "预言家 API站": "https://api.yuyanjia.top"
  };

  let parsed = fallback;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("BASE_URLS_JSON 不是合法 JSON");
    }
  }

  return Object.entries(parsed).map(([label, url], index) => {
    const normalizedUrl = String(url || "").trim().replace(/\/+$/, "");
    if (!normalizedUrl) {
      throw new Error(`接口服务 ${label} 没有地址`);
    }
    if (!normalizedUrl.startsWith("mock://")) {
      const parsedUrl = new URL(normalizedUrl);
      if (!["https:", "http:"].includes(parsedUrl.protocol)) {
        throw new Error(`接口服务 ${label} 只能使用 http 或 https`);
      }
    }
    return {
      id: `server-${index + 1}`,
      label,
      url: normalizedUrl
    };
  });
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(withPublicMessage("请求内容太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text));
      } catch {
        reject(withPublicMessage("请求内容不是合法 JSON"));
      }
    });

    req.on("error", reject);
  });
}

async function queryRelayBalance(baseUrl, apiKey, page) {
  const now = new Date();
  const start = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
  const startDate = formatDate(start);
  const endDate = formatDate(now);

  const subscription = await fetchJson(baseUrl, "/v1/dashboard/billing/subscription", apiKey);
  const usage = await fetchJson(
    baseUrl,
    `/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
    apiKey
  );
  let quotaPerUnit = 500000;
  try {
    const status = await fetchJson(baseUrl, "/api/status", apiKey);
    const configuredQuotaPerUnit = Number(status?.data?.quota_per_unit);
    if (Number.isFinite(configuredQuotaPerUnit) && configuredQuotaPerUnit > 0) {
      quotaPerUnit = configuredQuotaPerUnit;
    }
  } catch {
    // Keep the standard New API conversion when the public status endpoint is unavailable.
  }

  const hardLimit = Number(subscription.hard_limit_usd ?? subscription.system_hard_limit_usd ?? 0);
  const used = Number(usage.total_usage ?? 0) / 100;
  const warnings = [];
  let logs = [];
  let pagination = {
    page,
    pageSize: LOG_PAGE_SIZE,
    total: 0,
    totalPages: 1
  };

  try {
    const logResponse = await fetchJson(
      baseUrl,
      `/api/log/token?p=${page}&page_size=${LOG_PAGE_SIZE}`,
      apiKey
    );
    if (logResponse.success && Array.isArray(logResponse.data?.items)) {
      const total = Math.max(0, Number(logResponse.data.total) || 0);
      const responsePage = Math.max(1, Number(logResponse.data.page) || page);
      const pageSize = Math.max(1, Number(logResponse.data.page_size) || LOG_PAGE_SIZE);
      logs = logResponse.data.items
        .map((log) => normalizeLog(log, quotaPerUnit))
        .sort((a, b) => b.createdAt - a.createdAt);
      pagination = {
        page: responsePage,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      };
    } else if (logResponse.success && Array.isArray(logResponse.data)) {
      const allLogs = logResponse.data
        .map((log) => normalizeLog(log, quotaPerUnit))
        .sort((a, b) => b.createdAt - a.createdAt);
      const startIdx = (page - 1) * LOG_PAGE_SIZE;
      logs = allLogs.slice(startIdx, startIdx + LOG_PAGE_SIZE);
      pagination = {
        page,
        pageSize: LOG_PAGE_SIZE,
        total: allLogs.length,
        totalPages: Math.max(1, Math.ceil(allLogs.length / LOG_PAGE_SIZE))
      };
      if (allLogs.length >= 1000) {
        warnings.push("API 站尚未启用完整日志分页，目前只能翻阅最近 1000 条记录");
      }
    } else if (logResponse.message) {
      warnings.push(logResponse.message);
    }
  } catch {
    warnings.push("调用明细接口没有返回数据，余额信息仍然可用");
  }

  return {
    balance: {
      total: hardLimit,
      used,
      remaining: Math.max(hardLimit - used, 0),
      accessDate: formatAccessDate(subscription.access_until)
    },
    logs,
    pagination,
    warnings
  };
}

async function fetchJson(baseUrl, apiPath, apiKey) {
  const url = new URL(apiPath, `${baseUrl}/`);
  const body = await requestText(url, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  });

  try {
    return JSON.parse(body);
  } catch {
    throw withPublicMessage("接口返回的数据无法读取");
  }
}

function requestText(url, headers) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, {
      method: "GET",
      headers,
      timeout: 12000
    }, (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(withPublicMessage(res.statusCode === 401 || res.statusCode === 403
            ? "接口拒绝了这个令牌"
            : `接口返回了错误状态 ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });

    req.on("timeout", () => {
      req.destroy(withPublicMessage("接口响应超时"));
    });
    req.on("error", (error) => {
      reject(error.publicMessage ? error : withPublicMessage("接口返回的数据无法读取"));
    });
    req.end();
  });
}

function normalizeLog(log, quotaPerUnit) {
  return {
    createdAt: toUnixSeconds(log.created_at),
    model: String(log.model_name || "-"),
    useTime: Number(log.use_time || 0),
    promptTokens: Number(log.prompt_tokens || 0),
    completionTokens: Number(log.completion_tokens || 0),
    quota: Number(log.quota || 0) / quotaPerUnit,
    content: String(log.content || "")
  };
}

function mockBalance() {
  const now = Math.floor(Date.now() / 1000);
  return {
    balance: {
      total: 120,
      used: 37.42,
      remaining: 82.58,
      accessDate: "永不过期"
    },
    logs: [
      {
        createdAt: now - 640,
        model: "gpt-4o-mini",
        useTime: 3,
        promptTokens: 1880,
        completionTokens: 420,
        quota: 0.018,
        content: "演示请求：客服摘要"
      },
      {
        createdAt: now - 7400,
        model: "gpt-4.1",
        useTime: 9,
        promptTokens: 4200,
        completionTokens: 1200,
        quota: 0.128,
        content: "演示请求：长文改写"
      },
      {
        createdAt: now - 17200,
        model: "text-embedding-3-small",
        useTime: 1,
        promptTokens: 980,
        completionTokens: 0,
        quota: 0.003,
        content: "演示请求：知识库入库"
      }
    ],
    pagination: {
      page: 1,
      pageSize: LOG_PAGE_SIZE,
      total: 3,
      totalPages: 1
    },
    warnings: []
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function withPublicMessage(publicMessage) {
  const error = new Error(publicMessage);
  error.publicMessage = publicMessage;
  return error;
}

function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatAccessDate(value) {
  if (!value) {
    return "未知";
  }
  const timestamp = toUnixSeconds(value);
  if (!timestamp) {
    return "未知";
  }
  return new Date(timestamp * 1000).toISOString();
}

function toUnixSeconds(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return 0;
  }
  return numberValue > 9999999999 ? Math.floor(numberValue / 1000) : Math.floor(numberValue);
}
