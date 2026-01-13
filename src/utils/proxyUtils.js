const http = require('http');
const https = require('https');
const { URL } = require('url');
const MONITOR_SCRIPT = require('../core/session/monitorScript');

// Fetch di una pagina esterna
async function fetchPage(targetUrl) {
    return new Promise((resolve, reject) => {
        const protocol = targetUrl.startsWith('https') ? https : http;

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
            }
        };

        const request = protocol.get(targetUrl, options, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const baseUrl = new URL(targetUrl);
                    redirectUrl = baseUrl.origin + redirectUrl;
                }
                return fetchPage(redirectUrl).then(resolve).catch(reject);
            }

            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => data += chunk);
            response.on('end', () => resolve({ html: data, finalUrl: targetUrl }));
        });

        request.on('error', reject);
        request.setTimeout(10000, () => {
            request.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// Modifica HTML per il proxy
function processHtmlForProxy(html, baseUrl) {
    const baseUrlObj = new URL(baseUrl);
    const baseOrigin = baseUrlObj.origin;
    const basePath = baseUrlObj.pathname.replace(/[^/]*$/, '');

    const baseTag = `<base href="${baseOrigin}${basePath}">`;
    let modifiedHtml = html;

    if (modifiedHtml.includes('<head>')) {
        modifiedHtml = modifiedHtml.replace('<head>', '<head>' + baseTag + MONITOR_SCRIPT);
    } else if (modifiedHtml.includes('<html>')) {
        modifiedHtml = modifiedHtml.replace('<html>', '<html><head>' + baseTag + MONITOR_SCRIPT + '</head>');
    } else {
        modifiedHtml = baseTag + MONITOR_SCRIPT + modifiedHtml;
    }

    return modifiedHtml;
}

module.exports = { fetchPage, processHtmlForProxy };
