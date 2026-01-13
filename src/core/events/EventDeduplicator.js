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
        // Special handling for Session Recording tools (Clarity, Hotjar)
        // These send constant heartbeats that flood the report.
        if (['Clarity', 'Hotjar'].includes(details.tracker) &&
            ['Recording', 'Heatmap', 'Heartbeat'].includes(details.event)) {

            // Generate a generic signature that ignores params for these tools
            const genericSig = `${details.tracker}:${details.event}:${details.phase}`;

            // Check if we've seen this generic event recently (e.g., last 60 seconds)
            const lastTime = this.events.get(genericSig);

            // Update timestamp
            this.events.set(genericSig, timestamp);

            // If seen within last 60s, consider it a duplicate (throttling)
            if (lastTime && (timestamp - lastTime < 60000)) {
                return true;
            }
            return false;
        }

        // Standard deduplication for other events
        const signature = this.generateKey(details);

        // Per eventi 'set' e 'consent', non deduplicare se sono separati da più di 1 secondo
        if (details.event === 'set' || details.event === 'consent') {
            const lastTime = this.events.get(signature);
            if (lastTime && (timestamp - lastTime) < 1000) {
                return true; // Troppo vicini, probabilmente duplicato
            }
        }

        // Per altri eventi, deduplicazione standard
        if (this.events.has(signature)) {
            return true;
        }

        this.events.set(signature, timestamp);
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
