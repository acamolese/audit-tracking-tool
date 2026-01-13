const { fetchPage, processHtmlForProxy } = require('../../utils/proxyUtils');

async function handleProxyRoutes(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/proxy') {
        const targetUrl = url.searchParams.get('url');

        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('URL richiesto');
            return true;
        }

        try {
            console.log(`Proxy request: ${targetUrl}`);
            const { html, finalUrl } = await fetchPage(targetUrl);
            const modifiedHtml = processHtmlForProxy(html, finalUrl);

            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Frame-Options': 'ALLOWALL',
                'Content-Security-Policy': ''
            });
            res.end(modifiedHtml);
        } catch (err) {
            console.error('Proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Errore proxy: ' + err.message);
        }
        return true;
    }
    return false;
}

module.exports = { handleProxyRoutes };
