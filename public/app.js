/**
 * Agent Demo — Week 5-6 前端逻辑
 *
 * 核心知识点：
 * 1. fetch + ReadableStream 处理 SSE（POST 请求不能用 EventSource）
 * 2. 逐 token 实时渲染流式输出
 * 3. 调试面板：可视化工具调用、思考过程、Token 统计
 *
 * 数据流：
 *   用户输入 → fetch('/api/chat') → ReadableStream SSE 解析 →
 *   handleSSEEvent() → 更新 Chat + 调试面板
 */

'use strict';

// ================================================================
// 状态管理（类比 React 的 state + Redux store）
// ================================================================

/** 对话历史，格式符合 Anthropic API */
const conversationHistory = [];

/** 当前会话统计 */
const sessionStats = {
  inputTokens: 0,
  outputTokens: 0,
  rounds: 0,
  toolCalls: 0,
  startTime: null,
};

/** 服务端配置（从 /api/config 拉取，只读）
 *  hasApiKey 初始设为 true，避免异步加载期间误拦截用户输入。
 *  真正的校验由服务端在 /api/chat 中执行，失败时返回 error 事件。 */
let serverConfig = { model: 'claude-opus-4-6', hasApiKey: true, baseUrlDisplay: '' };

/** 本地偏好设置（持久化到 localStorage，只存行为开关和 system prompt） */
let settings = loadSettings();

/** 流式控制 */
let isStreaming = false;
let abortController = null;

/** 服务端 API 日志流 */
let serverLogsSource = null;
const seenServerLogIds = new Set();
const seenServerLogIdsOrder = [];

// ================================================================
// DOM 引用（类比 Vue 的 $refs）
// ================================================================

const $ = (id) => document.getElementById(id);
const chatMessages  = $('chatMessages');
const userInput     = $('userInput');
const sendBtn       = $('sendBtn');
const statusDot     = $('statusDot');
const statusText    = $('statusText');
const currentModel  = $('currentModel');
const tokenHint     = $('tokenHint');
const toolsToggle   = $('toolsToggle');
const thinkingToggle= $('thinkingToggle');

// Debug panel
const timelineList  = $('timelineList');
const thinkingContent = $('thinkingContent');
const toolsLog      = $('toolsLog');
const requestsLog   = $('requestsLog');
const apiLogsList   = $('apiLogsList');
const apiLogsEmpty  = $('apiLogsEmpty');
const clearServerLogsBtn = $('clearServerLogsBtn');

// Stats
const statInputTokens  = $('stat-input-tokens');
const statOutputTokens = $('stat-output-tokens');
const statRounds       = $('stat-rounds');
const statToolCalls    = $('stat-tool-calls');
const statDuration     = $('stat-duration');
const statModel        = $('stat-model');

// ================================================================
// 初始化
// ================================================================

function init() {
  // 应用本地偏好
  applySettings();

  // 从服务端拉取连接配置（model、apiKey 状态等）
  fetchServerConfig();

  // 绑定 UI 事件
  bindEvents();

  // 订阅服务端 API 日志
  initServerLogs();
}

function bindEvents() {
  // 发送按钮（初始绑定，流式时会动态切换为停止）
  sendBtn.onclick = handleSend;

  // Enter 发送，Shift+Enter 换行；Esc 停止
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return; // 流式中不触发发送
      handleSend();
    }
    if (e.key === 'Escape' && isStreaming && abortController) {
      abortController.abort();
    }
  });

  // 自动调整 textarea 高度
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
  });

  // 清空对话
  $('clearBtn').addEventListener('click', clearConversation);

  // 清空调试面板
  $('clearDebugBtn').addEventListener('click', clearDebugPanel);

  // 设置面板
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('cancelSettingsBtn').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('settingsOverlay').addEventListener('click', closeSettings);

  // Debug 面板 Tab 切换
  document.querySelectorAll('.debug-tab').forEach(tab => {
    tab.addEventListener('click', () => switchDebugTab(tab.dataset.tab));
  });

  // 清空服务端日志
  if (clearServerLogsBtn) {
    clearServerLogsBtn.addEventListener('click', clearServerLogs);
  }
}

// ================================================================
// 服务端 API 日志（/api/server-logs + SSE stream）
// ================================================================

async function initServerLogs() {
  // 先拉取一份历史（用于刷新页面后立即可见）
  try {
    const res = await fetch('/api/server-logs');
    const data = await res.json();
    if (Array.isArray(data.logs)) {
      for (const entry of data.logs) appendServerLog(entry, { prepend: false, silent: true });
    }
  } catch {
    // 忽略：不影响聊天功能
  }

  // 再用 SSE 订阅实时日志
  try {
    serverLogsSource = new EventSource('/api/server-logs/stream');
    serverLogsSource.addEventListener('log', (e) => {
      try {
        appendServerLog(JSON.parse(e.data), { prepend: true, silent: false });
      } catch {
        // noop
      }
    });
  } catch {
    // EventSource 不可用时，至少保留历史拉取
  }
}

function classifyMethod(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'get' || m === 'head') return 'get';
  if (m === 'post') return 'post';
  if (m === 'put' || m === 'patch') return 'put';
  if (m === 'delete') return 'delete';
  return 'get';
}

function classifyStatus(entry) {
  if (entry && entry.aborted) return 'err';
  const s = Number(entry?.status || 0);
  if (s >= 500) return 'err';
  if (s >= 400) return 'warn';
  return 'ok';
}

function appendServerLog(entry, { prepend, silent } = { prepend: true, silent: false }) {
  if (!entry || !entry.id) return;
  if (seenServerLogIds.has(entry.id)) return;
  seenServerLogIds.add(entry.id);
  seenServerLogIdsOrder.push(entry.id);
  const MAX_SEEN_IDS = 1200;
  while (seenServerLogIdsOrder.length > MAX_SEEN_IDS) {
    const oldId = seenServerLogIdsOrder.shift();
    if (oldId) seenServerLogIds.delete(oldId);
  }

  if (!apiLogsList) return;

  const ts = entry.ts ? new Date(entry.ts) : new Date();
  const timeStr = ts.toLocaleTimeString('zh-CN', { hour12: false });
  const durationStr = (entry.durationMs || entry.durationMs === 0) ? `${entry.durationMs}ms` : '-';
  const methodClass = classifyMethod(entry.method);
  const statusClass = classifyStatus(entry);
  const statusText = entry.aborted ? `${entry.status || ''} ABORT` : String(entry.status || '');

  const details = { ...entry };
  const detailText = JSON.stringify(details, null, 2);

  const el = document.createElement('details');
  el.className = 'api-log-entry';
  el.innerHTML = `
    <summary>
      <span class="api-log-time">${escapeHtml(timeStr)}</span>
      <span class="api-log-method ${methodClass}">${escapeHtml(String(entry.method || ''))}</span>
      <span class="api-log-path">${escapeHtml(String(entry.path || ''))}</span>
      <span class="api-log-status ${statusClass}">${escapeHtml(statusText)}</span>
      <span class="api-log-duration">${escapeHtml(durationStr)}</span>
      ${entry.aborted ? `<span class="api-log-aborted">ABORTED</span>` : ''}
    </summary>
    <pre class="api-log-detail">${escapeHtml(detailText)}</pre>
  `;

  // 限制 DOM 数量，避免页面长期运行卡顿
  const MAX_DOM_LOGS = 200;
  if (prepend) apiLogsList.prepend(el);
  else apiLogsList.appendChild(el);
  while (apiLogsList.children.length > MAX_DOM_LOGS) {
    apiLogsList.removeChild(apiLogsList.lastElementChild);
  }

  // 显示列表，隐藏空态
  apiLogsList.style.display = '';
  if (apiLogsEmpty) apiLogsEmpty.style.display = 'none';

  if (!silent) {
    // 不强制切 Tab，避免影响用户操作；只在用户当前就在该 Tab 时保持更新即可
  }
}

async function clearServerLogs() {
  try {
    await fetch('/api/server-logs/clear', { method: 'POST' });
  } catch {
    showToast('清空失败：无法连接服务端', 'error');
    return;
  }

  seenServerLogIds.clear();
  seenServerLogIdsOrder.length = 0;
  if (apiLogsList) {
    apiLogsList.innerHTML = '';
    apiLogsList.style.display = 'none';
  }
  if (apiLogsEmpty) apiLogsEmpty.style.display = '';
}

async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    serverConfig = data;

    // 更新 header 和 stats 中的模型显示
    currentModel.textContent = data.model;
    statModel.textContent = data.model;

    // 更新设置面板中的状态展示
    updateEnvStatusUI(data);
  } catch {
    currentModel.textContent = '连接失败';
    updateEnvStatusUI({ hasApiKey: false, model: '未知', baseUrlDisplay: '连接失败' });
  }
}

function updateEnvStatusUI(config) {
  // API Key 状态
  const keyRow = $('envApiKeyStatus');
  if (keyRow) {
    const dot = keyRow.querySelector('.env-status-dot');
    const text = keyRow.querySelector('.env-status-text');
    if (config.hasApiKey) {
      dot.className = 'env-status-dot env-ok';
      text.textContent = '✅ 已在 .env 中配置';
    } else {
      dot.className = 'env-status-dot env-error';
      text.textContent = '❌ 未配置，请在 .env 中设置 LLM_API_KEY';
    }
  }
  // API 地址
  const baseUrlEl = $('envBaseUrlText');
  if (baseUrlEl) baseUrlEl.textContent = config.baseUrlDisplay || 'api.anthropic.com（官方）';
  // 模型
  const modelEl = $('envModelText');
  if (modelEl) modelEl.textContent = config.model || 'claude-opus-4-6';
}

// ================================================================
// 对话处理
// ================================================================

async function handleSend() {
  const text = userInput.value.trim();
  if (!text || isStreaming) return;

  // 重置输入框
  userInput.value = '';
  userInput.style.height = 'auto';

  // 校验服务端是否配置了 API Key（通过 /api/config 获取的状态）
  if (!serverConfig.hasApiKey) {
    showToast('⚠️ 服务端未配置 API Key，请在 .env 文件中设置 LLM_API_KEY 后重启', 'error');
    openSettings();
    return;
  }

  // 添加用户消息到历史和 UI
  conversationHistory.push({ role: 'user', content: text });
  appendMessage('user', text);

  // 清空本轮调试数据（工具调用和思考每轮重置）
  clearDebugPanel();
  // 重置本次请求的轮次 / 工具计数（token 保持累计，在 done 事件里更新）
  sessionStats.rounds = 0;
  sessionStats.toolCalls = 0;
  sessionStats.startTime = Date.now();
  statRounds.textContent = '0';
  statToolCalls.textContent = '0';
  statDuration.textContent = '-';
  $('roundStats').innerHTML = '';

  // 开始流式请求
  await startStreaming();
}

async function startStreaming() {
  isStreaming = true;
  abortController = new AbortController();

  setSendState(false);
  setStatus('streaming', '正在思考...');

  // 创建 assistant 消息占位符
  const { bubble, finalize } = createAssistantBubble();
  let textBuffer = '';
  let hasText = false;

  // 当前轮的工具调用映射（id -> entry）
  const toolEntries = {};

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationHistory,
        settings: {
          // apiKey / baseUrl / model 由服务端从 .env 读取，前端只传行为开关
          enableThinking: thinkingToggle.checked,
          enableTools: toolsToggle.checked,
          systemPrompt: settings.systemPrompt || '',
        }
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // ── 解析 SSE 流 ─────────────────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 追加到缓冲区（SSE 数据可能跨 chunk）
      sseBuffer += decoder.decode(value, { stream: true });

      // 按行分割，处理完整的 SSE 事件行
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? ''; // 最后一行可能不完整，保留

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);
          handleSSEEvent(event, bubble, toolEntries, (text) => {
            textBuffer += text;
            hasText = true;
          });
        } catch {
          // 忽略 JSON 解析错误（通常是空行）
        }
      }
    }

    // 最终消息加入历史
    if (textBuffer) {
      conversationHistory.push({ role: 'assistant', content: textBuffer });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      appendTimelineEvent('error-ev', '⛔', '请求已取消', '');
    } else {
      const msg = err.message || '未知错误';
      showErrorInBubble(bubble, msg);
      appendTimelineEvent('error-ev', '❌', '请求失败', msg);
    }
  } finally {
    finalize(); // 移除流式光标，完成最终 Markdown 渲染
    isStreaming = false;
    abortController = null;
    setSendState(true);
    setStatus('idle', '就绪');

    // 更新统计
    const duration = sessionStats.startTime ? ((Date.now() - sessionStats.startTime) / 1000).toFixed(1) + 's' : '-';
    statDuration.textContent = duration;
    statModel.textContent = serverConfig.model || '-';
  }
}

/**
 * 处理单条 SSE 事件
 * 这是核心函数，对应后端 src/agent.ts 的 sendSSE 调用
 */
function handleSSEEvent(event, bubble, toolEntries, onText) {
  switch (event.type) {

    // ── 请求参数 ─────────────────────────────────────────────────
    case 'request_params': {
      ensureDebugVisible('requestsLog');
      requestsLog.appendChild(createRequestEntry(event));
      switchDebugTab('requests');
      break;
    }

    // ── 轮次开始 ─────────────────────────────────────────────────
    case 'round_start': {
      sessionStats.rounds++;
      statRounds.textContent = sessionStats.rounds;
      appendTimelineEvent('round', '🔄', `第 ${event.round} 轮 LLM 调用`, formatTime());
      setStatus('streaming', `第 ${event.round} 轮生成中...`);
      break;
    }

    // ── 思考开始 ─────────────────────────────────────────────────
    case 'thinking_start': {
      setStatus('thinking', '思考中...');
      // 在气泡内插入思考指示器（如果还没有）
      if (!bubble.querySelector('.thinking-indicator')) {
        const indicator = document.createElement('div');
        indicator.className = 'thinking-indicator';
        indicator.innerHTML = `
          <div class="thinking-dots"><span></span><span></span><span></span></div>
          <span>Claude 正在思考...</span>
        `;
        // 插在光标前面
        const cursor = bubble.querySelector('.stream-cursor-char');
        if (cursor) bubble.insertBefore(indicator, cursor);
        else bubble.appendChild(indicator);
      }
      // 在调试面板创建思考块
      ensureDebugVisible('thinkingContent');
      const block = document.createElement('div');
      block.className = 'thinking-block';
      block.id = `thinking-${Date.now()}`;
      block.innerHTML = `<div class="thinking-block-header">💭 推理过程 Round ${sessionStats.rounds}</div><div class="thinking-text"></div>`;
      thinkingContent.appendChild(block);
      appendTimelineEvent('thinking-ev', '💭', '思考开始', '正在推理...');
      // 自动切换到思考 tab
      switchDebugTab('thinking');
      break;
    }

    // ── 思考内容流 ───────────────────────────────────────────────
    case 'thinking': {
      const lastBlock = thinkingContent.lastElementChild;
      if (lastBlock) {
        const textEl = lastBlock.querySelector('.thinking-text');
        if (textEl) textEl.textContent += event.delta;
      }
      break;
    }

    // ── 文本流 ───────────────────────────────────────────────────
    case 'text': {
      if (event.delta) {
        // 第一个文本 token 到来时移除思考指示器
        const thinkingIndicator = bubble.querySelector('.thinking-indicator');
        if (thinkingIndicator) thinkingIndicator.remove();
        onText(event.delta);
        appendTextToBubble(bubble, event.delta);
        setStatus('streaming', '生成中...');
      }
      break;
    }

    // ── 思考结束 ─────────────────────────────────────────────────
    case 'thinking_end': {
      setStatus('streaming', '生成中...');
      // 移除气泡内的思考指示器
      const thinkingIndicator = bubble.querySelector('.thinking-indicator');
      if (thinkingIndicator) thinkingIndicator.remove();
      break;
    }

    // ── 工具调用 ─────────────────────────────────────────────────
    case 'tool_call': {
      sessionStats.toolCalls++;
      statToolCalls.textContent = sessionStats.toolCalls;
      setStatus('tool', `调用工具：${event.name}`);

      // 在 tools tab 创建条目（记录调用开始时间，用于计算耗时）
      ensureDebugVisible('toolsLog');
      const entry = createToolEntry(event.id, event.name, event.input);
      entry._callTime = Date.now();
      toolEntries[event.id] = entry;
      toolsLog.appendChild(entry);

      // 时间线记录
      const inputPreview = JSON.stringify(event.input);
      appendTimelineEvent(
        'tool-call-ev', '🔧',
        `工具调用：${event.name}`,
        inputPreview.length > 80 ? inputPreview.slice(0, 80) + '...' : inputPreview
      );

      // 自动切换到工具 tab
      switchDebugTab('tools');
      break;
    }

    // ── 工具结果 ─────────────────────────────────────────────────
    case 'tool_result': {
      // 更新对应的工具条目
      const entry = toolEntries[event.id];
      if (entry) {
        const elapsed = entry._callTime ? ((Date.now() - entry._callTime) / 1000).toFixed(2) + 's' : '';
        addToolResult(entry, event.result, elapsed);
        entry.classList.add('expanded'); // 自动展开
      }

      // 时间线记录
      appendTimelineEvent(
        'tool-result-ev', '✅',
        `工具返回：${event.name}`,
        (event.result || '').slice(0, 60)
      );
      break;
    }

    // ── Token 统计 ───────────────────────────────────────────────
    case 'usage': {
      sessionStats.inputTokens = event.totalUsage?.input_tokens ?? event.usage?.input_tokens ?? sessionStats.inputTokens;
      sessionStats.outputTokens = event.totalUsage?.output_tokens ?? event.usage?.output_tokens ?? sessionStats.outputTokens;
      statInputTokens.textContent = sessionStats.inputTokens.toLocaleString();
      statOutputTokens.textContent = sessionStats.outputTokens.toLocaleString();

      // 更新输入框底部 token 提示
      tokenHint.textContent = `本轮 in:${event.usage?.input_tokens ?? 0} out:${event.usage?.output_tokens ?? 0}`;

      // 添加轮次统计
      addRoundStat(event.round, event.usage);
      break;
    }

    // ── 完成 ─────────────────────────────────────────────────────
    case 'done': {
      const total = event.totalUsage;
      if (total) {
        sessionStats.inputTokens = total.input_tokens;
        sessionStats.outputTokens = total.output_tokens;
        statInputTokens.textContent = total.input_tokens.toLocaleString();
        statOutputTokens.textContent = total.output_tokens.toLocaleString();
      }
      appendTimelineEvent(
        'done-ev', '✨',
        '生成完成',
        `共 ${sessionStats.rounds} 轮，${sessionStats.toolCalls} 次工具调用`
      );
      break;
    }

    // ── 错误 ─────────────────────────────────────────────────────
    case 'error': {
      showErrorInBubble(bubble, event.message);
      appendTimelineEvent('error-ev', '❌', '发生错误', event.message);
      break;
    }
  }
}

// ================================================================
// UI 构建函数
// ================================================================

function appendMessage(role, content) {
  // 隐藏欢迎消息
  const welcome = chatMessages.querySelector('.welcome-message');
  if (welcome) welcome.style.display = 'none';

  const div = document.createElement('div');
  div.className = `message message-${role}`;
  div.innerHTML = `
    <div class="message-role">${role === 'user' ? '你' : 'Assistant'}</div>
    <div class="message-bubble">${escapeHtml(content)}</div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
  return div;
}

function createAssistantBubble() {
  // 隐藏欢迎消息
  const welcome = chatMessages.querySelector('.welcome-message');
  if (welcome) welcome.style.display = 'none';

  const div = document.createElement('div');
  div.className = 'message message-assistant';
  div.innerHTML = `
    <div class="message-role">Assistant</div>
    <div class="message-bubble"><span class="stream-cursor-char">▋</span></div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();

  const bubble = div.querySelector('.message-bubble');
  return {
    bubble,
    finalize: () => {
      // 移除流式光标，用最终文本做完整 Markdown 渲染
      if (bubble._rawText) {
        bubble.innerHTML = renderMarkdown(bubble._rawText);
      } else {
        // 没有文本（比如只工具调用，无 text 输出）
        const cursor = bubble.querySelector('.stream-cursor-char');
        if (cursor) cursor.remove();
      }
    }
  };
}

/**
 * 流式追加文本到气泡（流式过程中存原始文本，完成后渲染 Markdown）
 * bubble._rawText 存储原始 markdown 文本
 */
function appendTextToBubble(bubble, text) {
  bubble._rawText = (bubble._rawText || '') + text;
  // 流式中只做简单渲染（避免频繁 DOM 重建影响性能）
  bubble.innerHTML = renderMarkdown(bubble._rawText) + '<span class="stream-cursor-char">▋</span>';
  scrollToBottom();
}

/**
 * 轻量 Markdown 渲染器（教学级别，覆盖常见格式）
 * 支持：代码块、行内代码、粗体、斜体、列表、标题、水平线、换行
 */
function renderMarkdown(text) {
  if (!text) return '';

  // 1. 代码块 ```lang\n...\n``` → <pre><code>
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    return `<pre class="md-pre">${langLabel}<code>${escapeHtml(code.trim())}</code></pre>`;
  });

  // 2. 行内代码 `code`
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    `<code class="md-code">${escapeHtml(code)}</code>`
  );

  // 3. 粗体 **text** 或 __text__
  text = text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) =>
    `<strong>${a || b}</strong>`
  );

  // 4. 斜体 *text* 或 _text_（避免和粗体冲突）
  text = text.replace(/\*([^*\n]+)\*|(?<![_a-zA-Z])_([^_\n]+)_(?![_a-zA-Z])/g, (_, a, b) =>
    `<em>${a || b}</em>`
  );

  // 5. 标题 # ## ###
  text = text.replace(/^(#{1,3})\s+(.+)$/gm, (_, hashes, content) => {
    const level = hashes.length;
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  // 6. 无序列表 - item 或 * item
  text = text.replace(/^[\-\*]\s+(.+)$/gm, (_, item) =>
    `<li class="md-li">• ${item}</li>`
  );

  // 7. 有序列表 1. item
  text = text.replace(/^\d+\.\s+(.+)$/gm, (_, item) =>
    `<li class="md-li md-oli">${item}</li>`
  );

  // 8. 水平分割线
  text = text.replace(/^---+$/gm, '<hr class="md-hr">');

  // 9. 换行（\n 转 <br>，但 <pre> 内不转）
  // 先把 pre 块提取出来，避免内部换行被处理
  const prePlaceholders = [];
  text = text.replace(/<pre[\s\S]*?<\/pre>/g, (match) => {
    prePlaceholders.push(match);
    return `\x00PRE${prePlaceholders.length - 1}\x00`;
  });
  text = text.replace(/\n/g, '<br>');
  // 还原 pre 块
  text = text.replace(/\x00PRE(\d+)\x00/g, (_, i) => prePlaceholders[parseInt(i)]);

  return text;
}

function showErrorInBubble(bubble, message) {
  bubble.innerHTML = `<span style="color:var(--accent-red)">⚠️ ${escapeHtml(message)}</span>`;
  bubble._rawText = ''; // 清除原始文本，避免 finalize 覆盖错误提示
}

// ================================================================
// 调试面板
// ================================================================

function appendTimelineEvent(type, icon, title, detail) {
  // 显示列表，隐藏 empty state
  ensureDebugVisible('timelineList');

  const item = document.createElement('div');
  item.className = `timeline-item ${type}`;
  item.innerHTML = `
    <span class="timeline-icon">${icon}</span>
    <div class="timeline-body">
      <div class="timeline-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="timeline-detail">${escapeHtml(detail)}</div>` : ''}
    </div>
    <span class="timeline-time">${formatTime()}</span>
  `;
  timelineList.appendChild(item);
  timelineList.scrollTop = timelineList.scrollHeight;
}

function createToolEntry(id, name, input) {
  const entry = document.createElement('div');
  entry.className = 'tool-entry';
  entry.innerHTML = `
    <div class="tool-entry-header" onclick="toggleToolEntry(this.parentElement)">
      <span style="color:var(--accent-cyan)">🔧</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-status-badge tool-running">运行中</span>
      <span class="tool-id">${id.slice(-8)}</span>
      <span class="tool-chevron">▶</span>
    </div>
    <div class="tool-entry-body">
      <div class="tool-section">
        <div class="tool-section-label">📥 输入参数</div>
        <pre class="tool-json">${escapeHtml(JSON.stringify(input, null, 2))}</pre>
      </div>
      <div class="tool-section result">
        <div class="tool-section-label">📤 执行结果</div>
        <div class="tool-result-text" style="color:var(--text-muted)">⏳ 等待执行...</div>
      </div>
    </div>
  `;
  return entry;
}

function createRequestEntry(event) {
  const entry = document.createElement('div');
  entry.className = 'tool-entry';

  const toolsHtml = event.tools?.length > 0
    ? event.tools.map(t => `<span class="request-tool-tag">${escapeHtml(t)}</span>`).join('')
    : '<span style="color:var(--text-muted)">（未启用）</span>';

  const messagesHtml = (event.messages || []).map(m => {
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const preview = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    return `<div class="request-message">
      <span class="request-msg-role ${m.role}">${m.role}</span>
      <span class="request-msg-content">${escapeHtml(preview)}</span>
    </div>`;
  }).join('');

  entry.innerHTML = `
    <div class="tool-entry-header" onclick="toggleToolEntry(this.parentElement)">
      <span style="color:var(--accent-blue)">📤</span>
      <span class="tool-name">Round ${event.round} 请求</span>
      <span class="tool-status-badge" style="background:rgba(79,156,249,0.12);color:var(--accent-blue);border-color:rgba(79,156,249,0.3)">${escapeHtml(event.model)}</span>
      <span style="color:var(--text-muted);font-size:11px">${event.messages?.length ?? 0} 条消息</span>
      <span class="tool-chevron">▶</span>
    </div>
    <div class="tool-entry-body">
      <div class="tool-section">
        <div class="tool-section-label">⚙️ 模型配置</div>
        <pre class="tool-json">model:      ${escapeHtml(event.model)}
maxTokens:  ${event.maxTokens}
thinking:   ${event.enableThinking}
system:     ${event.systemPrompt ? escapeHtml(event.systemPrompt.slice(0, 80)) + (event.systemPrompt.length > 80 ? '…' : '') : '（默认）'}</pre>
      </div>
      <div class="tool-section">
        <div class="tool-section-label">🔧 工具列表（${event.tools?.length ?? 0} 个）</div>
        <div class="request-tools">${toolsHtml}</div>
      </div>
      <div class="tool-section">
        <div class="tool-section-label">💬 Messages（${event.messages?.length ?? 0} 条）</div>
        <div class="request-messages">${messagesHtml}</div>
      </div>
    </div>
  `;
  return entry;
}

function addToolResult(entry, result, elapsed) {
  const resultSection = entry.querySelector('.tool-result-text');
  if (resultSection) {
    resultSection.style.color = '';
    resultSection.textContent = result;
  }
  // 更新状态徽标
  const badge = entry.querySelector('.tool-status-badge');
  if (badge) {
    badge.className = 'tool-status-badge tool-done';
    badge.textContent = elapsed ? `✓ ${elapsed}` : '✓ 完成';
  }
}

function addRoundStat(round, usage) {
  const container = $('roundStats');
  if (!container || !usage) return;

  const item = document.createElement('div');
  item.className = 'round-stat-item';
  item.innerHTML = `
    <span class="round-stat-label">Round ${round}</span>
    <span class="round-stat-value">in: ${usage.input_tokens} / out: ${usage.output_tokens}</span>
  `;
  container.appendChild(item);
}

// ================================================================
// 工具函数
// ================================================================

function ensureDebugVisible(elementId) {
  const el = $(elementId);
  if (el) {
    el.style.display = '';
    // 隐藏对应的 empty state
    const parent = el.parentElement;
    if (parent) {
      ['timeline-empty', 'requests-empty', 'api-logs-empty', 'thinking-empty', 'tools-empty'].forEach(cls => {
        const empty = parent.querySelector(`.${cls}`);
        if (empty) empty.style.display = 'none';
      });
    }
  }
}

function switchDebugTab(tabName) {
  document.querySelectorAll('.debug-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
}

function toggleToolEntry(entry) {
  entry.classList.toggle('expanded');
}

function clearConversation() {
  conversationHistory.length = 0;
  chatMessages.innerHTML = '';
  // 恢复欢迎消息
  const welcome = document.createElement('div');
  welcome.className = 'welcome-message';
  welcome.innerHTML = `
    <div class="welcome-icon">🤖</div>
    <h2>你好！我是 Agent Demo</h2>
    <p>这是 Week 5-6 的教学项目，展示：</p>
    <ul>
      <li>📡 <strong>SSE 流式输出</strong> — 逐 token 实时渲染</li>
      <li>🔧 <strong>工具调用</strong> — 时间、计算、天气、知识库</li>
      <li>💭 <strong>思考过程</strong> — 可视化 Claude 的推理链</li>
    </ul>
    <div class="welcome-hints">
      <p>试着问：</p>
      <button class="hint-btn" onclick="fillInput('现在几点了？帮我算一下 2 的 16 次方是多少')">🕐 时间 + 计算</button>
      <button class="hint-btn" onclick="fillInput('北京和上海的天气怎么样？哪个城市更适合户外活动？')">🌤️ 多工具调用</button>
      <button class="hint-btn" onclick="fillInput('帮我搜索一下 ReAct 范式和 Function Calling 的区别')">📚 知识搜索</button>
      <button class="hint-btn" onclick="fillInput('我想学习 Agent 开发，请给我制定一个学习计划')">🎯 自由对话</button>
    </div>
  `;
  chatMessages.appendChild(welcome);
  clearDebugPanel();
}

function clearDebugPanel() {
  // 清空调试面板但保留统计
  timelineList.innerHTML = '';
  timelineList.style.display = 'none';
  document.querySelector('.timeline-empty') && (document.querySelector('.timeline-empty').style.display = '');

  thinkingContent.innerHTML = '';
  thinkingContent.style.display = 'none';
  document.querySelector('.thinking-empty') && (document.querySelector('.thinking-empty').style.display = '');

  toolsLog.innerHTML = '';
  toolsLog.style.display = 'none';
  document.querySelector('.tools-empty') && (document.querySelector('.tools-empty').style.display = '');

  requestsLog.innerHTML = '';
  requestsLog.style.display = 'none';
  document.querySelector('.requests-empty') && (document.querySelector('.requests-empty').style.display = '');

  if (apiLogsList) {
    apiLogsList.innerHTML = '';
    apiLogsList.style.display = 'none';
  }
  if (apiLogsEmpty) apiLogsEmpty.style.display = '';
}

function setSendState(enabled) {
  userInput.disabled = !enabled;
  if (!enabled) {
    // 流式中：变为停止按钮
    sendBtn.disabled = false;
    sendBtn.title = '停止生成 (Esc)';
    sendBtn.innerHTML = '<span style="font-size:13px;font-weight:bold">■</span>';
    sendBtn.style.background = 'var(--accent-red)';
    sendBtn.onclick = () => {
      if (abortController) abortController.abort();
    };
  } else {
    sendBtn.disabled = false;
    sendBtn.title = '发送 (Enter)';
    sendBtn.innerHTML = '<span class="send-icon">↑</span>';
    sendBtn.style.background = '';
    sendBtn.onclick = handleSend;
  }
}

function setStatus(type, text) {
  statusDot.className = `status-dot ${type === 'idle' ? '' : type}`;
  statusText.textContent = text;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = JSON.stringify(str) || '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:${type === 'error' ? 'var(--accent-red)' : 'var(--accent-blue)'};
    color:white; padding:10px 20px; border-radius:8px; font-size:13px;
    z-index:999; animation:fadeIn 0.2s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// 全局函数（供 HTML onclick 调用）
window.fillInput = (text) => {
  userInput.value = text;
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
  userInput.focus();
};

window.toggleToolEntry = (entry) => {
  entry.classList.toggle('expanded');
};


// ================================================================
// 设置管理（持久化到 localStorage）
// ================================================================

function loadSettings() {
  try {
    const saved = localStorage.getItem('agent-demo-settings');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function applySettings() {
  toolsToggle.checked = settings.enableTools !== false;
  thinkingToggle.checked = Boolean(settings.enableThinking);
}

function openSettings() {
  // 重新拉取服务端状态，保持最新
  fetchServerConfig();
  $('systemPrompt').value = settings.systemPrompt || '';

  $('settingsOverlay').classList.add('open');
  $('settingsDrawer').classList.add('open');
}

function closeSettings() {
  $('settingsOverlay').classList.remove('open');
  $('settingsDrawer').classList.remove('open');
}

function saveSettings() {
  settings = {
    enableTools: toolsToggle.checked,
    enableThinking: thinkingToggle.checked,
    systemPrompt: $('systemPrompt').value.trim(),
  };

  try {
    localStorage.setItem('agent-demo-settings', JSON.stringify(settings));
  } catch {
    // localStorage 不可用时忽略
  }

  applySettings();
  closeSettings();
  showToast('✅ 设置已保存');
}

// toggle 变化时同步到 settings
toolsToggle.addEventListener('change', () => {
  settings.enableTools = toolsToggle.checked;
  try { localStorage.setItem('agent-demo-settings', JSON.stringify(settings)); } catch {}
});

thinkingToggle.addEventListener('change', () => {
  settings.enableThinking = thinkingToggle.checked;
  try { localStorage.setItem('agent-demo-settings', JSON.stringify(settings)); } catch {}
});

// ================================================================
// 启动
// ================================================================
init();
