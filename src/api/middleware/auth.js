
// Validazione API Key
function validateApiKey(req) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return true; // Se non configurata, accesso libero

    // Permetti richieste dalle pagine web del sito stesso (same-origin)
    const referer = req.headers['referer'] || req.headers['origin'] || '';
    const host = req.headers['host'] || '';

    // Se la richiesta arriva dal sito stesso, permetti senza API key
    if (referer && (referer.includes(host) || referer.includes('localhost') || referer.includes('127.0.0.1'))) {
        return true;
    }

    const providedKey = req.headers['x-api-key'];
    return providedKey === apiKey;
}

// Risposta 401 Unauthorized
function sendUnauthorized(res) {
    res.writeHead(401, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: 'Unauthorized', message: 'Valid API key required in X-API-Key header' }));
}

module.exports = { validateApiKey, sendUnauthorized };
