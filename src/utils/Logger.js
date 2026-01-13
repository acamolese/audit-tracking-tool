// === LOGGER ===
class Logger {
    constructor(verbose = false) {
        this.verbose = verbose;
        this.errors = [];
    }

    log(message, level = 'info') {
        if (!this.verbose && level === 'info') return;

        const icons = {
            info: 'i',
            warn: '!',
            error: 'X',
            success: '+'
        };

        console.log(`[${icons[level] || ' '}] ${message}`);
    }

    error(message, context = {}) {
        this.errors.push({ message, context, timestamp: Date.now() });
        this.log(message, 'error');
    }

    getErrors() {
        return this.errors;
    }
}

module.exports = Logger;
