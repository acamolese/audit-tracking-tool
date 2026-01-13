// === REPORT STORE IN-MEMORY ===
class ReportStore {
    constructor(ttl = 3600000) { // 1 ora default
        this.reports = new Map();
        this.ttl = ttl;
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup ogni minuto
    }

    set(id, report) {
        this.reports.set(id, { ...report, _timestamp: Date.now() });
    }

    get(id) {
        const item = this.reports.get(id);
        if (!item) return null;

        // Verifica TTL
        if (Date.now() - item._timestamp > this.ttl) {
            this.reports.delete(id);
            return null;
        }

        return item;
    }

    cleanup() {
        const now = Date.now();
        let removed = 0;
        for (const [id, item] of this.reports) {
            if (now - item._timestamp > this.ttl) {
                this.reports.delete(id);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[ReportStore] Puliti ${removed} report scaduti`);
        }
    }

    dispose() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }
}

module.exports = ReportStore;
