const { parseBody } = require('../middleware/bodyParser');
const { CookieAuditScanner } = require('../../core/scanner/Scanner');
const { runBulkScan } = require('../../core/scanner/BulkScanService');
const generateId = require('../../utils/idGenerator');
const { IS_HEADLESS_SERVER, IS_RAILWAY } = require('../../config/config');

async function handleScanRoutes(req, res, { reportStore }) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/scan' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { url: targetUrl, timeout, visible } = body;

            if (!targetUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
                return true;
            }

            console.log(`Avvio scansione: ${targetUrl}`);

            const scanner = new CookieAuditScanner(targetUrl, {
                headless: !visible,
                timeout: timeout || 25000,
                fastMode: body.fastMode !== undefined ? body.fastMode : true,
                skipInteractions: body.skipInteractions !== undefined ? body.skipInteractions : true
            });

            const report = await scanner.run();
            report.scanMode = body.fastMode !== false ? 'fast' : 'full';
            const reportId = generateId();
            reportStore.set(reportId, report);

            console.log(`Scansione completata: ${reportId}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, reportId }));
        } catch (err) {
            console.error('Errore scansione:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }

    // Environment API (related to scan capabilities)
    if (url.pathname === '/api/environment' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            isLocal: !IS_HEADLESS_SERVER,
            isRailway: IS_RAILWAY,
            isHeadlessServer: IS_HEADLESS_SERVER,
            features: {
                liveMonitor: !IS_HEADLESS_SERVER,
                headlessMonitor: true
            }
        }));
        return true;
    }

    return false;
}

module.exports = { handleScanRoutes };
