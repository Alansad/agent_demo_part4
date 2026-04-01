/**
 * Express 服务器 - Week 5-6 Agent Demo
 *
 * 路由：
 *   GET  /              → 前端页面（public/index.html）
 *   POST /api/chat      → Agent 对话（SSE 流式响应）
 *   GET  /api/config    → 暴露前端所需的非敏感服务端配置
 *   GET  /api/tools     → 获取可用工具列表
 *   GET  /api/health    → 健康检查
 *
 * API Key 安全说明：
 *   LLM_API_KEY 只在服务端使用，永远不会返回给前端。
 *   前端只能看到 hasApiKey: boolean 和脱敏的 baseUrl。
 */

import express from "express";
import path from "path";
import * as dotenv from "dotenv";
import { runAgent, AgentConfig } from "./agent";
import { toolSchemas } from "./tools";
import { createApiLoggingMiddleware, ServerLogStore } from "./serverLogs";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const serverLogStore = new ServerLogStore({ maxEntries: 300 });

// ============================================================
// 中间件
// ============================================================
app.use(express.json({ limit: "10mb" }));
app.use("/api", createApiLoggingMiddleware(serverLogStore));
app.use(express.static(path.join(__dirname, "../public")));

// ============================================================
// API 路由
// ============================================================

/**
 * GET /api/config
 * 返回前端需要的服务端配置（不含敏感信息）
 * 前端从这里获取 model、baseUrl 是否配置等，而不是自己维护
 */
app.get("/api/config", (_req, res) => {
  const baseUrl = process.env.LLM_BASE_URL || "";
  // 对 baseUrl 脱敏：只显示 host 部分，不暴露路径中可能含有的 key
  let baseUrlDisplay = "";
  if (baseUrl) {
    try {
      baseUrlDisplay = new URL(baseUrl).host;
    } catch {
      baseUrlDisplay = "（自定义地址）";
    }
  }

  res.json({
    model: process.env.LLM_MODEL || "claude-opus-4-6",
    hasApiKey: Boolean(process.env.LLM_API_KEY),
    baseUrlDisplay: baseUrlDisplay || "api.anthropic.com（官方）",
  });
});

/**
 * GET /api/server-logs
 * 返回最近的服务端 API 请求日志（内存 ring buffer）
 */
app.get("/api/server-logs", (_req, res) => {
  res.json({ logs: serverLogStore.getAll() });
});

/**
 * POST /api/server-logs/clear
 * 清空服务端 API 请求日志
 */
app.post("/api/server-logs/clear", (_req, res) => {
  serverLogStore.clear();
  res.json({ ok: true });
});

/**
 * GET /api/server-logs/stream
 * SSE：实时推送服务端 API 请求日志
 */
app.get("/api/server-logs/stream", (_req, res) => {
  serverLogStore.subscribe(res);
});

/**
 * POST /api/chat
 *
 * 请求体：
 * {
 *   messages: [{ role: "user" | "assistant", content: string }],
 *   settings: {
 *     enableThinking: boolean,
 *     enableTools: boolean,
 *     systemPrompt?: string
 *   }
 * }
 * 注意：apiKey / baseUrl / model 全部从 .env 读取，前端无需传递
 *
 * 响应：SSE 事件流
 * 每条事件格式：data: {"type": "...", ...}\n\n
 */
app.post("/api/chat", async (req, res) => {
  const { messages, settings } = req.body;

  // ── SSE 响应头 ──────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲

  // 客户端断开连接时清理（监听 res 而不是 req，避免 req body 消费完后提前触发）
  let clientGone = false;
  res.on("close", () => { clientGone = true; });

  // ── 参数校验 ────────────────────────────────────────────────
  // API Key 只从 .env 读取，前端不传
  const apiKey = process.env.LLM_API_KEY || "";
  if (!apiKey) {
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message: "服务端未配置 LLM_API_KEY，请在 .env 文件中设置后重启服务",
      })}\n\n`
    );
    res.end();
    return;
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "消息列表不能为空" })}\n\n`);
    res.end();
    return;
  }

  // ── 构建 Agent 配置（全部来自服务端，前端只传行为开关）──────
  const config: AgentConfig = {
    apiKey,
    baseUrl: process.env.LLM_BASE_URL || undefined,
    model: process.env.LLM_MODEL || "claude-opus-4-6",
    enableThinking: Boolean(settings?.enableThinking),
    enableTools: settings?.enableTools !== false, // 默认开启
    maxTokens: settings?.enableThinking ? 8000 : 4096,
    systemPrompt: settings?.systemPrompt || undefined,
  };

  // ── 运行 Agent ──────────────────────────────────────────────
  try {
    await runAgent(messages, config, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Agent Error]", err);
    res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
  } finally {
    res.end();
  }
});

/**
 * GET /api/tools
 * 返回所有可用工具的 Schema（不含 execute 函数）
 */
app.get("/api/tools", (_req, res) => {
  res.json({ tools: toolSchemas });
});

/**
 * GET /api/health
 * 健康检查
 */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    model: process.env.LLM_MODEL || "claude-opus-4-6",
    hasApiKey: Boolean(process.env.LLM_API_KEY),
    hasBaseUrl: Boolean(process.env.LLM_BASE_URL),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// 所有其他路由返回前端页面（SPA 支持）
// ============================================================
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ============================================================
// 启动服务器
// ============================================================
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   Agent Demo Week 5-6 — 流式对话 + 调试面板  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n🚀 服务已启动：http://localhost:${PORT}`);
  console.log(`📦 可用工具数：${toolSchemas.length} 个`);
  console.log(`🔑 API Key：${process.env.LLM_API_KEY ? "✅ 已配置" : "❌ 未配置（请在 .env 中设置 LLM_API_KEY）"}`);
  console.log(`🌐 API URL：${process.env.LLM_BASE_URL || "官方地址（默认）"}`);
  console.log(`🤖 默认模型：${process.env.LLM_MODEL || "claude-opus-4-6"}`);
  console.log("\n💡 试着问：");
  console.log('   "现在几点了？帮我计算一下 2 的 10 次方是多少"');
  console.log('   "北京和上海的天气怎么样？"');
  console.log('   "搜索一下 ReAct 范式是什么"\n');
});
