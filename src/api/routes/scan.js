const { parseBody } = require('../middleware/bodyParser');
const { CookieAuditScanner } = require('../../core/scanner/Scanner');
const { runBulkScan } = require('../../core/scanner/BulkScanService');
const generateId = require('../../utils/idGenerator');
const { IS_HEADLESS_SERVER, IS_RAILWAY } = require('../../config/config');
const EventEmitter = require('events');

async function handleScanRoutes(req, res, { reportStore, activeScans }) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // POST /scan - Start scan and return ID immediately
    if (url.pathname === '/scan' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { url: targetUrl, timeout, visible } = body;

            if (!targetUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
                return true;
            }

            console.log(`Avvio scansione asincrona: ${targetUrl}`);

            const reportId = generateId();
            const eventEmitter = new EventEmitter();

            // Store emitter immediately so client can connect
            activeScans.set(reportId, eventEmitter);

            const onPhase = (phase, label) => {
                eventEmitter.emit('phase', { phase, label });
            };

            const scanner = new CookieAuditScanner(targetUrl, {
                headless: !visible,
                timeout: timeout || 25000,
                fastMode: body.fastMode !== undefined ? body.fastMode : true,
                skipInteractions: body.skipInteractions !== undefined ? body.skipInteractions : true,
                onPhase: onPhase
            });

            // Start scan in background
            scanner.run()
                .then(report => {
                    report.scanMode = body.fastMode !== false ? 'fast' : 'full';
                    reportStore.set(reportId, report);
                    console.log(`Scansione completata: ${reportId}`);
                    eventEmitter.emit('phase', { phase: 'done', label: 'Completato!', reportId });

                    // Keep emitter alive briefly for late subscribers then cleanup
                    setTimeout(() => {
                        activeScans.delete(reportId);
                    }, 10000);
                })
                .catch(err => {
                    console.error('Errore scansione:', err);
                    eventEmitter.emit('error', { error: err.message });
                    activeScans.delete(reportId);
                });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, reportId }));
        } catch (err) {
            console.error('Errore avvio scansione:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }

    // GET /api/scan/:id/events - SSE endpoint
    if (url.pathname.match(/^\/api\/scan\/[^/]+\/events$/) && req.method === 'GET') {
        const reportId = url.pathname.split('/')[3];
        const emitter = activeScans.get(reportId);

        if (!emitter) {
            // Include check if report already exists in store (completed before connect)
            const existingReport = reportStore.get(reportId);
            if (existingReport) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                });
                res.write(`data: ${JSON.stringify({ phase: 'done', label: 'Completato!', reportId })}\n\n`);
                res.end();
                return true;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Scansione non trovata o scaduta' }));
            return true;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        const onPhase = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const onError = (data) => {
            res.write(`data: ${JSON.stringify({ phase: 'error', error: data.error })}\n\n`);
            res.end();
        };

        emitter.on('phase', onPhase);
        emitter.on('error', onError);

        req.on('close', () => {
            emitter.removeListener('phase', onPhase);
            emitter.removeListener('error', onError);
        });

        // Send initial connection message
        res.write(`data: ${JSON.stringify({ phase: 'connected', label: 'Connesso allo stream...' })}\n\n`);
        return true;
    }

    // Environment API
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
