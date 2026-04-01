# Agent Demo — Week 5-6

> 12 周 Agent 开发学习计划 · 第 5-6 周实战项目
>
> 核心主题：**SSE 流式对话前端 + 可视化调试面板**

## 项目简介

本项目是一个基于 Anthropic Claude 的全栈 Agent Demo，使用 TypeScript + Express 构建后端，原生 HTML/CSS/JS 构建前端，重点演示：

- **SSE 流式输出**：逐 token 实时渲染，告别"等待转圈"体验
- **ReAct 循环**：Reason（思考）→ Act（工具调用）→ Observe（观察结果）→ 继续思考
- **可视化调试面板**：实时展示 Agent 的思考过程、工具调用入参/出参、Token 统计
- **扩展思考（Extended Thinking）**：可视化 Claude 的推理链

---

## 效果预览

```
┌─────────────────────────────────┬──────────────────────────────┐
│         对话区（左栏）           │      调试面板（右栏）         │
│                                 │  📋 时间线 │ 💭 思考 │ 🔧 工具 │
│  你：北京和上海天气怎么样？       │ ─────────────────────────── │
│                                 │  🔄 第1轮 LLM 调用           │
│  Assistant：                    │  💭 思考开始                  │
│  ┌─ Claude 正在思考... ─────┐   │  🔧 工具调用: get_weather    │
│  │  ● ● ●                  │   │  ✅ 工具返回: get_weather    │
│  └─────────────────────────┘   │  ✨ 生成完成                  │
│                                 │                              │
│  根据查询结果...（流式输出）     │  📊 统计                     │
│                                 │  输入Token: 1,234            │
└─────────────────────────────────┴──────────────────────────────┘
```

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 API Key：

```env
LLM_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=claude-opus-4-6
```

### 3. 启动服务

```bash
npm run dev
```

打开浏览器访问：**http://localhost:3000**

---

## 目录结构

```
agent_demo_part4/
├── src/
│   ├── server.ts       # Express 服务器，定义 API 路由
│   ├── agent.ts        # Agent 核心逻辑，ReAct 循环 + SSE 推送
│   └── tools.ts        # 工具定义（时间/计算/天气/知识库）
├── public/
│   ├── index.html      # 页面结构（双栏布局）
│   ├── style.css       # 深色主题样式
│   └── app.js          # 前端逻辑（SSE 解析、调试面板）
├── .env.example        # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

---

## API 说明

| 路由 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 前端页面 |
| `/api/chat` | POST | Agent 对话，返回 SSE 流 |
| `/api/config` | GET | 服务端配置（不含敏感信息） |
| `/api/tools` | GET | 可用工具列表 |
| `/api/health` | GET | 健康检查 |

### `/api/chat` 请求格式

```json
{
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "settings": {
    "enableThinking": false,
    "enableTools": true,
    "systemPrompt": ""
  }
}
```

### SSE 事件类型

后端通过 SSE 向前端推送以下事件，前端 `handleSSEEvent()` 逐一处理：

| 事件类型 | 数据字段 | 说明 |
|----------|----------|------|
| `round_start` | `round` | 第 N 轮 LLM 调用开始 |
| `thinking_start` | — | 扩展思考开始 |
| `thinking` | `delta` | 思考内容流式输出 |
| `thinking_end` | — | 扩展思考结束 |
| `text` | `delta` | 文本内容流式输出 |
| `tool_call` | `id, name, input` | 工具调用（含完整入参） |
| `tool_result` | `id, name, result` | 工具执行结果 |
| `usage` | `round, usage, totalUsage` | Token 使用量 |
| `done` | `totalUsage` | 全部完成 |
| `error` | `message` | 错误信息 |

---

## 内置工具

| 工具名 | 说明 | 示例问法 |
|--------|------|----------|
| `get_current_time` | 获取当前时间（支持时区） | "现在几点了？" |
| `calculate` | 数学表达式求值 | "2 的 16 次方是多少？" |
| `get_weather` | 查询城市天气（演示数据） | "北京今天天气怎么样？" |
| `search_knowledge` | 搜索 Agent 知识库 | "搜索 ReAct 范式" |

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `LLM_API_KEY` | ✅ | — | Anthropic API Key |
| `LLM_MODEL` | — | `claude-opus-4-6` | 模型名称 |
| `LLM_BASE_URL` | — | 官方地址 | 自定义 API 地址（代理等） |
| `PORT` | — | `3000` | 服务端口 |

> **安全提示**：API Key 只在服务端读取，永远不会暴露给浏览器前端。

---

## 核心知识点

### 1. SSE 流式输出

```
后端：res.write(`data: ${JSON.stringify(event)}\n\n`)
前端：fetch + ReadableStream 逐行解析（POST 请求不能用 EventSource）
```

### 2. ReAct 循环

```
用户消息 → LLM 生成（含 tool_use 块）
        → 解析所有工具调用 → 并行执行
        → tool_result 回灌 → 下一轮 LLM 调用
        → stop_reason === "end_turn" → 结束
```

### 3. 扩展思考（Extended Thinking）

通过 `thinking: { type: "enabled", budget_tokens: N }` 开启，LLM 会先输出 `thinking` 块再输出 `text` 块，调试面板的「思考」Tab 实时展示推理过程。

---

## 学习阶段对应

本项目对应 12 周学习计划的 **Week 5-6**：

| 周数 | 核心任务 |
|------|----------|
| Week 1-2 | LLM API 调用、Function Calling、记忆机制 |
| Week 3-4 | ReAct 范式、RAG 检索 |
| **Week 5-6** | **流式输出前端 + 可视化调试面板** ← 当前 |
| Week 7-8 | 完整项目落地，≥5 个自定义工具 |
| Week 9-12 | 多 Agent 协作、部署上线 |
