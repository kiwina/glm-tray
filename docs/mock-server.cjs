#!/usr/bin/env node
/**
 * Mock API server for development/testing
 * Simulates the z.ai API responses for quota and wake endpoints
 *
 * Usage: node mock-server.cjs [options]
 * Options:
 *   --port=PORT       Server port (default: 3456)
 *   --expiry=MINUTES  Quota expiry time after wake in minutes (default: 2 for testing)
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
    expiryMinutes: parseFloat(process.env.MOCK_EXPIRY || '2'),  // Default 2 minutes after wake
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

// Simulated state
let quotaPercentage = Math.floor(Math.random() * 30) + 10;
let requestCount = 0;

// Wake state - tracks when quota was last woken
// null = not woken yet (cold), timestamp = woken at this time
let wakeTimeEpoch = null;
let wakeExpiryEpoch = null;

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Check if quota is currently "warm" (has been woken and not expired)
function isQuotaWarm() {
  if (wakeExpiryEpoch === null) {
    return false;
  }
  return Date.now() < wakeExpiryEpoch;
}

// Get remaining seconds until quota expires (only valid if warm)
function getRemainingSeconds() {
  if (wakeExpiryEpoch === null) {
    return 0;
  }
  return Math.max(0, Math.floor((wakeExpiryEpoch - Date.now()) / 1000));
}

// Wake the quota - start the timer
function performWake() {
  wakeTimeEpoch = Date.now();
  wakeExpiryEpoch = wakeTimeEpoch + config.expiryMinutes * 60 * 1000;
  quotaPercentage = Math.floor(Math.random() * 20) + 5;  // Reset percentage on wake
  console.log(`[${new Date().toISOString()}] WAKE! Quota timer started, expires in ${config.expiryMinutes} minutes`);
}

// Quota response - matches real Z.ai API format exactly
function getQuotaResponse() {
  const warm = isQuotaWarm();

  // TOKENS_LIMIT only has nextResetTime if quota is warm
  const tokensLimit = {
    type: "TOKENS_LIMIT",
    unit: 3,
    number: 5,
    percentage: quotaPercentage,
  };

  // Only include nextResetTime if quota is warm
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
        currentValue: Math.floor(quotaPercentage * 3),
        remaining: 1000 - Math.floor(quotaPercentage * 3),
        percentage: Math.floor(quotaPercentage * 0.3),
        nextResetTime: null,
        usageDetails: [
          { modelCode: "search-prime", usage: Math.floor(Math.random() * 10) },
          { modelCode: "web-reader", usage: Math.floor(Math.random() * 5) },
          { modelCode: "zread", usage: Math.floor(Math.random() * 20) }
        ]
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
  const statusStr = warm ? `WARM (${formatHMS(getRemainingSeconds())} remaining)` : 'COLD (needs wake)';
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
    // Simulate percentage increasing over time (rolling) only if warm
    if (isQuotaWarm()) {
      quotaPercentage = Math.min(99, quotaPercentage + (Math.random() * 3) + 1);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getQuotaResponse()));
    return;
  }

  if (path.includes('/chat/completions')) {
    // Wake the quota!
    performWake();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getChatCompletionResponse()));
    return;
  }

  if (path.includes('/wake') || path.includes('/warmup')) {
    // Alternative wake endpoint
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: {
        total_usage: {
          totalModelCallCount: Math.floor(Math.random() * 500) + 100,
          totalTokensUsage: Math.floor(Math.random() * 15000000) + 5000000
        }
      }
    }));
    return;
  }

  if (path.includes('/tool-usage')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: {
        total_usage: {
          totalNetworkSearchCount: Math.floor(Math.random() * 50) + 10,
          totalWebReadMcpCount: Math.floor(Math.random() * 30) + 5,
          totalZreadMcpCount: Math.floor(Math.random() * 100) + 20,
          totalSearchMcpCount: Math.floor(Math.random() * 40) + 8
        }
      }
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
        percentage: Math.round(quotaPercentage * 10) / 10,
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
  console.log('  - TOKENS_LIMIT has NO nextResetTime initially (quota is COLD)');
  console.log('  - Call /chat/completions to WAKE the quota');
  console.log('  - After wake, TOKENS_LIMIT has nextResetTime (quota is WARM)');
  console.log('  - After expiry, nextResetTime is removed (quota is COLD again)');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET/POST /api/monitor/usage/quota/limit - Quota info');
  console.log('  POST    /api/coding/paas/v4/chat/completions - Wake (activates quota)');
  console.log('  GET     /health - Health check with current quota state');
  console.log('');
  console.log('Quota is currently: COLD (call /chat/completions to wake)');
});
