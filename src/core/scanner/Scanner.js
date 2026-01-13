const { chromium } = require('playwright');
const Logger = require('../../utils/Logger');
const EventDeduplicator = require('../events/EventDeduplicator');
const {
    TRACKER_PATTERNS,
    GOOGLE_CONSENT_PATTERNS,
    GA4_STANDARD_EVENTS,
    GA4_PHONE_EVENTS
} = require('../../config/constants');
const { BROWSER_CONFIG, USER_AGENTS } = require('../../config/config');

// === CLASSE PRINCIPALE SCANNER ===
class Scanner {
    constructor(url, options = {}) {
        this.url = url;
        this.options = {
            headless: options.headless !== false,
            timeout: options.timeout || 10000,
            outputFile: options.outputFile || null,
            verbose: options.verbose || false,
            onPhase: options.onPhase || null,
            onLog: options.onLog || null, // Nuovo: callback per log real-time
            maxRetries: options.maxRetries || 3,
            skipInteractions: options.skipInteractions || false,
            fastMode: options.fastMode || false,
            ...options
        };

        this.logger = new Logger(this.options.verbose);

        // Intercetta i log per lo streaming SSE
        const originalLog = this.logger.log.bind(this.logger);
        this.logger.log = (msg, level = 'info') => {
            originalLog(msg, level);
            if (this.options.onLog && msg && typeof msg === 'string') {
                this.options.onLog(msg.trim(), level);
            }
        };

        this.deduplicator = new EventDeduplicator();
        this.notifyPhase = (phase, label) => {
            if (this.options.onPhase) {
                this.options.onPhase(phase, label);
            }
        };

        this.report = {
            url: url,
            timestamp: new Date().toISOString(),
            _timestamp: Date.now(), // Per TTL
            _eventSignatures: new Set(), // Per deduplicazione
            errors: [], // Errori di parsing
            cmp: {
                detected: false,
                type: null,
                loaded: false,
                consentState: null,
                blockedScripts: []
            },
            preConsent: {
                requests: [],
                cookies: [],
                localStorage: {},
                sessionStorage: {}
            },
            postConsent: {
                requests: [],
                cookies: [],
                localStorage: {},
                sessionStorage: {}
            },
            violations: [],
            technicalPings: [],
            events: {
                preConsent: [],
                postConsent: [],
                interactions: [],
                formTest: []
            },
            forms: {
                found: [],
                submitted: null
            },
            summary: {}
        };

        this.phase = 'PRE_CONSENT';
        this.browser = null;
        this.page = null;
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

                if (!en && postData) {
                    const events = this.parseGA4PostBody(postData);
                    if (events.length > 0) {
                        details.events = events;
                        en = events[0];
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
            this.report.errors.push({
                phase: this.phase,
                message: e.message,
                context: { url, trackerName }
            });
        }

        return details;
    }

    // Parsing del POST body GA4 - Migliorato per catturare più eventi
    parseGA4PostBody(postData) {
        const events = [];
        if (!postData) return events;

        try {
            // Cerca eventi in formato standard (en=nome_evento)
            const enMatches = postData.match(/(?:^|&)en=([^&\r\n]+)/g);
            if (enMatches) {
                for (const match of enMatches) {
                    const eventName = match.replace(/^&?en=/, '');
                    if (eventName && !events.includes(eventName)) {
                        events.push(eventName);
                    }
                }
            }

            // Cerca eventi in formato custom (ev=nome_evento o event=nome_evento)
            const evMatches = postData.match(/(?:^|&)(?:ev|event)=([^&\r\n]+)/g);
            if (evMatches) {
                for (const match of evMatches) {
                    const eventName = match.replace(/^&?(?:ev|event)=/, '');
                    if (eventName && !events.includes(eventName)) {
                        events.push(eventName);
                    }
                }
            }

            // Cerca eventi in formato GA4 avanzato (con parametri)
            const advancedMatches = postData.match(/(?:^|&)e=([^&\r\n]+)/g);
            if (advancedMatches) {
                for (const match of advancedMatches) {
                    const eventName = match.replace(/^&?e=/, '');
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

    // Traccia evento con deduplicazione MIGLIORATA
    trackEvent(details, phase, source = 'automatic') {
        // Deduplicazione con sistema intelligente
        const timestamp = Date.now();

        // Prepara i dati per la deduplicazione
        const dedupDetails = {
            tracker: details.tracker || 'unknown',
            event: details.event || 'unknown',
            phase: phase,
            params: details.params || null
        };

        if (this.deduplicator.isDuplicate(dedupDetails, timestamp)) {
            this.logger.log(`   [DEDUPLICATO] ${details.tracker}: ${details.event}`, 'warn');
            return null;
        }

        // Filter out noisy technical events if they are not critical
        const IGNORED_EVENTS = [
            'gtm.js', 'gtm.dom', 'gtm.load', 'gtm.click', 'gtm.linkClick', 'gtm.scrollDepth',
            'set', 'consent', 'js',
            'cookie_consent_update', 'cookie_consent_preferences', 'cookie_consent_statistics', 'cookie_consent_marketing',
            'audit_verification'
        ];

        if (IGNORED_EVENTS.includes(details.event)) {
            this.logger.log(`   [SKIPPED] ${details.tracker}: ${details.event} (Technical/Noise)`);
            return null;
        }

        const eventData = {
            tracker: details.tracker || 'unknown',
            event: details.event || 'unknown',
            eventCategory: details.eventCategory || 'unknown',
            consentMode: details.consentMode || null,
            timestamp: new Date(timestamp).toISOString(),
            phase: phase,
            source: source, // 'automatic' o 'simulated'
            isStandard: details.isStandardEvent || false,
            pixelId: details.pixelId || null,
            destinationUrl: details.destinationUrl || null,
            pageTitle: details.pageTitle || null,
            pageUrl: details.pageUrl || null,
            params: details.params || null,
            productName: details.productName || null,
            productPrice: details.productPrice || null,
            customData: details.customData || null,
            data: {
                gcs: details.gcsRaw || null,
                gcd: details.gcd || null
            }
        };

        // Rimuovi campi null
        Object.keys(eventData).forEach(key => {
            if (eventData[key] === null) delete eventData[key];
        });

        // Aggiungi firma per deduplicazione aggiuntiva
        const signature = `${eventData.tracker}|${eventData.event}|${timestamp}`;
        if (this.report._eventSignatures.has(signature)) {
            return null;
        }
        this.report._eventSignatures.add(signature);

        if (phase === 'PRE_CONSENT') {
            this.report.events.preConsent.push(eventData);
        } else if (phase === 'INTERACTION') {
            this.report.events.interactions.push(eventData);
        } else {
            this.report.events.postConsent.push(eventData);
        }

        return eventData;
    }

    // Analizza Google Consent Mode
    isGoogleDeniedMode(url) {
        try {
            const urlObj = new URL(url);
            const gcs = urlObj.searchParams.get('gcs');
            return gcs === 'G100' || gcs === 'G1--';
        } catch {
            return false;
        }
    }

    // Handler per le richieste di rete
    handleRequest(request) {
        const url = request.url();
        const trackerName = this.identifyTracker(url);

        if (!trackerName) return;

        const postData = request.postData();
        const details = this.extractRequestDetails(url, trackerName, postData);

        const isLibraryLoad = [
            'GTM Container', 'GTM Collect', 'Facebook SDK',
            'Cookiebot', 'OneTrust', 'iubenda', 'Commanders Act',
            'Didomi', 'Axeptio', 'Usercentrics', 'Quantcast'
        ].includes(trackerName);

        // GA4: analytics.js e gtag.js sono librerie, non tracking reale
        const isGA4LibraryLoad = trackerName === 'GA4' && (
            url.includes('/analytics.js') ||
            url.includes('/gtag.js') ||
            url.includes('/gtag/js')
        );

        // GA4: eventi di configurazione consent mode (set, consent) non sono tracking
        const isGA4ConsentConfig = trackerName === 'GA4' && details.event && (
            details.event === 'set' ||
            details.event === 'consent' ||
            details.event === 'js' ||
            (details.events && details.events.every(e => ['set', 'consent', 'js'].includes(e)))
        );

        const isGoogleDenied = this.isGoogleDeniedMode(url);

        // Traccia eventi
        if (details.event) {
            if (trackerName === 'GA4' && details.events && details.events.length > 0) {
                for (const eventName of details.events) {
                    let eventCategory = 'custom';
                    if (GA4_STANDARD_EVENTS.includes(eventName)) {
                        eventCategory = 'standard';
                    } else if (eventName.startsWith('click_') || eventName.startsWith('cta_')) {
                        eventCategory = 'click';
                    }
                    const eventDetails = {
                        ...details,
                        event: eventName,
                        isStandardEvent: GA4_STANDARD_EVENTS.includes(eventName),
                        eventCategory: eventCategory
                    };
                    this.trackEvent(eventDetails, this.phase);
                    this.logger.log(`   [EVENT] ${trackerName}: ${eventName} (${details.consentMode || 'N/A'})`);
                }
            } else {
                this.trackEvent(details, this.phase);
                this.logger.log(`   [EVENT] ${trackerName}: ${details.event}`);
            }
        }

        if (this.phase === 'PRE_CONSENT') {
            if (isGoogleDenied) {
                this.report.technicalPings.push({ ...details, reason: 'Google Consent Mode Denied' });
                this.logger.log(`   [TECNICO] ${trackerName} (Consent Mode: denied)`);
            } else if (isLibraryLoad || isGA4LibraryLoad) {
                this.report.technicalPings.push({ ...details, reason: 'Library/CMP Load' });
                this.logger.log(`   [TECNICO] Caricamento: ${trackerName}`);
            } else if (isGA4ConsentConfig) {
                this.report.technicalPings.push({ ...details, reason: 'GA4 Consent Configuration' });
                this.logger.log(`   [TECNICO] ${trackerName} config: ${details.event}`);
            } else {
                this.report.preConsent.requests.push(details);

                // Deduplicazione violazioni: conta 1 sola violazione per tracker
                const existingViolation = this.report.violations.find(v => v.tracker === trackerName);
                if (!existingViolation) {
                    this.report.violations.push({
                        type: 'tracking_before_consent',
                        tracker: trackerName,
                        details: details
                    });
                    this.logger.log(`   [VIOLAZIONE] ${trackerName} attivo SENZA consenso!`, 'warn');
                } else {
                    this.logger.log(`   [DEDUPLICATO] Violazione ${trackerName} già registrata`);
                }
            }
        } else {
            this.report.postConsent.requests.push(details);
            this.logger.log(`   [OK] ${trackerName} attivo dopo consenso`);
        }
    }

    // Raccoglie i cookie correnti
    async collectCookies() {
        try {
            const cookies = await this.page.context().cookies();
            return cookies.map(c => ({
                name: c.name,
                domain: c.domain,
                value: c.value.substring(0, 100) + (c.value.length > 100 ? '...' : ''),
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite
            }));
        } catch (e) {
            this.logger.error(`Failed to collect cookies: ${e.message}`);
            return [];
        }
    }

    // Raccoglie LocalStorage e SessionStorage
    async collectStorage() {
        try {
            return await this.page.evaluate(() => {
                const getStorage = (storage) => {
                    const data = {};
                    for (let i = 0; i < storage.length; i++) {
                        const key = storage.key(i);
                        const value = storage.getItem(key);
                        data[key] = value?.substring(0, 200) + (value?.length > 200 ? '...' : '');
                    }
                    return data;
                };

                return {
                    localStorage: getStorage(localStorage),
                    sessionStorage: getStorage(sessionStorage)
                };
            });
        } catch (e) {
            this.logger.error(`Failed to collect storage: ${e.message}`);
            return { localStorage: {}, sessionStorage: {} };
        }
    }

    // Verifica stato CMP
    async checkCMPState() {
        try {
            return await this.page.evaluate(() => {
                // Cookiebot
                const cb = window.Cookiebot;
                if (cb) {
                    return {
                        detected: true,
                        type: 'Cookiebot',
                        loaded: true,
                        consent: cb.consent ? {
                            necessary: cb.consent.necessary,
                            preferences: cb.consent.preferences,
                            statistics: cb.consent.statistics,
                            marketing: cb.consent.marketing
                        } : null,
                        hasResponse: cb.hasResponse
                    };
                }

                // iubenda
                const iub = window._iub;
                if (iub && iub.cs) {
                    const cs = iub.cs;
                    const consent = cs.consent || {};
                    return {
                        detected: true,
                        type: 'iubenda',
                        loaded: true,
                        consent: {
                            necessary: true,
                            preferences: consent.purposes ? consent.purposes['2'] === true : null,
                            statistics: consent.purposes ? consent.purposes['4'] === true : null,
                            marketing: consent.purposes ? consent.purposes['5'] === true : null
                        },
                        hasResponse: cs.consent !== undefined
                    };
                }

                // OneTrust
                const ot = window.OneTrust || window.Optanon;
                if (ot) {
                    return {
                        detected: true,
                        type: 'OneTrust',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Didomi
                const didomi = window.Didomi;
                if (didomi) {
                    return {
                        detected: true,
                        type: 'Didomi',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Commanders Act
                const tC = window.tC;
                if (tC && (tC.privacyCenter || tC.privacy)) {
                    return {
                        detected: true,
                        type: 'Commanders Act',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Quantcast
                const qc = window.__tcfapi || window.quantserve;
                if (qc) {
                    return {
                        detected: true,
                        type: 'Quantcast Choice',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Axeptio
                const axeptio = window.axeptio || window._axcb;
                if (axeptio) {
                    return {
                        detected: true,
                        type: 'Axeptio',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Complianz
                const cmplz = window.cmplz || window.complianz;
                if (cmplz) {
                    return {
                        detected: true,
                        type: 'Complianz',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Klaro
                const klaro = window.klaro || window.klaroConfig;
                if (klaro) {
                    return {
                        detected: true,
                        type: 'Klaro',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Osano
                const osano = window.Osano;
                if (osano) {
                    return {
                        detected: true,
                        type: 'Osano',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Usercentrics
                const uc = window.UC_UI || window.usercentrics;
                if (uc) {
                    return {
                        detected: true,
                        type: 'Usercentrics',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Civic Cookie Control
                const civic = window.CookieControl;
                if (civic) {
                    return {
                        detected: true,
                        type: 'Civic Cookie Control',
                        loaded: true,
                        consent: null,
                        hasResponse: true
                    };
                }

                // Rilevamento generico
                const genericBanners = [
                    '#cookie-banner', '#cookie-notice', '#cookie-consent',
                    '.cookie-banner', '.cookie-notice', '.cookie-consent',
                    '[class*="cookie-banner"]', '[class*="cookie-consent"]',
                    '[id*="cookie-banner"]', '[id*="cookie-consent"]',
                    '#gdpr-banner', '.gdpr-banner', '#privacy-banner',
                    '[class*="gdpr"]', '[class*="privacy-banner"]',
                    '#cc-main', '.cc-banner',
                    '.cli-modal', '#cookie-law-info-bar'
                ];

                for (const selector of genericBanners) {
                    const el = document.querySelector(selector);
                    if (el && el.offsetParent !== null) {
                        return {
                            detected: true,
                            type: 'Banner Generico',
                            loaded: true,
                            consent: null,
                            hasResponse: false
                        };
                    }
                }

                // Cerca script bloccati
                const blockedScripts = document.querySelectorAll(
                    'script[type="text/plain"], script[type="text/tc_privacy"], script[data-cookieconsent]'
                );
                if (blockedScripts.length > 0) {
                    return {
                        detected: true,
                        type: 'CMP Rilevato (script bloccati)',
                        loaded: true,
                        consent: null,
                        hasResponse: false
                    };
                }

                return { detected: false, type: null };
            });
        } catch (e) {
            this.logger.error(`Failed to check CMP state: ${e.message}`);
            return { detected: false, type: null };
        }
    }

    // Verifica script bloccati
    async checkBlockedScripts() {
        try {
            return await this.page.evaluate(() => {
                const blockedSelectors = [
                    'script[type="text/plain"]',
                    'script[type="text/tc_privacy"]',
                    'script[data-cookieconsent]',
                    'script[data-category]',
                    'script[data-consent]',
                    'script[data-requires-consent]',
                    'script.cmplz-blocked',
                    'script[data-cmplz-src]'
                ];

                const scripts = document.querySelectorAll(blockedSelectors.join(','));
                return Array.from(scripts).map(s => ({
                    src: s.src || s.getAttribute('data-src') || s.getAttribute('data-cmplz-src') || '(inline)',
                    type: s.type,
                    category: s.getAttribute('data-category') || s.getAttribute('data-cookieconsent') || null
                }));
            });
        } catch (e) {
            this.logger.error(`Failed to check blocked scripts: ${e.message}`);
            return [];
        }
    }

    // Cerca e clicca il banner di consenso
    async acceptCookies() {
        const selectors = [
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
            '#CybotCookiebotDialogBodyButtonAccept',
            '[data-cookiebanner="accept_button"]',
            '.iubenda-cs-accept-btn',
            '.iubenda-cs-btn-primary',
            '#iubenda-cs-banner .iubenda-cs-accept-btn',
            'button.iub-btn-consent',
            '[data-iub-action="accept"]',
            '#onetrust-accept-btn-handler',
            '.onetrust-close-btn-handler',
            '#didomi-notice-agree-button',
            '[data-testid="notice-accept-button"]',
            '#privacy-cp-wall-accept',
            '.privacy-cp-btn-accept',
            '[data-tc-privacy-accept]',
            '#tc-privacy-button-accept',
            '.qc-cmp2-summary-buttons button:first-child',
            '.qc-cmp-button[mode="primary"]',
            '.axeptio_btn_acceptAll',
            '[data-axeptio-action="acceptAll"]',
            '.cmplz-accept',
            '#cmplz-accept',
            '.cmplz-btn.cmplz-accept',
            '.klaro .cm-btn-success',
            '.klaro button[data-consent="accept"]',
            '#uc-btn-accept-banner',
            '.uc-accept-all',
            '.osano-cm-accept-all',
            '.osano-cm-button--type_accept',
            '#ccc-notify-accept',
            '#ccc-module-close',
            '#cookie_action_close_header',
            '.cli_action_button.wt-cli-accept-all-btn',
            '.cc-btn.cc-allow',
            '.cc-compliance .cc-allow',
            '[data-action="accept"]',
            '[data-action="accept-all"]',
            'button[aria-label*="Accept"]',
            'button[aria-label*="Accetta"]',
            '.cookie-accept',
            '#cookie-accept',
            '.accept-cookies',
            '#accept-cookies',
            '[class*="accept-all"]',
            '[class*="accept-cookies"]',
            'button:has-text("Accetta tutti")',
            'button:has-text("Accept all")',
            'button:has-text("Accetto")',
            'button:has-text("OK")',
        ];

        for (const selector of selectors) {
            try {
                const button = await this.page.$(selector);
                if (button && await button.isVisible()) {
                    await button.click();
                    this.logger.log(`Click su banner consenso: ${selector}`);
                    return true;
                }
            } catch (e) {
                // Prossimo selettore
            }
        }

        return false;
    }

    // Simula scroll
    async simulateScroll() {
        this.logger.log('Simulazione scroll...');

        try {
            await this.page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight * 0.3, behavior: 'smooth' });
            });
            await this.page.waitForTimeout(800);

            await this.page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight * 0.6, behavior: 'smooth' });
            });
            await this.page.waitForTimeout(800);

            await this.page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight * 0.95, behavior: 'smooth' });
            });
            await this.page.waitForTimeout(2000);

            await this.page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            });
            await this.page.waitForTimeout(1500);

            await this.page.evaluate(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            await this.page.waitForTimeout(1000);
        } catch (e) {
            this.logger.error(`Scroll simulation failed: ${e.message}`);
        }
    }

    // Simula click - Versione ultra-migliorata per triggerare click_phone
    async simulateClicks() {
        this.logger.log('Simulazione click REALISTICA per click_phone...');

        try {
            // Prima: trova specificamente link telefonici
            const phoneLinks = await this.page.evaluate(() => {
                const selectors = [
                    'a[href^="tel:"]',
                    'a[href*="tel"]',
                    'a[href*="phone"]',
                    'a[href*="call"]',
                    'a[href*="whatsapp"]',
                    'a[href*="wa.me"]'
                ];

                const elements = [];
                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        if (el.offsetParent !== null) {
                            const href = el.getAttribute('href') || '';
                            const onclick = el.getAttribute('onclick') || '';
                            const text = el.textContent?.trim() || '';
                            elements.push({
                                selector: selector,
                                tagName: el.tagName,
                                href: href,
                                onclick: onclick,
                                text: text,
                                rect: el.getBoundingClientRect(),
                                isPhone: href.includes('tel:') || href.includes('phone') || href.includes('call') || onclick.includes('tel:') || onclick.includes('phone') || onclick.includes('click_phone')
                            });
                        }
                    });
                });
                return elements;
            });

            this.logger.log(`   Trovati ${phoneLinks.length} link telefonici`);

            // Seconda: clicca SOLO link telefonici con eventi mouse REALISTICI
            let phoneClicks = 0;

            for (const link of phoneLinks) {
                if (phoneClicks >= 5) break;

                try {
                    // Trova l'elemento esatto nella pagina
                    const elementHandle = await this.page.evaluateHandle((args) => {
                        const { selector, href, text } = args;
                        const elements = Array.from(document.querySelectorAll(selector));
                        return elements.find(el => {
                            const elHref = el.getAttribute('href') || '';
                            const elText = el.textContent?.trim() || '';
                            return (href && elHref === href) || (text && elText.includes(text));
                        });
                    }, { selector: link.selector, href: link.href, text: link.text });

                    if (elementHandle && elementHandle.asElement()) {
                        this.logger.log(`   Clicco link telefonico: ${link.href} (${link.text.substring(0, 30)})`);

                        // Click REALISTICO con tutti gli eventi mouse
                        await this.page.evaluate((el) => {
                            if (!el) return;

                            const rect = el.getBoundingClientRect();
                            const x = rect.left + rect.width / 2;
                            const y = rect.top + rect.height / 2;

                            // Sequenza eventi mouse REALISTICA
                            const events = [
                                new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }),
                                new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }),
                                new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }),
                                new MouseEvent('focus', { bubbles: true, cancelable: true, view: window }),
                                new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }),
                                new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 })
                            ];

                            events.forEach(event => el.dispatchEvent(event));
                        }, elementHandle);

                        phoneClicks++;

                        // Attesa più lunga per eventi async (click_phone potrebbe essere delayed)
                        await this.page.waitForTimeout(1500);

                        // Forza un refresh del dataLayer per catturare eventi delayed
                        await this.page.evaluate(() => {
                            if (window.dataLayer && window.dataLayer.push) {
                                // Triggera un evento di verifica
                                window.dataLayer.push({ event: 'audit_verification', timestamp: Date.now() });
                            }
                        });

                        await this.page.waitForTimeout(500);
                    }
                } catch (e) {
                    this.logger.error(`   Errore click: ${e.message}`);
                }
            }

            this.logger.log(`   Click telefonici effettuati: ${phoneClicks}`);

            // Terza: attesa finale per tutti gli eventi async
            if (phoneClicks > 0) {
                this.logger.log('   Attesa finale per eventi async...');
                await this.page.waitForTimeout(3000);

                // Verifica finale dataLayer
                const finalDataLayer = await this.page.evaluate(() => {
                    return window.__dataLayerEvents || [];
                });

                if (finalDataLayer.length > 0) {
                    this.logger.log(`   Eventi dataLayer finali: ${finalDataLayer.length}`);
                    finalDataLayer.forEach(e => {
                        this.logger.log(`      - ${e.event} (${e.source})`);
                    });
                }
            }
        } catch (e) {
            this.logger.error(`Click simulation failed: ${e.message}`);
        }
    }

    // Trova form
    async findForms() {
        try {
            const forms = await this.page.evaluate(() => {
                const formElements = document.querySelectorAll('form');
                return Array.from(formElements).map((form, index) => {
                    const hasNameField = !!form.querySelector('input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i], input[placeholder*="name" i]');
                    const hasSurnameField = !!form.querySelector('input[name*="surname" i], input[name*="cognome" i], input[placeholder*="cognome" i], input[placeholder*="surname" i]');
                    const hasEmailField = !!form.querySelector('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');
                    const hasPasswordField = !!form.querySelector('input[type="password"]');
                    const hasSearchField = !!form.querySelector('input[type="search"], input[name*="search" i], input[name*="query" i], input[name*="q" i]');
                    const hasPhoneField = !!form.querySelector('input[type="tel"], input[name*="phone" i], input[name*="telefono" i]');
                    const isValid = hasNameField || hasSurnameField || hasEmailField;

                    // Verifica visibilità
                    const rect = form.getBoundingClientRect();
                    const style = window.getComputedStyle(form);
                    const isVisible = rect.width > 0 && rect.height > 0 &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0';

                    // Trova testo del pulsante submit
                    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                    const submitText = submitBtn ? (submitBtn.textContent || submitBtn.value || '').trim().substring(0, 50) : null;

                    // Trova labels/placeholder dei campi
                    const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
                    const fieldLabels = Array.from(inputs).slice(0, 5).map(input => {
                        const label = form.querySelector(`label[for="${input.id}"]`);
                        return label?.textContent?.trim()?.substring(0, 30) ||
                            input.placeholder?.substring(0, 30) ||
                            input.name?.substring(0, 30) ||
                            input.type;
                    }).filter(Boolean);

                    // Determina tipo probabile del form
                    let formType = 'altro';
                    if (hasPasswordField && hasEmailField && !hasNameField && !hasSurnameField) {
                        formType = 'login';
                    } else if (hasSearchField && !hasEmailField && !hasNameField) {
                        formType = 'ricerca';
                    } else if (hasEmailField && !hasPasswordField && !hasNameField && !hasSurnameField) {
                        formType = 'newsletter';
                    } else if (hasEmailField && (hasNameField || hasSurnameField) && !hasPasswordField) {
                        formType = 'contatto/iscrizione';
                    } else if (hasPasswordField && (hasNameField || hasEmailField)) {
                        formType = 'registrazione';
                    } else if (hasPhoneField || hasNameField || hasSurnameField) {
                        formType = 'contatto';
                    }

                    return {
                        index,
                        id: form.id || null,
                        className: form.className?.substring(0, 50) || null,
                        action: form.action || null,
                        method: form.method || 'get',
                        formType,
                        isVisible,
                        submitText,
                        fieldLabels,
                        hasNameField,
                        hasSurnameField,
                        hasEmailField,
                        hasPasswordField,
                        isValid
                    };
                });
            });

            const validForms = forms.filter(f => f.isValid);
            this.report.forms.found = validForms;
            this.report.forms.all = forms; // Salva anche tutti i form per debug
            this.logger.log(`Form trovati: ${forms.length} (validi: ${validForms.length})`);
            return validForms;
        } catch (e) {
            this.logger.error(`Failed to find forms: ${e.message}`);
            return [];
        }
    }

    // Interagisce con form
    async interactWithForm() {
        if (this.report.forms.found.length === 0) {
            this.logger.log('   Nessun form valido trovato', 'warn');
            return false;
        }

        this.logger.log(`Interazione con form valido...`);

        try {
            const selectors = [
                'input[type="email"]',
                'input[name*="email" i]',
                'input[name*="nome" i]',
                'input[name*="name" i]',
                'input[name*="cognome" i]',
                'input[name*="surname" i]'
            ];

            for (const selector of selectors) {
                const inputs = await this.page.$$(`form ${selector}`);
                for (const input of inputs) {
                    try {
                        if (await input.isVisible()) {
                            await input.focus();
                            await this.page.waitForTimeout(300);
                            await input.type('test', { delay: 30 });
                            await this.page.waitForTimeout(300);
                            await input.fill('');
                            this.logger.log('   Form interaction completata');
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            this.logger.log('   Nessun campo form visibile', 'warn');
        } catch (e) {
            this.logger.error(`Form interaction failed: ${e.message}`);
        }
        return false;
    }

    // Esecuzione principale con retry
    async run() {
        this.logger.log(`\n=== COOKIE AUDIT SCANNER ===`);
        this.logger.log(`URL: ${this.url}`);

        // Ottimizzazione: riduci timeout per pagine semplici ma aumenta per pagine lente
        const baseTimeout = this.options.fastMode ? 25000 : this.options.timeout;
        const optimizedTimeout = baseTimeout + 10000;
        this.logger.log(`Timeout configurato: ${optimizedTimeout}ms`);

        for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
            try {
                this.logger.log(`Tentativo ${attempt}/${this.options.maxRetries}`);

                const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

                this.browser = await chromium.launch({
                    headless: this.options.headless,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--disable-extensions',
                        '--disable-background-networking',
                        '--disable-default-apps',
                        '--disable-sync',
                        '--metrics-recording-only',
                        '--no-first-run',
                        '--safebrowsing-disable-auto-update',
                        '--disable-features=VizDisplayCompositor',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--disable-infobars',
                        '--window-size=1920,1080',
                        '--start-maximized',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process'
                    ]
                });

                const context = await this.browser.newContext({
                    ...BROWSER_CONFIG,
                    userAgent: randomUserAgent,
                    viewport: { width: 1920, height: 1080 },
                    locale: 'it-IT',
                    timezoneId: 'Europe/Rome',
                    extraHTTPHeaders: {
                        ...BROWSER_CONFIG.extraHTTPHeaders,
                        'User-Agent': randomUserAgent
                    }
                });
                this.page = await context.newPage();

                await this.page.route('**/*.{png,jpg,jpeg,webp,woff2,font,css}', route => route.abort());

                this.page.on('request', (req) => this.handleRequest(req));

                await this.page.addInitScript(() => {
                    window.__dataLayerEvents = [];
                    window.__auditPhase = 'UNKNOWN';

                    const setupDataLayerMonitoring = () => {
                        if (!window.dataLayer) {
                            window.dataLayer = [];
                        }

                        if (window.dataLayer.__auditMonitored) return;

                        const originalPush = window.dataLayer.push.bind(window.dataLayer);
                        window.dataLayer.push = function (...args) {
                            args.forEach(item => {
                                if (item && typeof item === 'object') {
                                    const eventName = item.event || item[0];
                                    if (eventName) {
                                        window.__dataLayerEvents.push({
                                            event: eventName,
                                            data: item,
                                            timestamp: Date.now(),
                                            phase: window.__auditPhase,
                                            source: 'dataLayer'
                                        });
                                    }
                                }
                            });
                            return originalPush(...args);
                        };
                        window.dataLayer.__auditMonitored = true;
                    };

                    setupDataLayerMonitoring();

                    let dataLayerCheck = window.dataLayer;
                    Object.defineProperty(window, 'dataLayer', {
                        get: () => dataLayerCheck,
                        set: (val) => {
                            dataLayerCheck = val;
                            if (Array.isArray(val) && !val.__auditMonitored) {
                                setTimeout(setupDataLayerMonitoring, 0);
                            }
                        },
                        configurable: true
                    });

                    const setupGtagMonitoring = () => {
                        if (window.gtag && !window.gtag.__auditMonitored) {
                            const originalGtag = window.gtag;
                            window.gtag = function (...args) {
                                const command = args[0];
                                if (command === 'event') {
                                    const eventName = args[1];
                                    const params = args[2] || {};
                                    window.__dataLayerEvents.push({
                                        event: eventName,
                                        data: params,
                                        timestamp: Date.now(),
                                        phase: window.__auditPhase,
                                        source: 'gtag'
                                    });
                                }
                                return originalGtag.apply(window, args);
                            };
                            window.gtag.__auditMonitored = true;
                        }
                    };

                    setupGtagMonitoring();
                    setTimeout(setupGtagMonitoring, 1000);
                });

                await this.page.evaluate(() => { window.__auditPhase = 'PRE_CONSENT'; });
                this.logger.log('--- FASE 1: Analisi PRE-CONSENSO ---');
                this.phase = 'PRE_CONSENT';
                this.notifyPhase('pre_consent', 'Analisi pre-consenso...');

                const waitUntilMode = this.options.fastMode ? 'load' : 'networkidle';
                this.logger.log(`Navigazione con waitUntil: ${waitUntilMode}, timeout: ${optimizedTimeout}ms`);

                await this.page.goto(this.url, {
                    waitUntil: waitUntilMode,
                    timeout: optimizedTimeout
                });

                this.logger.log(`Pagina caricata, URL finale: ${this.page.url()}`);

                await this.page.waitForTimeout(this.options.fastMode ? 2000 : 3000);

                let cmpState = await this.checkCMPState();
                let retryCount = 0;
                const maxRetries = 4;

                while (!cmpState.detected && retryCount < maxRetries) {
                    this.logger.log(`CMP non rilevato, retry ${retryCount + 1}/${maxRetries}...`);

                    const waitTime = 1500 + (retryCount * 500);
                    await this.page.waitForTimeout(waitTime);

                    if (retryCount >= 2) {
                        const scriptCMP = await this.page.evaluate(() => {
                            const scripts = Array.from(document.querySelectorAll('script[src*="cookiebot"]'));
                            if (scripts.length > 0) {
                                return {
                                    detected: true,
                                    type: 'Cookiebot (script)',
                                    loaded: false,
                                    consent: null,
                                    hasResponse: false
                                };
                            }

                            const otScripts = Array.from(document.querySelectorAll('script[src*="onetrust"], script[src*="optanon"]'));
                            if (otScripts.length > 0) {
                                return {
                                    detected: true,
                                    type: 'OneTrust (script)',
                                    loaded: false,
                                    consent: null,
                                    hasResponse: false
                                };
                            }

                            return null;
                        });

                        if (scriptCMP) {
                            this.logger.log(`CMP rilevato via script: ${scriptCMP.type}`);
                            cmpState = scriptCMP;
                            break;
                        }
                    }

                    cmpState = await this.checkCMPState();
                    retryCount++;
                }

                this.report.cmp = { ...this.report.cmp, ...cmpState };

                this.report.preConsent.cookies = await this.collectCookies();
                const preStorage = await this.collectStorage();
                this.report.preConsent.localStorage = preStorage.localStorage;
                this.report.preConsent.sessionStorage = preStorage.sessionStorage;

                if (cmpState.detected) {
                    this.logger.log(`CMP rilevato: ${cmpState.type}`);
                    this.report.cmp.blockedScripts = await this.checkBlockedScripts();
                    this.logger.log(`Script bloccati: ${this.report.cmp.blockedScripts.length}`);
                } else {
                    this.logger.log('Nessun CMP rilevato', 'warn');
                }

                this.logger.log('\n--- FASE 2: Accettazione Consenso ---');
                this.phase = 'POST_CONSENT';
                this.notifyPhase('consent', 'Accettazione consenso...');

                const accepted = await this.acceptCookies();
                if (!accepted) {
                    this.logger.log('Nessun banner trovato o già accettato', 'warn');
                }

                await this.waitForConsentEffectsOptimized();

                this.notifyPhase('post_consent', 'Verifica post-consenso...');
                this.report.postConsent.cookies = await this.collectCookies();
                const postStorage = await this.collectStorage();
                this.report.postConsent.localStorage = postStorage.localStorage;
                this.report.postConsent.sessionStorage = postStorage.sessionStorage;

                if (cmpState.detected) {
                    const cmpStatePost = await this.checkCMPState();
                    this.report.cmp.consentState = cmpStatePost.consent;
                    this.logger.log(`Stato consenso ${cmpState.type}: ${JSON.stringify(cmpStatePost.consent)}`);
                }

                if (!this.options.skipInteractions && !this.options.fastMode) {
                    this.logger.log('\n--- FASE 3: Test Interazioni ---');
                    this.phase = 'INTERACTION';
                    this.notifyPhase('interactions', 'Test interazioni...');

                    await this.findForms();
                    await this.simulateScroll();
                    await this.simulateClicks();
                    await this.interactWithForm();

                    this.logger.log('Attesa invio batch GA4...');
                    await this.page.waitForTimeout(1500);
                } else {
                    this.logger.log('\n--- FASE 3: Saltata (modalità rapida) ---');
                    await this.page.waitForTimeout(500);
                }

                this.logger.log('\n--- RACCOLTA EVENTI DATALAYER ---');
                const dataLayerEvents = await this.page.evaluate(() => {
                    return window.__dataLayerEvents || [];
                });

                if (dataLayerEvents.length > 0) {
                    this.logger.log(`Trovati ${dataLayerEvents.length} eventi nel dataLayer`);

                    dataLayerEvents.forEach(dlEvent => {
                        const eventName = dlEvent.event;
                        const phase = dlEvent.phase === 'PRE_CONSENT' ? 'PRE_CONSENT' :
                            dlEvent.phase === 'POST_CONSENT' ? 'POST_CONSENT' : 'POST_CONSENT';

                        let tracker = 'GA4';
                        if (dlEvent.source === 'gtag') {
                            tracker = 'GA4';
                        } else if (dlEvent.data && dlEvent.data.tracker) {
                            tracker = dlEvent.data.tracker;
                        }

                        let eventCategory = 'custom';
                        if (GA4_STANDARD_EVENTS.includes(eventName)) {
                            eventCategory = 'standard';
                        } else if (GA4_PHONE_EVENTS.includes(eventName) || eventName.startsWith('click_') || eventName.startsWith('cta_')) {
                            eventCategory = 'click';
                        }

                        const details = {
                            tracker: tracker,
                            event: eventName,
                            eventCategory: eventCategory,
                            timestamp: new Date(dlEvent.timestamp).toISOString(),
                            phase: phase,
                            source: 'automatic',
                            isStandard: GA4_STANDARD_EVENTS.includes(eventName) || GA4_PHONE_EVENTS.includes(eventName),
                            params: dlEvent.data || null
                        };

                        this.trackEvent(details, phase, 'automatic');
                        this.logger.log(`   [DATALAYER] ${tracker}: ${eventName}`);
                    });
                } else {
                    this.logger.log('Nessun evento dataLayer rilevato');
                }

                await this.page.close();
                await this.browser.close();
                this.browser = null;
                this.page = null;

                break;

            } catch (error) {
                this.logger.error(`Errore tentativo ${attempt}: ${error.message}`);
                this.report.errors.push({
                    phase: this.phase,
                    message: error.message,
                    attempt: attempt
                });

                if (this.page) {
                    try { await this.page.close(); } catch (e) { }
                }
                if (this.browser) {
                    try { await this.browser.close(); } catch (e) { }
                }

                if (attempt === this.options.maxRetries) {
                    throw error;
                }

                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }

        this.notifyPhase('finalizing', 'Generazione report...');
        this.generateSummary();

        this.deduplicator.dispose();

        this.printReport();

        if (this.options.outputFile) {
            await this.saveReport();
        }

        return this.report;
    }

    // Adaptive waiting ottimizzato e più aggressivo
    async waitForConsentEffectsOptimized() {
        const startTime = Date.now();
        let lastRequestTime = startTime;
        let checkCount = 0;
        const maxWait = this.options.fastMode ? 12000 : 15000;

        while (Date.now() - startTime < maxWait) {
            checkCount++;
            await this.page.waitForTimeout(300);

            if (this.report.postConsent.requests.length > 0) {
                lastRequestTime = Date.now();
            }

            if (Date.now() - lastRequestTime > 2000 && checkCount > 6) {
                break;
            }
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        this.logger.log(`Adaptive waiting ottimizzato: ${elapsed}s (max: ${maxWait / 1000}s)`);
    }

    // Genera il summary
    generateSummary() {
        const newCookies = this.report.postConsent.cookies.filter(
            post => !this.report.preConsent.cookies.find(pre => pre.name === post.name)
        );

        const allEvents = [
            ...this.report.events.preConsent,
            ...this.report.events.postConsent,
            ...this.report.events.interactions,
            ...this.report.events.formTest
        ];

        const eventsByTracker = {};
        allEvents.forEach(e => {
            if (!eventsByTracker[e.tracker]) {
                eventsByTracker[e.tracker] = {
                    standard: [],
                    custom: [],
                    click: [],
                    session: [],
                    conversion: []
                };
            }
            const category = e.eventCategory || 'custom';
            const eventInfo = {
                name: e.event,
                destinationUrl: e.destinationUrl,
                params: e.params,
                productName: e.productName
            };
            const exists = eventsByTracker[e.tracker][category]?.some(ev => ev.name === e.event);
            if (!exists && eventsByTracker[e.tracker][category]) {
                eventsByTracker[e.tracker][category].push(eventInfo);
            }
        });

        Object.keys(eventsByTracker).forEach(tracker => {
            Object.keys(eventsByTracker[tracker]).forEach(cat => {
                if (eventsByTracker[tracker][cat].length === 0) {
                    delete eventsByTracker[tracker][cat];
                }
            });
        });

        const uniqueEvents = [...new Set(allEvents.map(e => `${e.tracker}: ${e.event}`))];

        this.report.summary = {
            violations: this.report.violations.length,
            technicalPings: this.report.technicalPings.length,
            trackersPostConsent: this.report.postConsent.requests.length,
            cookiesPreConsent: this.report.preConsent.cookies.length,
            cookiesPostConsent: this.report.postConsent.cookies.length,
            newCookiesAfterConsent: newCookies.length,
            cmpWorking: this.report.cmp.detected &&
                this.report.violations.length === 0 &&
                this.report.cmp.consentState?.marketing === true,
            blockedScriptsCount: this.report.cmp.blockedScripts?.length || 0,
            events: {
                total: allEvents.length,
                preConsent: this.report.events.preConsent.length,
                postConsent: this.report.events.postConsent.length,
                interactions: this.report.events.interactions.length,
                formTest: this.report.events.formTest.length,
                uniqueEvents: uniqueEvents,
                byTracker: eventsByTracker
            },
            formsFound: this.report.forms.found.length,
            formSubmitted: this.report.forms.submitted?.success || false,
            errors: this.report.errors.length
        };
    }

    // Stampa report
    printReport() {
        console.log('\n========================================');
        console.log('         RISULTATO AUDIT');
        console.log('========================================\n');

        console.log('CMP STATUS:');
        console.log(`  Rilevato: ${this.report.cmp.detected ? 'Si' : 'NO'}`);
        if (this.report.cmp.detected) {
            console.log(`  Tipo: ${this.report.cmp.type}`);
            console.log(`  Script bloccati: ${this.report.summary.blockedScriptsCount}`);
            console.log(`  Consenso post-click: ${JSON.stringify(this.report.cmp.consentState)}`);
        }

        console.log('\nVIOLAZIONI (tracking pre-consenso):');
        if (this.report.violations.length === 0) {
            console.log('  Nessuna violazione rilevata');
        } else {
            this.report.violations.forEach(v => {
                let info = v.details.event || v.details.url.substring(0, 80);
                if (v.details.gcsRaw) {
                    info += ` (Consent State: ${v.details.gcsRaw})`;
                }
                console.log(`  - ${v.tracker}: ${info}`);
            });
        }

        console.log('\nTRACKER ATTIVATI POST-CONSENSO:');
        const uniqueTrackers = [...new Set(this.report.postConsent.requests.map(r => r.tracker))];
        if (uniqueTrackers.length === 0) {
            console.log('  Nessun tracker rilevato');
        } else {
            uniqueTrackers.forEach(t => {
                const count = this.report.postConsent.requests.filter(r => r.tracker === t).length;
                console.log(`  - ${t} (${count} richieste)`);
            });
        }

        console.log('\n========================================');
        if (this.report.summary.violations === 0 && this.report.cmp.detected) {
            console.log(`VERDETTO: CONFORME - ${this.report.cmp.type} funziona correttamente`);
        } else if (this.report.summary.violations > 0) {
            console.log(`VERDETTO: NON CONFORME - ${this.report.summary.violations} violazioni`);
        } else {
            console.log('VERDETTO: DA VERIFICARE - Nessun CMP rilevato');
        }
        console.log('========================================\n');
    }

    // Salva report
    async saveReport() {
        const fs = require('fs').promises;
        const filename = this.options.outputFile || `audit-${Date.now()}.json`;
        await fs.writeFile(filename, JSON.stringify(this.report, null, 2));
        this.logger.log(`Report salvato: ${filename}`, 'success');
    }
}

module.exports = { CookieAuditScanner: Scanner };
