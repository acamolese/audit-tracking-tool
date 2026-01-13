// === EVENT DEDUPLICATOR MIGLIORATO ===
class EventDeduplicator {
    constructor(ttl = 5000) {
        this.events = new Map();
        this.ttl = ttl;
        this.cleanupInterval = setInterval(() => this.cleanup(), 1000);
    }

    // Genera chiave intelligente per deduplicazione
    generateKey(details) {
        const tracker = details.tracker || 'unknown';
        const event = details.event || 'unknown';
        const phase = details.phase || 'unknown';

        // Per eventi dataLayer come 'set' e 'consent', includi i parametri principali
        if (details.params && typeof details.params === 'object') {
            const params = JSON.stringify(details.params);
            const paramsHash = params.split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0);
            return `${tracker}|${event}|${phase}|${paramsHash}`;
        }

        // Per eventi normali, usa tracker + evento + fase
        return `${tracker}|${event}|${phase}`;
    }

    isDuplicate(details, timestamp) {
        const key = this.generateKey(details);

        // Per eventi 'set' e 'consent', non deduplicare se sono separati da più di 1 secondo
        if (details.event === 'set' || details.event === 'consent') {
            const lastTime = this.events.get(key);
            if (lastTime && (timestamp - lastTime) < 1000) {
                return true; // Troppo vicini, probabilmente duplicato
            }
        }

        // Per altri eventi, deduplicazione standard
        if (this.events.has(key)) {
            return true;
        }

        this.events.set(key, timestamp);
        return false;
    }

    cleanup() {
        const now = Date.now();
        for (const [key, timestamp] of this.events) {
            if (now - timestamp > this.ttl) {
                this.events.delete(key);
            }
        }
    }

    dispose() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }
}

module.exports = EventDeduplicator;
