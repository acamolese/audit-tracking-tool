const { handleStaticRoutes } = require('./routes/static');
const { handleScanRoutes } = require('./routes/scan');
const { handleReportRoutes } = require('./routes/report');
const { handleBulkRoutes } = require('./routes/bulk');
const { handleProxyRoutes } = require('./routes/proxy');
const { handleSessionRoutes } = require('./routes/session');
const { validateApiKey, sendUnauthorized } = require('./middleware/auth');

async function router(req, res, context) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // API Key Check
    const protectedPaths = ['/api/', '/scan', '/proxy'];
    const needsAuth = protectedPaths.some(p => url.pathname.startsWith(p) || url.pathname === p);

    if (needsAuth && !validateApiKey(req)) {
        return sendUnauthorized(res);
    }

    // Route Dispatching
    // Try each handler. If returns true, request is handled.
    if (handleStaticRoutes(req, res)) return;
    if (await handleScanRoutes(req, res, context)) return;
    if (await handleReportRoutes(req, res, context)) return;
    if (await handleBulkRoutes(req, res, context)) return;
    if (await handleProxyRoutes(req, res)) return;
    if (await handleSessionRoutes(req, res, context)) return; // Pass entire context including session maps

    // 404 Fallback
    res.writeHead(404);
    res.end('Not found');
}

module.exports = { router };
