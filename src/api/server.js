const http = require('http');
const { router } = require('./router');
const ReportStore = require('../storage/ReportStore');
const BulkScanStore = require('../storage/BulkScanStore');

// Global Stores
const reportStore = new ReportStore();
const bulkStore = new BulkScanStore();
const formTestSessions = new Map();
const headlessFormTestSessions = new Map();

const PORT = process.env.PORT || 3000;

// Context passed to routes
const context = {
    reportStore,
    bulkStore,
    formTestSessions,
    headlessFormTestSessions,
    activeScans: new Map() // Store active scan emitters
};

// === GRACEFUL SHUTDOWN ===
function setupGracefulShutdown(server) {
    const shutdown = async (signal) => {
        console.log(`\n${signal} ricevuto, shutdown in corso...`);

        // Chiudi server
        server.close(() => {
            console.log('Server chiuso');
        });

        // Cleanup stores
        if (reportStore) reportStore.dispose();
        if (bulkStore) {
            // Chiudi tutte le connessioni SSE
            for (const batch of bulkStore.batches.values()) {
                batch.sseClients.forEach(client => {
                    try {
                        client.end();
                    } catch (e) { }
                });
            }
        }

        // Cleanup sessions
        for (const session of formTestSessions.values()) {
            try { await session.stop(); } catch (e) { }
        }
        for (const session of headlessFormTestSessions.values()) {
            try { await session.stop(); } catch (e) { }
        }

        // Attendi 5 secondi per operazioni in corso
        setTimeout(() => {
            console.log('Shutdown completato');
            process.exit(0);
        }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        shutdown('UNCAUGHT_EXCEPTION');
    });
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
        shutdown('UNHANDLED_REJECTION');
    });
}

function startServer() {
    const server = http.createServer(async (req, res) => {
        try {
            await router(req, res, context);
        } catch (err) {
            console.error('Initial request error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
            }
        }
    });

    setupGracefulShutdown(server);

    server.listen(PORT, () => {
        console.log(`\n=== AUDIT TRACKING TOOL SERVER ===`);
        console.log(`Server avviato: http://localhost:${PORT}`);
        console.log(`Timestamp: ${new Date().toISOString()}`);
        console.log(`Report TTL: 1 ora`);
        console.log(`Rate Limit: RIMOSSO (nessun limite)`);
        console.log(`Max Bulk URLs: 50`);
        console.log(`=================================\n`);
    });

    return { server, reportStore, bulkStore };
}

module.exports = { startServer };
