const generateId = require('../utils/idGenerator');

// === BULK SCAN STORE CON SSE ===
class BulkScanStore {
    constructor() {
        this.batches = new Map();
        this.batchLocks = new Set(); // Lock per prevenire race conditions
    }

    createBatch(urls, mode = 'multi-site') {
        const batchId = generateId();
        const batch = {
            batchId,
            mode, // 'multi-site' o 'deep-scan'
            status: 'running',
            total: urls.length,
            completed: 0,
            startTime: Date.now(),
            avgScanTime: null,
            sseClients: [],
            summary: mode === 'deep-scan' ? {
                totalCookies: 0,
                uniqueTrackers: [],
                globalVerdict: 'CONFORME',
                violations: [],
                aggregatedCookies: [],
                lastUpdate: null
            } : null,
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

    calculateDeepScanSummary(batchId, reportStore) {
        const batch = this.batches.get(batchId);
        if (!batch || batch.mode !== 'deep-scan') return null;

        const summary = {
            totalCookies: new Set(),
            uniqueTrackers: new Set(),
            trackerDistribution: {}, // trackerName -> count
            globalVerdict: 'CONFORME',
            violations: [],
            aggregatedCookies: [], // Dettaglio deduplicato
            pagesAnalyzed: 0,
            formsSummary: {
                totalFound: 0,
                pagesWithForms: 0,
                types: {} // formType -> count
            }
        };

        batch.results.forEach(res => {
            if (res.status !== 'completed' || !res.reportId) return;

            summary.pagesAnalyzed++;
            const report = reportStore.get(res.reportId);
            if (!report) return;

            // 1. Aggrega Cookie (Deduplicati per nome e dominio)
            const allCookies = [
                ...(report.preConsent?.cookies || []),
                ...(report.postConsent?.cookies || [])
            ];

            allCookies.forEach(c => {
                const key = `${c.name}|${c.domain}`;
                if (!summary.totalCookies.has(key)) {
                    summary.totalCookies.add(key);
                    summary.aggregatedCookies.push(c);
                }
            });

            // 2. Aggrega Tracker e Distribuzione
            (res.trackers || []).forEach(t => {
                summary.uniqueTrackers.add(t);
                summary.trackerDistribution[t] = (summary.trackerDistribution[t] || 0) + 1;
            });

            // 3. Verdetto Globale (Pessimistico)
            if (res.verdict === 'NON CONFORME') {
                summary.globalVerdict = 'NON CONFORME';
            } else if (res.verdict === 'DA VERIFICARE' && summary.globalVerdict === 'CONFORME') {
                summary.globalVerdict = 'DA VERIFICARE';
            }

            // 4. Aggrega Violazioni (Deduplicate per tipo)
            (report.violations || []).forEach(v => {
                if (!summary.violations.some(sv => sv.type === v.type)) {
                    summary.violations.push(v);
                }
            });

            // 5. Aggrega Form
            const totalFormsOnPage = report.forms?.found?.length || 0;
            if (totalFormsOnPage > 0) {
                summary.formsSummary.totalFound += totalFormsOnPage;
                summary.formsSummary.pagesWithForms++;
                report.forms.found.forEach(f => {
                    const type = f.formType || 'generico';
                    summary.formsSummary.types[type] = (summary.formsSummary.types[type] || 0) + 1;
                });
            }
        });

        batch.summary = {
            ...batch.summary,
            totalCookies: summary.totalCookies.size,
            uniqueTrackers: Array.from(summary.uniqueTrackers),
            trackerDistribution: summary.trackerDistribution,
            globalVerdict: summary.globalVerdict,
            violations: summary.violations,
            aggregatedCookies: summary.aggregatedCookies,
            pagesAnalyzed: summary.pagesAnalyzed,
            formsSummary: summary.formsSummary,
            lastUpdate: Date.now()
        };

        return batch.summary;
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
