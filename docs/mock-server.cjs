#!/usr/bin/env node
/**
 * Mock API server for development/testing
 * Simulates the z.ai API responses for quota and wake endpoints
 *
 * Each API key gets its own independent state (quota, wake timer, stats).
 * The key is identified from the Authorization header sent by the Rust backend.
 *
 * Usage: node mock-server.cjs [options]
 * Options:
 *   --port=PORT       Server port (default: 3456)
 *   --expiry=MINUTES  Quota expiry time after wake in minutes (default: 3)
 *
 * Environment variables:
 *   MOCK_PORT       Server port
 *   MOCK_EXPIRY     Quota expiry time in minutes after wake
 */

const http = require('http');
const url = require('url');

// Parse arguments
function parseArgs() {
  const args = {
    port: parseInt(process.env.MOCK_PORT || '3456', 10),
    expiryMinutes: parseFloat(process.env.MOCK_EXPIRY || '3'),
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--port=')) {
      args.port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--expiry=')) {
      args.expiryMinutes = parseFloat(arg.split('=')[1]);
    } else if (!arg.startsWith('-')) {
      args.port = parseInt(arg, 10);
    }
  }

  return args;
}

const config = parseArgs();

// ─── Per-key state ───────────────────────────────────────────────────────────
// Each unique API key gets its own KeyState with independent quota, wake timer,
// and usage data. This lets you test multi-key scenarios realistically.

/**
 * @typedef {Object} KeyState
 * @property {string} keyId          - Short identifier for logging
 * @property {number|null} wakeTimeEpoch
 * @property {number|null} wakeExpiryEpoch
 * @property {number} quotaPercentage
 * @property {number} timeLimitUsage
 * @property {Array} timeLimitDetails
 * @property {number} modelCalls5h
 * @property {number} tokens5h
 * @property {number} modelCalls24h
 * @property {number} tokens24h
 * @property {number} toolNetworkSearch
 * @property {number} toolWebRead
 * @property {number} toolZread
 * @property {number} toolSearchMcp
 * @property {number} wakeCount       - Total number of wakes for this key
 * @property {number} requestCount    - Total requests for this key
 */

/** @type {Map<string, KeyState>} */
const keyStates = new Map();

let globalRequestCount = 0;

// Predefined color profiles for different keys - gives each key a
// distinctly different personality so you can tell them apart at a glance.
const KEY_PROFILES = [
  { label: 'Alpha', pctRange: [5, 15], callsRange: [50, 150], tokensRange: [500000, 2000000] },
  { label: 'Beta', pctRange: [25, 45], callsRange: [200, 500], tokensRange: [3000000, 8000000] },
  { label: 'Gamma', pctRange: [50, 70], callsRange: [400, 800], tokensRange: [8000000, 20000000] },
  { label: 'Delta', pctRange: [10, 30], callsRange: [100, 300], tokensRange: [1000000, 5000000] },
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Extract a short key identifier from the Authorization header.
 * Returns something like "abc...xyz" or "unknown".
 */
function extractKeyId(authHeader) {
  if (!authHeader) return 'no-key';

  // Strip "Bearer " prefix
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length < 8) return token || 'no-key';

  // Show first 4 and last 4 chars
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Get a stable hash-like index from the full API key.
 * Used to assign a consistent profile to each key.
 */
function keyProfileIndex(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % KEY_PROFILES.length;
}

/**
 * Get or create the state for a given API key.
 */
function getKeyState(authHeader) {
  // Normalize: use full token as the map key
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim() || '__default__';

  if (keyStates.has(token)) {
    return keyStates.get(token);
  }

  // Create new state with profile-based defaults
  const profileIdx = keyProfileIndex(authHeader);
  const profile = KEY_PROFILES[profileIdx];

  /** @type {KeyState} */
  const state = {
    keyId: extractKeyId(authHeader),
    profileLabel: profile.label,
    wakeTimeEpoch: null,
    wakeExpiryEpoch: null,
    quotaPercentage: 0,
    timeLimitUsage: 0,
    timeLimitDetails: [],
    modelCalls5h: 0,
    tokens5h: 0,
    modelCalls24h: 0,
    tokens24h: 0,
    toolNetworkSearch: 0,
    toolWebRead: 0,
    toolZread: 0,
    toolSearchMcp: 0,
    wakeCount: 0,
    requestCount: 0,
    pctRange: profile.pctRange,
    callsRange: profile.callsRange,
    tokensRange: profile.tokensRange,
  };

  keyStates.set(token, state);
  console.log(`\n  ✦ New key registered: [${state.keyId}] → profile "${profile.label}" (pct ${profile.pctRange[0]}-${profile.pctRange[1]}%)`);

  return state;
}

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isQuotaWarm(state) {
  if (state.wakeExpiryEpoch === null) return false;
  return Date.now() < state.wakeExpiryEpoch;
}

function getRemainingSeconds(state) {
  if (state.wakeExpiryEpoch === null) return 0;
  return Math.max(0, Math.floor((state.wakeExpiryEpoch - Date.now()) / 1000));
}

// Generate stable random data for a specific key's wake cycle
function generateStableData(state) {
  const [pctMin, pctMax] = state.pctRange;
  const [callsMin, callsMax] = state.callsRange;
  const [tokMin, tokMax] = state.tokensRange;

  state.quotaPercentage = randInt(pctMin, pctMax);
  state.timeLimitUsage = randInt(10, 80);
  state.timeLimitDetails = [
    { modelCode: "search-prime", usage: randInt(1, 15) },
    { modelCode: "web-reader", usage: randInt(1, 10) },
    { modelCode: "zread", usage: randInt(2, 30) }
  ];

  state.modelCalls5h = randInt(callsMin, callsMax);
  state.tokens5h = randInt(tokMin, tokMax);
  state.modelCalls24h = state.modelCalls5h + randInt(100, 400);
  state.tokens24h = state.tokens5h + randInt(tokMin, tokMax);

  state.toolNetworkSearch = randInt(5, 60);
  state.toolWebRead = randInt(2, 40);
  state.toolZread = randInt(10, 120);
  state.toolSearchMcp = randInt(5, 50);
}

// Wake a specific key
function performWake(state) {
  state.wakeTimeEpoch = Date.now();
  state.wakeExpiryEpoch = state.wakeTimeEpoch + config.expiryMinutes * 60 * 1000;
  state.wakeCount++;
  generateStableData(state);
  console.log(`  ⚡ [${state.keyId}] WAKE #${state.wakeCount}! Timer started, expires ${new Date(state.wakeExpiryEpoch).toLocaleTimeString()} (${config.expiryMinutes}min) → pct=${state.quotaPercentage}%, calls=${state.modelCalls5h}`);
}

// Quota response for a specific key
function getQuotaResponse(state) {
  const warm = isQuotaWarm(state);

  const tokensLimit = {
    type: "TOKENS_LIMIT",
    unit: 3,
    number: 5,
    percentage: warm ? state.quotaPercentage : 0,
  };

  if (warm) {
    tokensLimit.nextResetTime = state.wakeExpiryEpoch;
  }

  return {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: warm ? state.timeLimitUsage : 0,
        remaining: warm ? 1000 - state.timeLimitUsage : 1000,
        percentage: warm ? Math.floor(state.timeLimitUsage / 10) : 0,
        nextResetTime: null,
        usageDetails: warm ? state.timeLimitDetails : []
      },
      tokensLimit
    ],
    level: "pro"
  };
}

// Chat completion response
function getChatCompletionResponse() {
  return {
    id: "mock-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Mock response - quota activated" },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;

  globalRequestCount++;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (no auth needed)
  if (path === '/' || path === '/health') {
    const states = [];
    for (const [, state] of keyStates) {
      const warm = isQuotaWarm(state);
      states.push({
        keyId: state.keyId,
        profile: state.profileLabel,
        state: warm ? 'warm' : 'cold',
        percentage: state.quotaPercentage,
        remainingHMS: warm ? formatHMS(getRemainingSeconds(state)) : null,
        wakeCount: state.wakeCount,
        requestCount: state.requestCount,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      message: 'Mock server running',
      totalRequests: globalRequestCount,
      keys: states,
      config: { expiryMinutes: config.expiryMinutes }
    }, null, 2));
    return;
  }

  // All other endpoints need auth → per-key state
  const authHeader = req.headers['authorization'] || '';
  const state = getKeyState(authHeader);
  state.requestCount++;

  const warm = isQuotaWarm(state);
  const statusStr = warm ? `WARM (${formatHMS(getRemainingSeconds(state))} left, ${state.quotaPercentage}%)` : 'COLD';
  console.log(`[${new Date().toISOString()}] #${globalRequestCount} ${method} ${path} [${state.keyId}] [${statusStr}]`);

  // Route handling
  if (path.includes('/quota/limit') || path.includes('/monitor/usage/quota/limit')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: getQuotaResponse(state),
      msg: "Operation successful",
      success: true
    }));
    return;
  }

  if (path.includes('/chat/completions')) {
    performWake(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getChatCompletionResponse()));
    return;
  }

  if (path.includes('/wake') || path.includes('/warmup')) {
    performWake(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        message: "Wake successful - quota timer started",
        timestamp: Date.now(),
        expiresAt: state.wakeExpiryEpoch
      }
    }));
    return;
  }

  if (path.includes('/model-usage')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });

    const query = parsedUrl.query || {};
    const startTime = query.startTime || '';
    const is24h = !warm || startTime.length === 0;

    const calls = warm ? (is24h ? state.modelCalls24h : state.modelCalls5h) : 0;
    const tokens = warm ? (is24h ? state.tokens24h : state.tokens5h) : 0;

    res.end(JSON.stringify({
      code: 200,
      data: {
        totalUsage: {
          totalModelCallCount: calls,
          totalTokensUsage: tokens
        }
      },
      msg: "Operation successful",
      success: true
    }));
    return;
  }

  if (path.includes('/tool-usage')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: {
        totalUsage: {
          totalNetworkSearchCount: warm ? state.toolNetworkSearch : 0,
          totalWebReadMcpCount: warm ? state.toolWebRead : 0,
          totalZreadMcpCount: warm ? state.toolZread : 0,
          totalSearchMcpCount: warm ? state.toolSearchMcp : 0
        }
      },
      msg: "Operation successful",
      success: true
    }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path }));
});

server.listen(config.port, () => {
  console.log(`\n  Mock API server running on http://localhost:${config.port}`);
  console.log('');
  console.log('  Configuration:');
  console.log(`    Quota expiry after wake: ${config.expiryMinutes} minutes`);
  console.log('');
  console.log('  Multi-key support:');
  console.log('    Each API key gets independent state + a unique data profile.');
  console.log('    The key is identified from the Authorization header.');
  console.log('    Profiles assign different usage ranges so keys look distinct.');
  console.log('');
  console.log('  Key profiles:');
  KEY_PROFILES.forEach((p, i) => {
    console.log(`    ${i}: "${p.label}" → quota ${p.pctRange[0]}-${p.pctRange[1]}%, calls ${p.callsRange[0]}-${p.callsRange[1]}`);
  });
  console.log('');
  console.log('  Behavior:');
  console.log('    - Each key starts COLD (no nextResetTime)');
  console.log('    - POST /chat/completions → WAKE that key (starts timer, generates data)');
  console.log('    - GET requests return stable data for that key until next wake/expiry');
  console.log(`    - After ${config.expiryMinutes}min → that key goes COLD again`);
  console.log('');
  console.log('  Endpoints:');
  console.log('    GET  /api/monitor/usage/quota/limit       - Quota & timer state');
  console.log('    GET  /api/monitor/usage/model-usage       - Model call/token stats');
  console.log('    GET  /api/monitor/usage/tool-usage        - Tool usage stats');
  console.log('    POST /api/coding/paas/v4/chat/completions - Wake');
  console.log('    GET  /health                              - Health check (all keys)');
  console.log('');
});
