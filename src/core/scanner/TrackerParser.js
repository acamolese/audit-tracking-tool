const {
    TRACKER_PATTERNS,
    GOOGLE_CONSENT_PATTERNS,
    GA4_STANDARD_EVENTS,
    GA4_PHONE_EVENTS
} = require('../../config/constants');

class TrackerParser {
    constructor(logger) {
        this.logger = logger;
    }

    // Identifica il tracker dalla URL
    identifyTracker(url) {
        for (const [name, pattern] of Object.entries(TRACKER_PATTERNS)) {
            if (pattern.test(url)) {
                return name;
            }
        }
        return null;
    }

    // Estrae dettagli aggiuntivi dalla richiesta
    extractRequestDetails(url, trackerName, postData = null) {
        const details = { tracker: trackerName, url: url };

        try {
            const urlObj = new URL(url);

            // Facebook Pixel
            if (trackerName === 'Facebook Pixel') {
                const eventName = urlObj.searchParams.get('ev');
                if (eventName) {
                    details.event = eventName;
                    const fbStandardEvents = ['PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration', 'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'Schedule', 'StartTrial', 'SubmitApplication', 'Subscribe'];
                    details.eventCategory = fbStandardEvents.includes(eventName) ? 'standard' : 'custom';
                }
                const pixelId = urlObj.searchParams.get('id');
                if (pixelId) details.pixelId = pixelId;
                const dl = urlObj.searchParams.get('dl');
                if (dl) details.destinationUrl = decodeURIComponent(dl);
                const cd = urlObj.searchParams.get('cd');
                if (cd) {
                    try {
                        details.customData = JSON.parse(decodeURIComponent(cd));
                    } catch (e) { }
                }
            }

            // LinkedIn Insight
            if (trackerName === 'LinkedIn Insight') {
                const eventName = urlObj.searchParams.get('event') || urlObj.searchParams.get('conversionId');
                if (eventName) {
                    details.event = eventName;
                    details.eventCategory = 'conversion';
                } else {
                    details.event = 'PageView';
                    details.eventCategory = 'standard';
                }
            }

            // TikTok Pixel
            if (trackerName === 'TikTok Pixel') {
                const eventName = urlObj.searchParams.get('event');
                if (eventName) {
                    details.event = eventName;
                    const ttStandardEvents = ['ViewContent', 'ClickButton', 'Search', 'AddToWishlist', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'CompletePayment', 'PlaceAnOrder', 'Contact', 'Download', 'SubmitForm', 'Subscribe'];
                    details.eventCategory = ttStandardEvents.includes(eventName) ? 'standard' : 'custom';
                }
            }

            // Pinterest
            if (trackerName === 'Pinterest') {
                const eventName = urlObj.searchParams.get('event') || urlObj.searchParams.get('ed');
                if (eventName) {
                    details.event = eventName;
                    details.eventCategory = 'custom';
                }
            }

            // Twitter/X
            if (trackerName === 'Twitter/X') {
                const eventName = urlObj.searchParams.get('event') || urlObj.searchParams.get('txn_id');
                if (eventName) {
                    details.event = eventName;
                    details.eventCategory = 'conversion';
                } else {
                    details.event = 'PageView';
                    details.eventCategory = 'standard';
                }
            }

            // Hotjar
            if (trackerName === 'Hotjar') {
                details.event = 'Recording';
                details.eventCategory = 'session';
            }

            // Clarity
            if (trackerName === 'Clarity') {
                details.event = 'Recording';
                details.eventCategory = 'session';
            }

            // Google: estrai consent state
            if (trackerName?.startsWith('GA') || trackerName?.startsWith('Google')) {
                const gcs = urlObj.searchParams.get('gcs');
                if (gcs) {
                    details.gcsRaw = gcs;
                    details.consentMode = GOOGLE_CONSENT_PATTERNS.gcs[gcs] || gcs;
                }
                const gcd = urlObj.searchParams.get('gcd');
                if (gcd) details.gcd = gcd;
            }

            // GA4: estrai evento e parametri
            if (trackerName === 'GA4') {
                let en = urlObj.searchParams.get('en');
                const bodyEvents = postData ? this.parseGA4PostBody(postData) : [];

                if (bodyEvents.length > 0) {
                    details.events = bodyEvents;
                    if (!en) en = bodyEvents[0];
                    // Se en è presente nel URL ma diverso dai bodyEvents, lo aggiungiamo?
                    // Di solito se c'è un batch, en nel URL è il primo o manca.
                    if (en && !bodyEvents.includes(en)) {
                        details.events.unshift(en);
                    }
                }

                if (en) {
                    details.event = en;
                    details.isStandardEvent = GA4_STANDARD_EVENTS.includes(en) || GA4_PHONE_EVENTS.includes(en);
                    if (GA4_STANDARD_EVENTS.includes(en)) {
                        details.eventCategory = 'standard';
                    } else if (GA4_PHONE_EVENTS.includes(en) || en.startsWith('click_') || en.startsWith('cta_')) {
                        details.eventCategory = 'click';
                    } else {
                        details.eventCategory = 'custom';
                    }
                }

                // Parametri evento
                const eventParams = {};
                for (const [key, value] of urlObj.searchParams) {
                    if (key.startsWith('ep.')) {
                        eventParams[key.replace('ep.', '')] = value;
                    } else if (key.startsWith('epn.')) {
                        eventParams[key.replace('epn.', '')] = parseFloat(value);
                    }
                }
                if (Object.keys(eventParams).length > 0) {
                    details.params = eventParams;
                }

                // Parametri ecommerce
                const pr1_nm = urlObj.searchParams.get('pr1.nm');
                if (pr1_nm) details.productName = decodeURIComponent(pr1_nm);
                const pr1_pr = urlObj.searchParams.get('pr1.pr');
                if (pr1_pr) details.productPrice = pr1_pr;

                // Page info
                const dt = urlObj.searchParams.get('dt');
                if (dt) details.pageTitle = decodeURIComponent(dt);
                const dl = urlObj.searchParams.get('dl');
                if (dl) details.pageUrl = decodeURIComponent(dl);
            }

        } catch (e) {
            this.logger.error(`URL parsing failed: ${e.message}`, { url, trackerName });
        }

        return details;
    }

    // Parsing del POST body GA4 - Supporto per batch multipli e formati diversi
    parseGA4PostBody(postData) {
        if (!postData || typeof postData !== 'string') return [];
        const events = [];

        try {
            // GA4 Batch: gli eventi iniziano con 'en=' e sono separati da '&' o newline
            // Usiamo una regex più robusta per catturare tutte le occorrenze di en=
            const enRegex = (/(?:^|[&\n\r])en=([^&\n\r]+)/g);
            let match;
            while ((match = enRegex.exec(postData)) !== null) {
                const eventName = decodeURIComponent(match[1]);
                if (eventName && !events.includes(eventName)) {
                    events.push(eventName);
                }
            }

            // Fallback per altri parametri comuni se non troviamo 'en'
            if (events.length === 0) {
                const altRegex = (/(?:^|[&\n\r])(?:ev|event|e)=([^&\n\r]+)/g);
                while ((match = altRegex.exec(postData)) !== null) {
                    const eventName = decodeURIComponent(match[1]);
                    if (eventName && !events.includes(eventName)) {
                        events.push(eventName);
                    }
                }
            }
        } catch (e) {
            this.logger.error(`GA4 POST parsing failed: ${e.message}`);
        }

        return events;
    }

    isGoogleDeniedMode(url) {
        try {
            const urlObj = new URL(url);
            const gcs = urlObj.searchParams.get('gcs');
            return gcs === 'G100' || gcs === 'G1--';
        } catch {
            return false;
        }
    }
}

module.exports = TrackerParser;
