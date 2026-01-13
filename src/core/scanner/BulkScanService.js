const { CookieAuditScanner } = require('../scanner/Scanner');
const generateId = require('../../utils/idGenerator');

// Esegue bulk scan con concorrenza limitata
async function runBulkScan(batchId, bulkStore, reportStore) {
    const batch = bulkStore.getBatch(batchId);
    if (!batch) return;

    const CONCURRENCY = 3;
    let running = 0;
    let index = 0;

    function next() {
        while (running < CONCURRENCY && index < batch.results.length) {
            const i = index++;
            const result = batch.results[i];

            running++;
            result.status = 'running';
            result.startTime = Date.now();

            console.log(`[Bulk ${batchId}] Scansione ${i + 1}/${batch.total}: ${result.url}`);

            bulkStore.updatePhase(batchId, i, 'starting', 'Avvio...');

            scanSingleUrlWithPhases(batchId, i, result, bulkStore, reportStore)
                .then(() => {
                    result.status = 'completed';
                    bulkStore.completeScan(batchId, i, {
                        reportId: result.reportId,
                        cmp: result.cmp,
                        violations: result.violations,
                        verdict: result.verdict,
                        trackers: result.trackers,
                        totalCookies: result.totalCookies
                    });
                })
                .catch(err => {
                    bulkStore.errorScan(batchId, i, err.message);
                })
                .finally(() => {
                    running--;
                    next();
                });
        }

        if (running === 0 && batch.completed >= batch.total) {
            if (batch.mode === 'deep-scan') {
                console.log(`[Bulk ${batchId}] Generazione report riassuntivo per Deep Scan...`);
                bulkStore.calculateDeepScanSummary(batchId, reportStore);
            }
            bulkStore.unlock(batchId);
        }
    }

    next();
}

// Scansiona singolo URL con aggiornamento fasi
async function scanSingleUrlWithPhases(batchId, index, result, bulkStore, reportStore) {
    const onPhase = (phase, label) => {
        bulkStore.updatePhase(batchId, index, phase, label);
    };

    onPhase('loading', 'Caricamento pagina...');

    const scanner = new CookieAuditScanner(result.url, {
        headless: true,
        timeout: 10000,
        onPhase: onPhase,
        verbose: false
    });

    const report = await scanner.run();
    report.scanMode = 'full'; // Bulk scan sempre in modalità completa
    const reportId = generateId();
    reportStore.set(reportId, report);

    result.reportId = reportId;
    result.cmp = report.cmp?.type || null;
    result.violations = report.violations?.length || 0;
    result.totalCookies = (report.preConsent?.cookies?.length || 0) + (report.postConsent?.cookies?.length || 0);

    if (result.violations > 0) {
        result.verdict = 'NON CONFORME';
    } else if (report.cmp?.detected) {
        result.verdict = 'CONFORME';
    } else {
        result.verdict = 'DA VERIFICARE';
    }

    const trackers = new Set();
    if (report.summary?.events?.byTracker) {
        Object.keys(report.summary.events.byTracker).forEach(t => {
            if (t.includes('GA4') || t.includes('Google Analytics')) trackers.add('GA4');
            else if (t.includes('Facebook') || t.includes('Meta')) trackers.add('Facebook');
            else if (t.includes('LinkedIn')) trackers.add('LinkedIn');
            else if (t.includes('TikTok')) trackers.add('TikTok');
            else if (t.includes('Hotjar')) trackers.add('Hotjar');
            else if (t.includes('Google Ads')) trackers.add('Google Ads');
            else if (!t.includes('GTM') && !t.includes('Cookiebot') && !t.includes('OneTrust') && !t.includes('iubenda')) {
                trackers.add(t);
            }
        });
    }
    result.trackers = Array.from(trackers);
}

module.exports = { runBulkScan };
