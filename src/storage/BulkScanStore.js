const generateId = require('../utils/idGenerator');

// === BULK SCAN STORE CON SSE ===
class BulkScanStore {
    constructor() {
        this.batches = new Map();
        this.batchLocks = new Set(); // Lock per prevenire race conditions
    }

    createBatch(urls) {
        const batchId = generateId();
        const batch = {
            batchId,
            status: 'running',
            total: urls.length,
            completed: 0,
            startTime: Date.now(),
            avgScanTime: null,
            sseClients: [],
            results: urls.map(u => ({
                url: u,
                status: 'pending',
                phase: null,
                phaseLabel: null,
                startTime: null,
                endTime: null,
                reportId: null,
                verdict: null,
                cmp: null,
                violations: null,
                trackers: [],
                error: null
            }))
        };
        this.batches.set(batchId, batch);
        return batch;
    }

    getBatch(batchId) {
        return this.batches.get(batchId);
    }

    addSSEClient(batchId, client) {
        const batch = this.batches.get(batchId);
        if (!batch) return false;

        batch.sseClients.push(client);

        // Rimuovi client quando si disconnette
        client.on('close', () => {
            const idx = batch.sseClients.indexOf(client);
            if (idx > -1) batch.sseClients.splice(idx, 1);
        });

        return true;
    }

    sendSSE(batchId, eventType, data) {
        const batch = this.batches.get(batchId);
        if (!batch || !batch.sseClients.length) return;

        const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

        batch.sseClients = batch.sseClients.filter(client => {
            try {
                client.write(message);
                return true;
            } catch (e) {
                return false;
            }
        });
    }

    updatePhase(batchId, index, phase, phaseLabel) {
        const batch = this.batches.get(batchId);
        if (!batch) return;

        const result = batch.results[index];
        result.phase = phase;
        result.phaseLabel = phaseLabel;

        this.sendSSE(batchId, 'phase', {
            index,
            url: result.url,
            phase,
            phaseLabel,
            completed: batch.completed,
            total: batch.total
        });
    }

    completeScan(batchId, index, resultData) {
        const batch = this.batches.get(batchId);
        if (!batch) return;

        const result = batch.results[index];
        Object.assign(result, resultData);
        result.endTime = Date.now();
        batch.completed++;

        // Calcola media tempo
        const scanTime = result.endTime - result.startTime;
        if (!batch.avgScanTime) {
            batch.avgScanTime = scanTime;
        } else {
            batch.avgScanTime = (batch.avgScanTime + scanTime) / 2;
        }

        this.sendSSE(batchId, 'complete', {
            index,
            result,
            completed: batch.completed,
            total: batch.total,
            avgScanTime: Math.round(batch.avgScanTime)
        });

        // Verifica se tutto completato
        if (batch.completed >= batch.total) {
            batch.status = 'completed';
            batch.endTime = Date.now();
            this.sendSSE(batchId, 'done', {
                batchId,
                totalTime: batch.endTime - batch.startTime,
                avgScanTime: Math.round(batch.avgScanTime)
            });
        }
    }

    errorScan(batchId, index, error) {
        const batch = this.batches.get(batchId);
        if (!batch) return;

        const result = batch.results[index];
        result.status = 'error';
        result.error = error;
        result.endTime = Date.now();
        batch.completed++;

        this.sendSSE(batchId, 'error', {
            index,
            url: result.url,
            error,
            completed: batch.completed,
            total: batch.total
        });

        if (batch.completed >= batch.total) {
            batch.status = 'completed';
            batch.endTime = Date.now();
        }
    }

    isLocked(batchId) {
        return this.batchLocks.has(batchId);
    }

    lock(batchId) {
        this.batchLocks.add(batchId);
    }

    unlock(batchId) {
        this.batchLocks.delete(batchId);
    }

    getExport(batchId, format) {
        const batch = this.batches.get(batchId);
        if (!batch) return null;

        if (format === 'csv') {
            const headers = ['#', 'URL', 'Status', 'Verdetto', 'CMP', 'Violazioni', 'Tracker'];
            const rows = batch.results.map((r, i) => [
                i + 1,
                `"${r.url}"`,
                r.status,
                r.verdict || '',
                r.cmp || '',
                r.violations !== null ? r.violations : '',
                `"${(r.trackers || []).join(', ')}"`
            ]);

            return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        }

        return batch;
    }
}

module.exports = BulkScanStore;
