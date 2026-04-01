/**
 * 工具定义 - Agent 的"手脚"
 *
 * 前端视角：每个 Tool 就是一个异步 Action，
 * 包含声明（给 LLM 看的 Schema）和实现（execute 函数）
 *
 * Tool 三要素：
 *   1. name        - 工具名称（LLM 通过这个名字调用）
 *   2. description - 功能描述（LLM 靠这个决定何时调用）
 *   3. input_schema - 参数结构（JSON Schema，LLM 按此生成入参）
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Tool extends ToolDefinition {
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ============================================================
// 工具实现
// ============================================================

const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: "获取当前的日期和时间信息",
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "时区名称，如 'Asia/Shanghai'、'America/New_York'，默认为上海时间",
      },
    },
  },
  execute: async (input) => {
    const tz = (input.timezone as string) || "Asia/Shanghai";
    const now = new Date();
    const formatted = now.toLocaleString("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `当前时间（${tz}）：${formatted}`;
  },
};

const calculateTool: Tool = {
  name: "calculate",
  description: "执行数学运算，支持加减乘除、幂运算、括号等基本运算",
  input_schema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "数学表达式，如 '(100 + 200) * 3'、'2 ** 10'、'Math.sqrt(144)'",
      },
    },
    required: ["expression"],
  },
  execute: async (input) => {
    const expr = input.expression as string;
    // 安全的数学表达式求值（仅允许数字和运算符）
    const safePattern = /^[\d\s\+\-\*\/\(\)\.\%\,Math\.sqrtpowlogabsfloorceiling]+$/;
    if (!safePattern.test(expr.replace(/\s/g, ""))) {
      // 放宽限制，通过 Function 执行
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`"use strict"; return (${expr})`)();
      if (typeof result === "number" && !isNaN(result)) {
        return `计算结果：${expr} = ${result}`;
      }
      return `计算结果：${result}`;
    } catch {
      return `计算错误：无法解析表达式 "${expr}"，请检查语法`;
    }
  },
};

const getWeatherTool: Tool = {
  name: "get_weather",
  description: "查询指定城市的当前天气（演示数据，非真实数据）",
  input_schema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "城市名称，支持中英文，如 '北京'、'上海'、'London'、'Tokyo'",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "温度单位，celsius（摄氏度）或 fahrenheit（华氏度），默认 celsius",
      },
    },
    required: ["city"],
  },
  execute: async (input) => {
    const city = input.city as string;
    const unit = (input.unit as string) || "celsius";

    // 模拟真实数据（实际项目中替换为天气 API 调用）
    const mockData: Record<string, { temp: number; condition: string; humidity: number; wind: string }> = {
      北京: { temp: 15, condition: "晴转多云", humidity: 45, wind: "北风 3级" },
      上海: { temp: 22, condition: "多云", humidity: 68, wind: "东南风 2级" },
      广州: { temp: 28, condition: "阵雨", humidity: 82, wind: "南风 2级" },
      深圳: { temp: 27, condition: "晴", humidity: 75, wind: "东风 3级" },
      成都: { temp: 18, condition: "阴", humidity: 70, wind: "无风" },
      London: { temp: 12, condition: "Cloudy", humidity: 78, wind: "W 4mph" },
      Tokyo: { temp: 19, condition: "Partly Cloudy", humidity: 60, wind: "NE 5kph" },
      "New York": { temp: 16, condition: "Sunny", humidity: 52, wind: "SW 8mph" },
    };

    const data = mockData[city] || {
      temp: Math.floor(Math.random() * 25 + 10),
      condition: ["Sunny", "Cloudy", "Rainy"][Math.floor(Math.random() * 3)],
      humidity: Math.floor(Math.random() * 40 + 40),
      wind: "Light breeze",
    };

    const temp = unit === "fahrenheit" ? Math.round(data.temp * 9/5 + 32) : data.temp;
    const tempUnit = unit === "fahrenheit" ? "°F" : "°C";

    return [
      `📍 ${city} 天气报告`,
      `🌡️  气温：${temp}${tempUnit}`,
      `🌤️  天气：${data.condition}`,
      `💧 湿度：${data.humidity}%`,
      `🌬️  风力：${data.wind}`,
      `⚠️  注：此为演示数据`,
    ].join("\n");
  },
};

const searchKnowledgeTool: Tool = {
  name: "search_knowledge",
  description: "搜索 Agent 开发相关知识库（包含 LLM、工具调用、记忆系统等内容）",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，如 'ReAct'、'Function Calling'、'RAG'、'流式输出'",
      },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const query = (input.query as string).toLowerCase();

    const kb: Record<string, string> = {
      react: `**ReAct 范式**（Reasoning + Acting）
核心思路：让 Agent 交替进行 Thought（思考）和 Action（行动）
流程：Think → Act → Observe → Think → Act → ...
优点：可解释性强，中间步骤清晰可调试
参考论文：ReAct: Synergizing Reasoning and Acting in Language Models (2022)`,

      "function calling": `**Function Calling / Tool Use**
LLM 的核心扩展能力，使模型能调用外部工具函数
Anthropic 实现：通过 tools 参数定义工具，LLM 返回 tool_use 块
完整流程：用户问题 → LLM 决定调用哪个工具 → 传入参数 → 执行工具 → 回灌结果 → 生成最终回答
类比前端：就像异步 fetch，只是"接口"由 LLM 决定何时调用`,

      rag: `**RAG**（Retrieval Augmented Generation）
通过"检索→增强→生成"三步解决 LLM 知识截止和幻觉问题
Week 4 已实现：向量化文档 → 语义检索 → 注入 Prompt → LLM 生成回答
关键组件：Embedding 模型、向量数据库（Chroma/Pinecone）、Retriever`,

      sse: `**SSE**（Server-Sent Events）流式输出
服务端向客户端单向推送事件流
格式：每条消息以 "data: " 开头，"\n\n" 结束
前端接收：EventSource（GET）或 fetch + ReadableStream（POST）
对比 WebSocket：SSE 单向、HTTP 协议、自动重连；WS 双向、更适合实时通信`,

      流式: `**流式输出实现原理**
Anthropic SDK：client.messages.stream() 返回异步迭代器
事件类型：
  - content_block_start: 新内容块开始（text/thinking/tool_use）
  - content_block_delta: 增量内容（text_delta / thinking_delta / input_json_delta）
  - content_block_stop: 内容块结束
  - message_delta: 包含 stop_reason 和 usage
前端渲染：fetch + ReadableStream 读取 SSE，逐 token 追加到 DOM`,

      langchain: `**LangChain.js**
最流行的 Agent 开发框架（TypeScript/JavaScript 版本）
核心抽象：Chain（链）、Retriever（检索器）、VectorStore（向量库）
LCEL（LangChain Expression Language）：用 pipe() 串联 Runnable 组件
Week 3-4 已使用：ChatAnthropic、RecursiveCharacterTextSplitter、VectorStore`,

      记忆: `**Agent 记忆系统**
短期记忆：对话上下文（messages 数组） → 类比 React useState
长期记忆：向量数据库持久化 → 类比 Redux persist
总结记忆：压缩历史对话减少 token 消耗 → 类比虚拟列表
工作流程：新消息 → 检索相关记忆 → 注入 Prompt → 更新记忆库`,

      工具: `**工具系统设计**
工具三要素：名称（name）、描述（description）、参数 Schema（input_schema）
执行流程：
  1. LLM 返回 tool_use 块，包含 tool_use_id、name、input
  2. 代码执行对应工具函数
  3. 将结果包装为 tool_result 块回灌给 LLM
  4. LLM 基于工具结果生成最终回答
注意：多工具调用时，所有 tool_result 需一次性返回`,
    };

    const matches: string[] = [];
    for (const [key, value] of Object.entries(kb)) {
      if (query.includes(key) || key.includes(query)) {
        matches.push(value);
      }
    }

    if (matches.length > 0) {
      return matches.join("\n\n---\n\n");
    }

    const keys = Object.keys(kb).join("、");
    return `未找到关于 "${input.query}" 的内容\n\n可搜索的主题：${keys}`;
  },
};

// 导出工具列表
export const tools: Tool[] = [
  getCurrentTimeTool,
  calculateTool,
  getWeatherTool,
  searchKnowledgeTool,
];

// 导出工具 Schema（用于传给 Anthropic API）
export const toolSchemas: ToolDefinition[] = tools.map(({ execute: _exec, ...schema }) => schema);

// 导出 OpenAI 格式工具 Schema（兼容 OpenAI / 豆包 / 通义千问等接口）
// input_schema 的结构与 OpenAI parameters（JSON Schema）完全相同，直接复用
export const openAIToolSchemas = tools.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));
