const { parseBody } = require('../middleware/bodyParser');
const FormTestSession = require('../../core/session/FormTestSession');
const HeadlessFormTestSession = require('../../core/session/HeadlessFormTestSession');
const generateId = require('../../utils/idGenerator');

async function handleSessionRoutes(req, res, { formTestSessions, headlessFormTestSessions }) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // === HEADLESS FORM TEST API (per Railway) ===
    if (url.pathname === '/api/form-test-headless/start' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const targetUrl = body.url;

            if (!targetUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
                return true;
            }

            const sessionId = generateId();
            const session = new HeadlessFormTestSession(targetUrl, sessionId);
            headlessFormTestSessions.set(sessionId, session);

            // Avvia sessione
            const started = await session.start();

            if (!started) {
                headlessFormTestSessions.delete(sessionId);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Errore avvio sessione' }));
                return true;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, sessionId, mode: 'headless' }));
        } catch (err) {
            console.error('Errore avvio form-test-headless:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }
    else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/events$/) && req.method === 'GET') {
        const sessionId = url.pathname.split('/')[3];
        const session = headlessFormTestSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
            return true;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        res.write(`data: ${JSON.stringify({ type: 'connected', sessionId, mode: 'headless' })}\n\n`);
        session.addSSEClient(res);
        return true;
    }
    else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/action$/) && req.method === 'POST') {
        const sessionId = url.pathname.split('/')[3];
        const session = headlessFormTestSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
            return true;
        }

        try {
            const body = await parseBody(req);
            const { action, params } = body;

            if (!action) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Azione richiesta' }));
                return true;
            }

            const result = await session.executeAction(action, params || {});

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }
    else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/stop$/) && req.method === 'POST') {
        const sessionId = url.pathname.split('/')[3];
        const session = headlessFormTestSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
            return true;
        }

        await session.stop();
        headlessFormTestSessions.delete(sessionId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return true;
    }

    // === FORM TEST LIVE API (locale) ===
    else if (url.pathname === '/api/form-test/start' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const targetUrl = body.url;

            if (!targetUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
                return true;
            }

            const sessionId = generateId();
            const session = new FormTestSession(targetUrl, sessionId);
            formTestSessions.set(sessionId, session);

            // Avvia in background
            session.start().catch(err => {
                console.error(`[FormTest] Errore sessione ${sessionId}:`, err);
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, sessionId }));
        } catch (err) {
            console.error('Errore avvio form-test:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return true;
    }
    else if (url.pathname.match(/^\/api\/form-test\/[^/]+\/events$/) && req.method === 'GET') {
        // SSE endpoint per streaming eventi
        const sessionId = url.pathname.split('/')[3];
        const session = formTestSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
            return true;
        }

        // Setup SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
        session.addSSEClient(res);
        return true;
    }
    else if (url.pathname.match(/^\/api\/form-test\/[^/]+\/stop$/) && req.method === 'POST') {
        const sessionId = url.pathname.split('/')[3];
        const session = formTestSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
            return true;
        }

        await session.stop();
        formTestSessions.delete(sessionId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return true;
    }

    return false;
}

module.exports = { handleSessionRoutes };
