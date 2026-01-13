
// Parse del body JSON con timeout
async function parseBody(req, maxBytes = 1048576) { // 1MB max
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;

        req.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                req.destroy();
                reject(new Error('Body too large'));
                return;
            }
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                resolve({});
            }
        });

        req.on('error', reject);

        // Timeout 10 secondi
        setTimeout(() => {
            req.destroy();
            reject(new Error('Parse timeout'));
        }, 10000);
    });
}

module.exports = { parseBody };
