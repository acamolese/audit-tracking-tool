const path = require('path');
const { serveStatic } = require('../../utils/fileUtils');

const PUBLIC_DIR = path.join(__dirname, '../../../'); // Root directory where .html files are

function handleStaticRoutes(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
        serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
        return true;
    }
    else if (pathname === '/report.html') {
        serveStatic(res, path.join(PUBLIC_DIR, 'report.html'));
        return true;
    }
    else if (pathname === '/form-test.html') {
        serveStatic(res, path.join(PUBLIC_DIR, 'form-test.html'));
        return true;
    }
    else if (pathname === '/bulk-scan.html') {
        serveStatic(res, path.join(PUBLIC_DIR, 'bulk-scan.html'));
        return true;
    }
    else if (pathname === '/favicon.ico') {
        res.writeHead(204); // No Content
        res.end();
        return true;
    }

    return false;
}

module.exports = { handleStaticRoutes };
