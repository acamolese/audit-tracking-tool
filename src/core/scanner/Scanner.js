const { chromium } = require('playwright');
const Logger = require('../../utils/Logger');
const EventDeduplicator = require('../events/EventDeduplicator');
const TrackerParser = require('./TrackerParser');
const CMPManager = require('./CMPManager');
const InteractionSimulator = require('./InteractionSimulator');
const {
    GA4_STANDARD_EVENTS,
    GA4_PHONE_EVENTS
} = require('../../config/constants');
const { BROWSER_CONFIG, USER_AGENTS } = require('../../config/config');

class Scanner {
    constructor(url, options = {}) {
        this.url = url;
        this.options = {
            headless: options.headless !== false,
            timeout: options.timeout || 10000,
            outputFile: options.outputFile || null,
            verbose: options.verbose || false,
            onPhase: options.onPhase || null,
            onLog: options.onLog || null,
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
            _timestamp: Date.now(),
            _eventSignatures: new Set(),
            errors: [],
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
        this.parser = new TrackerParser(this.logger);
        this.cmpManager = null;
        this.simulator = null;
    }

    // Handler per le richieste di rete
    handleRequest(request) {
        const url = request.url();
        const trackerName = this.parser.identifyTracker(url);

        if (!trackerName) return;

        const postData = request.postData();
        const details = this.parser.extractRequestDetails(url, trackerName, postData);

        const isLibraryLoad = [
            'GTM Container', 'GTM Collect', 'Facebook SDK',
            'Cookiebot', 'OneTrust', 'iubenda', 'Commanders Act',
            'Didomi', 'Axeptio', 'Usercentrics', 'Quantcast'
        ].includes(trackerName);

        const isGA4LibraryLoad = trackerName === 'GA4' && (
            url.includes('/analytics.js') ||
            url.includes('/gtag.js') ||
            url.includes('/gtag/js')
        );

        const isGA4ConsentConfig = trackerName === 'GA4' && details.event && (
            details.event === 'set' ||
            details.event === 'consent' ||
            details.event === 'js' ||
            (details.events && details.events.every(e => ['set', 'consent', 'js'].includes(e)))
        );

        const isGoogleDenied = this.parser.isGoogleDeniedMode(url);

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
                const existingViolation = this.report.violations.find(v => v.tracker === trackerName);
                if (!existingViolation) {
                    this.report.violations.push({
                        type: 'tracking_before_consent',
                        tracker: trackerName,
                        details: details
                    });
                    this.logger.log(`   [VIOLAZIONE] ${trackerName} attivo SENZA consenso!`, 'warn');
                }
            }
        } else {
            this.report.postConsent.requests.push(details);
            this.logger.log(`   [OK] ${trackerName} attivo dopo consenso`);
        }
    }

    trackEvent(details, phase, source = 'automatic') {
        const timestamp = Date.now();
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

        const IGNORED_EVENTS = ['gtm.js', 'gtm.dom', 'gtm.load', 'gtm.click', 'gtm.linkClick', 'gtm.scrollDepth', 'set', 'consent', 'js', 'cookie_consent_update', 'cookie_consent_preferences', 'cookie_consent_statistics', 'cookie_consent_marketing', 'audit_verification'];

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
            source: source,
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

        const signature = `${eventData.tracker}|${eventData.event}|${timestamp}`;
        if (this.report._eventSignatures.has(signature)) return null;
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

    async run() {
        this.logger.log(`\n=== COOKIE AUDIT SCANNER ===`);
        this.logger.log(`URL: ${this.url}`);

        const baseTimeout = this.options.fastMode ? 25000 : this.options.timeout;
        const optimizedTimeout = baseTimeout + 10000;

        for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
            try {
                this.logger.log(`Tentativo ${attempt}/${this.options.maxRetries}`);
                const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

                this.browser = await chromium.launch({
                    headless: this.options.headless,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-blink-features=AutomationControlled']
                });

                const context = await this.browser.newContext({
                    ...BROWSER_CONFIG,
                    userAgent: randomUserAgent,
                    viewport: { width: 1920, height: 1080 }
                });
                this.page = await context.newPage();
                this.cmpManager = new CMPManager(this.page, this.logger);
                this.simulator = new InteractionSimulator(this.page, this.logger);

                await this.page.route('**/*.{png,jpg,jpeg,webp,woff2,font,css}', route => route.abort());
                this.page.on('request', (req) => this.handleRequest(req));

                await this.page.addInitScript(() => {
                    window.__dataLayerEvents = [];
                    window.__auditPhase = 'UNKNOWN';
                    // ... dataLayer monitoring logic (kept unified for now as it's small)
                    if (!window.dataLayer) window.dataLayer = [];
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
                });

                await this.page.evaluate(() => { window.__auditPhase = 'PRE_CONSENT'; });
                this.phase = 'PRE_CONSENT';
                this.notifyPhase('pre_consent', 'Analisi pre-consenso...');

                await this.page.goto(this.url, {
                    waitUntil: this.options.fastMode ? 'load' : 'networkidle',
                    timeout: optimizedTimeout
                });

                await this.page.waitForTimeout(this.options.fastMode ? 2000 : 3000);

                let cmpState = await this.cmpManager.checkCMPState();
                this.report.cmp = { ...this.report.cmp, ...cmpState };
                this.report.preConsent.cookies = await this.collectCookies();
                const preStorage = await this.collectStorage();
                this.report.preConsent.localStorage = preStorage.localStorage;
                this.report.preConsent.sessionStorage = preStorage.sessionStorage;

                if (cmpState.detected) {
                    this.report.cmp.blockedScripts = await this.cmpManager.checkBlockedScripts();
                }

                this.logger.log('\n--- FASE 2: Accettazione Consenso ---');
                this.phase = 'POST_CONSENT';
                this.notifyPhase('consent', 'Accettazione consenso...');

                const accepted = await this.cmpManager.acceptCookies();
                if (!accepted) this.logger.log('Nessun banner trovato o già accettato', 'warn');

                await this.waitForConsentEffectsOptimized();

                this.notifyPhase('post_consent', 'Verifica post-consenso...');
                this.report.postConsent.cookies = await this.collectCookies();
                const postStorage = await this.collectStorage();
                this.report.postConsent.localStorage = postStorage.localStorage;
                this.report.postConsent.sessionStorage = postStorage.sessionStorage;

                if (cmpState.detected) {
                    const cmpStatePost = await this.cmpManager.checkCMPState();
                    this.report.cmp.consentState = cmpStatePost.consent;
                }

                if (!this.options.skipInteractions && !this.options.fastMode) {
                    this.logger.log('\n--- FASE 3: Test Interazioni ---');
                    this.phase = 'INTERACTION';
                    this.notifyPhase('interactions', 'Test interazioni...');
                    const forms = await this.simulator.findForms();
                    this.report.forms.found = forms.filter(f => f.isValid);
                    this.report.forms.all = forms;
                    await this.simulator.simulateScroll();
                    await this.simulator.simulateClicks();
                    await this.simulator.interactWithForm();
                    await this.page.waitForTimeout(1500);
                }

                this.logger.log('\n--- RACCOLTA EVENTI DATALAYER ---');
                const dataLayerEvents = await this.page.evaluate(() => window.__dataLayerEvents || []);
                dataLayerEvents.forEach(dlEvent => {
                    const phase = dlEvent.phase === 'PRE_CONSENT' ? 'PRE_CONSENT' : 'POST_CONSENT';
                    const details = {
                        tracker: dlEvent.source === 'gtag' ? 'GA4' : (dlEvent.data?.tracker || 'GA4'),
                        event: dlEvent.event,
                        timestamp: new Date(dlEvent.timestamp).toISOString(),
                        phase,
                        params: dlEvent.data || null
                    };
                    this.trackEvent(details, phase, 'automatic');
                });

                await this.page.close();
                await this.browser.close();
                break;
            } catch (error) {
                this.logger.error(`Errore tentativo ${attempt}: ${error.message}`);
                if (this.browser) await this.browser.close();
                if (attempt === this.options.maxRetries) throw error;
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }

        this.generateSummary();
        this.deduplicator.dispose();
        return this.report;
    }

    async waitForConsentEffectsOptimized() {
        const startTime = Date.now();
        let lastRequestTime = startTime;
        const maxWait = this.options.fastMode ? 12000 : 15000;
        while (Date.now() - startTime < maxWait) {
            await this.page.waitForTimeout(300);
            if (this.report.postConsent.requests.length > 0) lastRequestTime = Date.now();
            if (Date.now() - lastRequestTime > 2000 && (Date.now() - startTime) > 2000) break;
        }
    }

    generateSummary() {
        const newCookies = this.report.postConsent.cookies.filter(post => !this.report.preConsent.cookies.find(pre => pre.name === post.name));
        const allEvents = [...this.report.events.preConsent, ...this.report.events.postConsent, ...this.report.events.interactions, ...this.report.events.formTest];
        this.report.summary = {
            violations: this.report.violations.length,
            trackersPostConsent: this.report.postConsent.requests.length,
            cookiesPreConsent: this.report.preConsent.cookies.length,
            cookiesPostConsent: this.report.postConsent.cookies.length,
            newCookiesAfterConsent: newCookies.length,
            cmpWorking: this.report.cmp.detected && this.report.violations.length === 0,
            blockedScriptsCount: this.report.cmp.blockedScripts?.length || 0,
            events: { total: allEvents.length, uniqueEvents: [...new Set(allEvents.map(e => `${e.tracker}: ${e.event}`))] },
            formsFound: this.report.forms.found.length,
            errors: this.report.errors.length
        };
    }
}

module.exports = Scanner;
