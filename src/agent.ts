/**
 * Agent 核心逻辑 - ReAct 风格的 Agentic Loop
 *
 * 架构说明：
 *   - 使用 Anthropic SDK 的流式 API（.stream()）实现实时输出
 *   - 通过 SSE（Server-Sent Events）将流式数据推送给前端
 *   - 实现 ReAct 循环：LLM 响应 → 解析工具调用 → 执行工具 → 回灌结果 → 继续生成
 *
 * SSE 事件类型（前端用这些事件更新 UI）：
 *   { type: "round_start", round: number }         - 第 N 轮 LLM 调用开始
 *   { type: "thinking_start" }                     - 思考块开始
 *   { type: "thinking", delta: string }            - 思考内容流式输出
 *   { type: "thinking_end" }                       - 思考块结束
 *   { type: "text", delta: string }                - 文本内容流式输出
 *   { type: "tool_call", id, name, input }         - 工具调用（含完整参数）
 *   { type: "tool_result", id, name, result }      - 工具执行结果
 *   { type: "usage", usage: {...} }                - 本轮 Token 使用量
 *   { type: "done", totalUsage: {...} }            - 全部完成
 *   { type: "error", message: string }             - 错误信息
 */

import Anthropic from "@anthropic-ai/sdk";
import { Response } from "express";
import { tools, toolSchemas } from "./tools";

// ============================================================
// 类型定义
// ============================================================

export interface AgentConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  enableThinking: boolean;
  enableTools: boolean;
  maxTokens: number;
  systemPrompt?: string;
}

type ThinkingParam =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

// Anthropic API 消息格式
type ConversationMessage = Anthropic.MessageParam;

// ============================================================
// 工具函数
// ============================================================

function sendSSE(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ============================================================
// Agent 主入口
// ============================================================

export async function runAgent(
  userMessages: ConversationMessage[],
  config: AgentConfig,
  res: Response
): Promise<void> {
  // 初始化 Anthropic 客户端（支持自定义 baseURL）
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  // 工具映射表：name -> execute 函数
  const toolMap = new Map(tools.map((t) => [t.name, t.execute]));

  // 对话历史（包含 system prompt 以外的消息）
  const conversationMessages: ConversationMessage[] = [...userMessages];

  // 累计 token 使用量（多轮对话）
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  let round = 0;
  const MAX_ROUNDS = 10; // 防止无限循环

  // ============================================================
  // ReAct 循环：Reason → Act → Observe → Reason...
  // ============================================================
  while (round < MAX_ROUNDS) {
    round++;
    sendSSE(res, { type: "round_start", round });

    // 构建 API 请求参数
    const requestParams: Anthropic.MessageCreateParamsStreaming = {
      model: config.model,
      max_tokens: config.maxTokens,
      stream: true,
      messages: conversationMessages,
      ...(config.enableTools && toolSchemas.length > 0
        ? { tools: toolSchemas as Anthropic.Tool[] }
        : {}),
      ...(config.systemPrompt
        ? { system: config.systemPrompt }
        : {
            system:
              "你是一个 Agent 教学助手。当用户提问时，先思考是否需要使用工具，再给出回答。如果需要查询信息，请主动使用合适的工具。",
          }),
      // 注意：thinking 只在 config.enableThinking 为 true 时启用
      // SDK 0.39.x 使用 enabled + budget_tokens（旧接口）
      ...(config.enableThinking
        ? { thinking: { type: "enabled", budget_tokens: Math.floor(config.maxTokens * 0.8) } as ThinkingParam }
        : {}),
    };

    // ──────────────────────────────────────────────────────────
    // 流式调用 Anthropic API
    // ──────────────────────────────────────────────────────────
    let finalMessage: Anthropic.Message;
    try {
      const stream = await client.messages.stream(
        requestParams as Anthropic.MessageCreateParamsStreaming
      );

      // 流式处理：实时将 thinking 和 text 推送给前端
      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "thinking") {
              sendSSE(res, { type: "thinking_start" });
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "thinking_delta") {
              sendSSE(res, { type: "thinking", delta: event.delta.thinking });
            } else if (event.delta.type === "text_delta") {
              sendSSE(res, { type: "text", delta: event.delta.text });
            }
            break;

          case "content_block_stop":
            break;
        }
      }

      // 获取完整的最终消息（包含完整的 tool_use input）
      finalMessage = await stream.finalMessage();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Agent Stream Error]", err);
      sendSSE(res, { type: "error", message });
      sendSSE(res, { type: "done", totalUsage });
      break;
    }

    // 累计 token 使用量
    totalUsage.input_tokens += finalMessage.usage.input_tokens;
    totalUsage.output_tokens += finalMessage.usage.output_tokens;

    // 发送本轮 usage 统计
    sendSSE(res, {
      type: "usage",
      round,
      usage: finalMessage.usage,
      totalUsage: { ...totalUsage },
    });

    // ──────────────────────────────────────────────────────────
    // 判断停止条件
    // ──────────────────────────────────────────────────────────
    // 每轮结束后都发送 thinking_end，让前端知道本轮思考已完结
    sendSSE(res, { type: "thinking_end" });

    if (finalMessage.stop_reason === "end_turn" || !config.enableTools) {
      // 正常结束：生成完成或不启用工具
      sendSSE(res, { type: "done", totalUsage });
      break;
    }

    if (finalMessage.stop_reason !== "tool_use") {
      // 其他停止原因（max_tokens、stop_sequence 等）
      sendSSE(res, { type: "done", totalUsage });
      break;
    }

    // ──────────────────────────────────────────────────────────
    // 工具调用处理（stop_reason === "tool_use"）
    // ──────────────────────────────────────────────────────────

    // 将 assistant 消息（含 tool_use 块）加入对话历史
    conversationMessages.push({
      role: "assistant",
      content: finalMessage.content,
    });

    // 执行所有工具并收集结果
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of finalMessage.content) {
      if (block.type !== "tool_use") continue;

      const { id, name, input } = block;

      // 通知前端：工具调用开始（含完整参数）
      sendSSE(res, {
        type: "tool_call",
        id,
        name,
        input,
      });

      // 执行工具
      const executeFn = toolMap.get(name);
      let result: string;

      if (!executeFn) {
        result = `错误：未找到工具 "${name}"`;
      } else {
        try {
          result = await executeFn(input as Record<string, unknown>);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result = `工具执行错误：${message}`;
        }
      }

      // 通知前端：工具结果
      sendSSE(res, {
        type: "tool_result",
        id,
        name,
        result,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: id,
        content: result,
      });
    }

    // 将工具结果作为 user 消息加入对话历史，继续下一轮
    conversationMessages.push({
      role: "user",
      content: toolResults,
    });
  }

  if (round >= MAX_ROUNDS) {
    sendSSE(res, { type: "error", message: `超过最大轮次限制（${MAX_ROUNDS} 轮）` });
    sendSSE(res, { type: "done", totalUsage });
  }
}
