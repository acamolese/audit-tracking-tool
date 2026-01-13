const { parseBody } = require('../middleware/bodyParser');
const { runBulkScan } = require('../../core/scanner/BulkScanService');

async function handleBulkRoutes(req, res, { bulkStore, reportStore }) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/bulk-scan' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { urls, mode } = body;

            if (!urls || !Array.isArray(urls) || urls.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Lista URL richiesta' }));
                return true;
            }

            const limitedUrls = urls.slice(0, 50);

            const batch = bulkStore.createBatch(limitedUrls, mode || 'multi-site');
            const batchId = batch.batchId;

            // Verifica se già in esecuzione
            if (bulkStore.isLocked(batchId)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Batch già in esecuzione' }));
                return true;
            }

            bulkStore.lock(batchId);

            console.log(`Bulk scan avviato: ${batchId} con ${limitedUrls.length} URL`);

            // Avvia in background
            runBulkScan(batchId, bulkStore, reportStore);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, batchId, total: limitedUrls.length }));
        } catch (err) {
            console.error('Errore avvio bulk scan:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }
    else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/export$/) && req.method === 'GET') {
        const batchId = url.pathname.split('/')[3];
        const format = url.searchParams.get('format') || 'json';
        const data = bulkStore.getExport(batchId, format);

        if (!data) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
            return true;
        }

        const filename = `bulk-scan-${batchId}-${new Date().toISOString().split('T')[0]}`;

        if (format === 'csv') {
            res.writeHead(200, {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${filename}.csv"`
            });
            res.end(data);
        } else {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="${filename}.json"`
            });
            res.end(JSON.stringify(data, null, 2));
        }
        return true;
    }
    else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/stream$/) && req.method === 'GET') {
        const batchId = url.pathname.split('/')[3];
        const batch = bulkStore.getBatch(batchId);

        if (!batch) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
            return true;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Invia stato iniziale
        res.write(`event: init\ndata: ${JSON.stringify({
            batchId: batch.batchId,
            status: batch.status,
            total: batch.total,
            completed: batch.completed,
            avgScanTime: batch.avgScanTime,
            results: batch.results
        })}\n\n`);

        bulkStore.addSSEClient(batchId, res);
        return true;
    }
    else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+$/) && req.method === 'GET') {
        const batchId = url.pathname.split('/').pop();
        const batch = bulkStore.getBatch(batchId);

        if (!batch) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
            return true;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            batchId: batch.batchId,
            mode: batch.mode,
            status: batch.status,
            total: batch.total,
            completed: batch.completed,
            avgScanTime: batch.avgScanTime,
            summary: batch.summary,
            results: batch.results
        }));
        return true;
    }

    return false;
}

module.exports = { handleBulkRoutes };
