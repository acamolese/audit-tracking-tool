const { parseBody } = require('../middleware/bodyParser');

async function handleReportRoutes(req, res, { reportStore }) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.match(/^\/api\/report\/[^/]+\/form-test$/) && req.method === 'POST') {
        const reportId = url.pathname.split('/')[3];
        const report = reportStore.get(reportId);

        if (!report) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Report non trovato' }));
            return true;
        }

        try {
            const body = await parseBody(req);

            if (!report.events.formTest) {
                report.events.formTest = [];
            }

            const formTestEvents = (body.events || []).map(e => {
                let tracker = 'Form Test';
                let eventName = 'unknown';
                let eventCategory = 'custom';

                if (e.type === 'dataLayer' && e.data?.event) {
                    tracker = 'DataLayer';
                    eventName = e.data.event;
                    if (['form_submit', 'form_start', 'generate_lead', 'purchase'].includes(eventName.toLowerCase())) {
                        eventCategory = 'conversion';
                    }
                } else if (e.type === 'network' && e.data) {
                    tracker = e.data.tracker || 'Network';
                    eventName = e.data.event || 'request';
                    if (['form_submit', 'generate_lead', 'Lead', 'Purchase'].includes(eventName)) {
                        eventCategory = 'conversion';
                    }
                } else if (e.type === 'form_submit') {
                    tracker = 'DOM';
                    eventName = 'form_submit';
                    eventCategory = 'conversion';
                }

                // Handle missing or invalid timestamp
                let timestamp;
                try {
                    timestamp = e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString();
                } catch {
                    timestamp = new Date().toISOString();
                }

                return {
                    tracker,
                    event: eventName,
                    eventCategory,
                    timestamp,
                    phase: 'FORM_TEST',
                    source: 'form_test',
                    rawData: e.data
                };
            });

            report.events.formTest = formTestEvents;
            report.formTest = {
                timestamp: body.timestamp,
                formEventCounts: body.formEventCounts,
                success: body.success,
                totalEvents: formTestEvents.length
            };

            if (report.summary && report.summary.events) {
                report.summary.events.formTest = formTestEvents.length;
                report.summary.events.total = (report.summary.events.total || 0) + formTestEvents.length;

                formTestEvents.forEach(e => {
                    if (!report.summary.events.byTracker[e.tracker]) {
                        report.summary.events.byTracker[e.tracker] = {};
                    }
                    const cat = e.eventCategory || 'custom';
                    if (!report.summary.events.byTracker[e.tracker][cat]) {
                        report.summary.events.byTracker[e.tracker][cat] = [];
                    }
                    const exists = report.summary.events.byTracker[e.tracker][cat].some(ev => ev.name === e.event);
                    if (!exists) {
                        report.summary.events.byTracker[e.tracker][cat].push({ name: e.event });
                    }
                });
            }

            console.log(`Form test salvato per report ${reportId}: ${formTestEvents.length} eventi`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, eventsAdded: formTestEvents.length }));
        } catch (err) {
            console.error('Errore salvataggio form test:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }
    else if (url.pathname.startsWith('/api/report/')) {
        const reportId = url.pathname.split('/').pop();
        const report = reportStore.get(reportId);

        if (report) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, report }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Report non trovato o scaduto' }));
        }
        return true;
    }

    return false;
}

module.exports = { handleReportRoutes };
