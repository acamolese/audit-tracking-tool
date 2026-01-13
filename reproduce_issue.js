const { CookieAuditScanner } = require('./src/core/scanner/Scanner');
const fs = require('fs');
const path = require('path');

(async () => {
    console.log("Starting reproduction scan for adhoccasa.it...");
    const scanner = new CookieAuditScanner(
        'https://www.adhoccasa.it',
        {
            maxScrolls: 0, // quick scan
            phases: ['pre-consent'] // focus on pre-consent
        }
    );

    try {
        const report = await scanner.run();
        const simplifiedReport = {
            url: report.url,
            events: {
                preConsent: report.events.preConsent.filter(e => e.tracker.includes('Google') || e.tracker.includes('GA4')),
                postConsent: report.events.postConsent.filter(e => e.tracker.includes('Google') || e.tracker.includes('GA4'))
            }
        };

        console.log("Scan complete. Filtering for Google events pre-consent:");
        console.log(JSON.stringify(simplifiedReport.events, null, 2));

        // Save for inspection
        fs.writeFileSync('adhoc_debug_report.json', JSON.stringify(simplifiedReport, null, 2));
        console.log("Report saved to adhoc_debug_report.json");

    } catch (error) {
        console.error("Scan failed:", error);
    }
})();
