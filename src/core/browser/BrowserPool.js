const { chromium } = require('playwright');

// === BROWSER POOL MANAGER ===
class BrowserPool {
    constructor(maxSize = 7) {
        this.maxSize = maxSize;
        this.pool = [];
        this.waiting = [];
        this.inUse = new Set();
    }

    async acquire() {
        // Cerca browser disponibile nel pool
        const available = this.pool.find(b => !this.inUse.has(b));
        if (available) {
            this.inUse.add(available);
            return available;
        }

        // Crea nuovo browser se possibile
        if (this.pool.length < this.maxSize) {
            const browser = await this._createBrowser();
            this.pool.push(browser);
            this.inUse.add(browser);
            return browser;
        }

        // Attendi disponibilità
        return new Promise((resolve) => {
            this.waiting.push(resolve);
        });
    }

    async release(browser) {
        this.inUse.delete(browser);

        if (this.waiting.length > 0) {
            const next = this.waiting.shift();
            this.inUse.add(browser);
            next(browser);
        }
    }

    async _createBrowser() {
        return await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
    }

    async dispose() {
        for (const browser of this.pool) {
            try {
                await browser.close();
            } catch (e) {
                console.error('Error closing browser:', e);
            }
        }
        this.pool = [];
        this.inUse.clear();
        this.waiting = [];
    }
}

module.exports = BrowserPool;
