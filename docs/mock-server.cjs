#!/usr/bin/env node
/**
 * Mock API server for development/testing
 * Simulates the z.ai API responses for quota and wake endpoints
 *
 * Usage: node mock-server.cjs [options]
 * Options:
 *   --port=PORT       Server port (default: 3456)
 *   --expiry=MINUTES  Quota expiry time after wake in minutes (default: 10)
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
    expiryMinutes: parseFloat(process.env.MOCK_EXPIRY || '3'),  // Default 10 minutes after wake
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

// ─── Stable simulated state ───────────────────────────────────────────────────
// Data is generated ONCE at wake time and returned consistently on every request.
// This matches real API behavior where data only changes on actual usage.

let requestCount = 0;

// Wake state
let wakeTimeEpoch = null;
let wakeExpiryEpoch = null;

// Stable quota data (regenerated only on wake)
let quotaPercentage = 0;
let timeLimitUsage = 0;
let timeLimitDetails = [];

// Stable model-usage data (regenerated only on wake)
let modelCalls5h = 0;
let tokens5h = 0;
let modelCalls24h = 0;
let tokens24h = 0;

// Stable tool-usage data (regenerated only on wake)
let toolNetworkSearch = 0;
let toolWebRead = 0;
let toolZread = 0;
let toolSearchMcp = 0;

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isQuotaWarm() {
  if (wakeExpiryEpoch === null) return false;
  return Date.now() < wakeExpiryEpoch;
}

function getRemainingSeconds() {
  if (wakeExpiryEpoch === null) return 0;
  return Math.max(0, Math.floor((wakeExpiryEpoch - Date.now()) / 1000));
}

// Generate stable random data for the current wake cycle
function generateStableData() {
  quotaPercentage = Math.floor(Math.random() * 20) + 5;
  timeLimitUsage = Math.floor(Math.random() * 50) + 10;
  timeLimitDetails = [
    { modelCode: "search-prime", usage: Math.floor(Math.random() * 10) + 1 },
    { modelCode: "web-reader", usage: Math.floor(Math.random() * 5) + 1 },
    { modelCode: "zread", usage: Math.floor(Math.random() * 20) + 2 }
  ];

  modelCalls5h = Math.floor(Math.random() * 200) + 50;
  tokens5h = Math.floor(Math.random() * 5000000) + 1000000;
  modelCalls24h = modelCalls5h + Math.floor(Math.random() * 300) + 100;
  tokens24h = tokens5h + Math.floor(Math.random() * 10000000) + 3000000;

  toolNetworkSearch = Math.floor(Math.random() * 50) + 10;
  toolWebRead = Math.floor(Math.random() * 30) + 5;
  toolZread = Math.floor(Math.random() * 100) + 20;
  toolSearchMcp = Math.floor(Math.random() * 40) + 8;
}

// Wake the quota - start the timer and regenerate stable data
function performWake() {
  wakeTimeEpoch = Date.now();
  wakeExpiryEpoch = wakeTimeEpoch + config.expiryMinutes * 60 * 1000;
  generateStableData();
  console.log(`[${new Date().toISOString()}] WAKE! Timer started, expires in ${config.expiryMinutes} min (${new Date(wakeExpiryEpoch).toLocaleTimeString()})`);
}

// Quota response - matches real Z.ai API format
function getQuotaResponse() {
  const warm = isQuotaWarm();

  const tokensLimit = {
    type: "TOKENS_LIMIT",
    unit: 3,
    number: 5,
    percentage: warm ? quotaPercentage : 0,
  };

  if (warm) {
    tokensLimit.nextResetTime = wakeExpiryEpoch;
  }

  return {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: warm ? timeLimitUsage : 0,
        remaining: warm ? 1000 - timeLimitUsage : 1000,
        percentage: warm ? Math.floor(timeLimitUsage / 10) : 0,
        nextResetTime: null,
        usageDetails: warm ? timeLimitDetails : []
      },
      tokensLimit
    ],
    level: "pro"
  };
}

// Chat completion response - simulates wake
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

  requestCount++;
  const warm = isQuotaWarm();
  const statusStr = warm ? `WARM (${formatHMS(getRemainingSeconds())} left)` : 'COLD';
  console.log(`[${new Date().toISOString()}] #${requestCount} ${method} ${path} [${statusStr}]`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route handling
  if (path.includes('/quota/limit') || path.includes('/monitor/usage/quota/limit')) {
    // No random increment — data stays stable until next wake
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: getQuotaResponse(),
      msg: "Operation successful",
      success: true
    }));
    return;
  }

  if (path.includes('/chat/completions')) {
    performWake();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getChatCompletionResponse()));
    return;
  }

  if (path.includes('/wake') || path.includes('/warmup')) {
    performWake();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        message: "Wake successful - quota timer started",
        timestamp: Date.now(),
        expiresAt: wakeExpiryEpoch
      }
    }));
    return;
  }

  if (path.includes('/model-usage')) {
    // Return stable data — same values until next wake
    res.writeHead(200, { 'Content-Type': 'application/json' });

    // Detect 5h vs 24h from startTime query param (simplified)
    const query = parsedUrl.query || {};
    const startTime = query.startTime || '';
    const is24h = !warm || startTime.length === 0;

    // If cold, return zeros; if warm, return stable data
    const calls = warm ? (is24h ? modelCalls24h : modelCalls5h) : 0;
    const tokens = warm ? (is24h ? tokens24h : tokens5h) : 0;

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
    // Return stable data
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: {
        totalUsage: {
          totalNetworkSearchCount: warm ? toolNetworkSearch : 0,
          totalWebReadMcpCount: warm ? toolWebRead : 0,
          totalZreadMcpCount: warm ? toolZread : 0,
          totalSearchMcpCount: warm ? toolSearchMcp : 0
        }
      },
      msg: "Operation successful",
      success: true
    }));
    return;
  }

  // Health check
  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      message: 'Mock server running',
      quota: {
        state: isQuotaWarm() ? 'warm' : 'cold',
        percentage: quotaPercentage,
        remainingSeconds: getRemainingSeconds(),
        remainingHMS: isQuotaWarm() ? formatHMS(getRemainingSeconds()) : null,
        expiresAt: wakeExpiryEpoch
      },
      config: {
        expiryMinutes: config.expiryMinutes
      }
    }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path }));
});

server.listen(config.port, () => {
  console.log(`Mock API server running on http://localhost:${config.port}`);
  console.log('');
  console.log('Configuration:');
  console.log(`  Quota expiry after wake: ${config.expiryMinutes} minutes`);
  console.log('');
  console.log('Behavior:');
  console.log('  - Quota starts COLD (no nextResetTime)');
  console.log('  - POST /chat/completions → WAKE (starts timer, generates stable data)');
  console.log('  - All GET requests return SAME data until next wake or expiry');
  console.log(`  - After ${config.expiryMinutes}min → COLD again (nextResetTime removed)`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /api/monitor/usage/quota/limit     - Quota & timer state');
  console.log('  GET  /api/monitor/usage/model-usage      - Model call/token stats');
  console.log('  GET  /api/monitor/usage/tool-usage       - Tool usage stats');
  console.log('  POST /api/coding/paas/v4/chat/completions - Wake');
  console.log('  GET  /health                             - Health check');
  console.log('');
  console.log('Quota is currently: COLD');
});
