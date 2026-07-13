const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separator = trimmed.indexOf('=');
    if (separator === -1) return;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnv();

const PORT = Number(process.env.PORT) || 3000;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]\n', 'utf8');
}

function readOrders() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  ensureStore();
  fs.writeFileSync(ORDERS_FILE, `${JSON.stringify(orders, null, 2)}\n`, 'utf8');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => ({
      id: cleanText(item.id, 100),
      name: cleanText(item.name, 120),
      category: cleanText(item.category, 80),
      price: Math.max(0, Number(item.price) || 0),
      qty: Math.max(1, Math.min(99, Number(item.qty) || 1))
    }))
    .filter(item => item.name && item.price > 0);
}

function orderTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString('ru-RU')} тг`;
}

function formatOrderMessage(order) {
  const lines = [
    'BRILLIANT MENU',
    `Жаңа заказ #${order.id}`,
    '',
    `Столик: ${order.table}`,
    `Уақыт: ${new Date(order.createdAt).toLocaleString('ru-RU')}`,
    '',
    'Тапсырыс:'
  ];

  order.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.name}`);
    lines.push(`   ${item.category} | ${item.qty} x ${formatMoney(item.price)} = ${formatMoney(item.price * item.qty)}`);
  });

  lines.push('');
  lines.push(`Итого: ${formatMoney(order.total)}`);
  return lines.join('\n');
}

function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return Promise.resolve({
      sent: false,
      error: 'Telegram бапталмаған: .env ішіне TELEGRAM_BOT_TOKEN және TELEGRAM_CHAT_ID жазыңыз.'
    });
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text
  });

  return new Promise(resolve => {
    const request = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ sent: true });
          return;
        }

        let error = `Telegram қатесі: HTTP ${response.statusCode}`;
        try {
          const data = JSON.parse(body);
          if (data.description) error = data.description;
        } catch {
          // Keep the generic HTTP message.
        }
        resolve({ sent: false, error });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Telegram timeout'));
    });

    request.on('error', error => {
      resolve({ sent: false, error: error.message || 'Telegram request failed' });
    });

    request.write(payload);
    request.end();
  });
}

function sendTelegramOrder(order) {
  return sendTelegramMessage(formatOrderMessage(order));
}

function createOrder(payload) {
  const items = normalizeItems(payload.items);
  const table = cleanText(payload.table, 40);

  if (!table) {
    const error = new Error('Table number is required');
    error.statusCode = 400;
    throw error;
  }

  if (!items.length) {
    const error = new Error('Order items are required');
    error.statusCode = 400;
    throw error;
  }

  return {
    id: Date.now().toString(36).toUpperCase(),
    table,
    items,
    total: orderTotal(items),
    status: 'new',
    createdAt: new Date().toISOString()
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/orders') {
    sendJson(res, 200, { orders: readOrders() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    try {
      const payload = await readBody(req);
      const order = createOrder(payload);
      const orders = readOrders();
      orders.unshift(order);
      writeOrders(orders);
      const telegram = await sendTelegramOrder(order);
      sendJson(res, 201, { order, telegram });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || 'Bad request' });
    }
    return true;
  }

  const match = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (!match) return false;

  const id = decodeURIComponent(match[1]);

  if (req.method === 'PATCH') {
    try {
      const payload = await readBody(req);
      const allowed = new Set(['new', 'preparing', 'done', 'canceled']);
      const status = cleanText(payload.status, 20);
      if (!allowed.has(status)) throw new Error('Invalid status');

      const orders = readOrders();
      const order = orders.find(item => item.id === id);
      if (!order) {
        sendJson(res, 404, { error: 'Order not found' });
        return true;
      }

      order.status = status;
      order.updatedAt = new Date().toISOString();
      writeOrders(orders);
      sendJson(res, 200, { order });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Bad request' });
    }
    return true;
  }

  if (req.method === 'DELETE') {
    const orders = readOrders();
    const nextOrders = orders.filter(item => item.id !== id);
    writeOrders(nextOrders);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

function serveStatic(req, res, pathname) {
  const fallbackPath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(fallbackPath);
  const filePath = path.resolve(ROOT, `.${decodedPath}`);
  const relativePath = path.relative(ROOT, filePath);

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).some(part => part.startsWith('.') || part === 'data')
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, pathname);
    if (handled) return;
  }

  serveStatic(req, res, pathname);
});

ensureStore();
server.listen(PORT, () => {
  console.log(`Brilliant Menu server: http://127.0.0.1:${PORT}`);
  console.log('Telegram orders: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
});
