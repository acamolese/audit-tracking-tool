const { chromium } = require('playwright');
const { IS_HEADLESS_SERVER } = require('../../config/config');

// === FORM TEST LIVE SESSION ===
class FormTestSession {
    constructor(url, sessionId) {
        this.url = url;
        this.sessionId = sessionId;
        this.browser = null;
        this.page = null;
        this.events = [];
        this.sseClients = [];
        this.isRunning = false;
        this.startTime = Date.now();
    }

    async start() {
        // Check if Live Monitor is available on this environment
        if (IS_HEADLESS_SERVER) {
            throw new Error('LIVE_MONITOR_NOT_AVAILABLE: Il Live Monitor richiede un ambiente con display grafico. Questa funzione è disponibile solo in locale.');
        }

        try {
            this.browser = await chromium.launch({
                headless: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });

            this.page = await context.newPage();
            this.isRunning = true;

            // Intercetta TUTTE le richieste di rete (come scanner.js)
            this.page.on('request', (request) => this.handleRequest(request));

            // Monitor dataLayer via CDP
            await this.setupDataLayerMonitor();

            // Naviga alla pagina
            await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            this.sendEvent({ type: 'session_started', url: this.url });
            console.log(`[FormTest] Sessione ${this.sessionId} avviata per ${this.url}`);

            return true;
        } catch (error) {
            console.error(`[FormTest] Errore avvio sessione:`, error);
            this.sendEvent({ type: 'error', message: error.message });
            return false;
        }
    }

    async setupDataLayerMonitor() {
        // Inietta script per monitorare dataLayer
        await this.page.exposeFunction('__attDataLayerPush', (data) => {
            this.sendEvent({
                type: 'dataLayer',
                data: data,
                timestamp: Date.now()
            });
        });

        await this.page.addInitScript(() => {
            const checkDataLayer = () => {
                if (!window.dataLayer) {
                    window.dataLayer = [];
                }
                if (!window.dataLayer.__attMonitored) {
                    const original = window.dataLayer.push.bind(window.dataLayer);
                    window.dataLayer.push = function (...args) {
                        args.forEach(item => {
                            if (item && typeof item === 'object' && item.event) {
                                window.__attDataLayerPush({ event: item.event, data: item });
                            }
                        });
                        return original(...args);
                    };
                    window.dataLayer.__attMonitored = true;
                    // Processa eventi esistenti
                    window.dataLayer.forEach(item => {
                        if (item && typeof item === 'object' && item.event) {
                            window.__attDataLayerPush({ event: item.event, data: item });
                        }
                    });
                }
            };
            checkDataLayer();
            setInterval(checkDataLayer, 100);
        });
    }

    handleRequest(request) {
        const url = request.url();
        const tracker = this.identifyTracker(url);

        if (!tracker) return;

        const postData = request.postData();
        const details = this.extractDetails(url, tracker, postData);

        this.sendEvent({
            type: 'network',
            tracker: tracker,
            url: url,
            event: details.event,
            eventCategory: details.eventCategory,
            params: details.params,
            timestamp: Date.now()
        });
    }

    identifyTracker(url) {
        const u = url.toLowerCase();

        // Facebook Pixel
        if (u.includes('facebook.com/tr')) return 'Facebook Pixel';
        if (u.includes('connect.facebook.net') && u.includes('fbevents')) return 'Facebook SDK';

        // Google
        if (u.includes('google-analytics.com/g/collect') || u.includes('analytics.google.com/g/collect')) return 'GA4';
        if (u.includes('google-analytics.com') && !u.includes('/g/collect')) return 'GA4';
        if (u.includes('googletagmanager.com/gtm.js')) return 'GTM';
        if (u.includes('googletagmanager.com/gtag/js')) return 'GTM';
        if (u.includes('googleadservices.com') || u.includes('googlesyndication.com')) return 'Google Ads';
        if (u.includes('doubleclick.net')) return 'Google Ads';

        // Microsoft
        if (u.includes('clarity.ms')) return 'Clarity';
        if (u.includes('bat.bing.com')) return 'Bing Ads';

        // Social
        if (u.includes('linkedin.com/px') || u.includes('snap.licdn.com')) return 'LinkedIn Insight';
        if (u.includes('analytics.tiktok.com')) return 'TikTok Pixel';

        // Altri
        if (u.includes('hotjar.com')) return 'Hotjar';
        if (u.includes('criteo.com') || u.includes('criteo.net')) return 'Criteo';

        // CMP
        if (u.includes('cookiebot.com') || u.includes('consentcdn.cookiebot.com')) return 'Cookiebot';
        if (u.includes('onetrust.com') || u.includes('cookielaw.org')) return 'OneTrust';
        if (u.includes('iubenda.com')) return 'iubenda';

        return null;
    }

    extractDetails(url, tracker, postData) {
        const details = { event: null, eventCategory: 'custom', params: {} };

        try {
            const urlObj = new URL(url);

            // Facebook Pixel
            if (tracker === 'Facebook Pixel') {
                details.event = urlObj.searchParams.get('ev');
                const standardEvents = ['PageView', 'ViewContent', 'AddToCart', 'Purchase', 'Lead', 'CompleteRegistration'];
                details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
            }

            // GA4
            if (tracker === 'GA4') {
                details.event = urlObj.searchParams.get('en');
                if (!details.event && postData) {
                    const match = postData.match(/en=([^&]+)/);
                    if (match) details.event = decodeURIComponent(match[1]);
                }
                const standardEvents = ['page_view', 'scroll', 'click', 'view_item', 'purchase', 'generate_lead'];
                details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
            }

            // Clarity
            if (tracker === 'Clarity') {
                details.event = 'Recording';
                details.eventCategory = 'session';
            }

        } catch (e) {
            // Ignore parsing errors
        }

        return details;
    }

    sendEvent(event) {
        event.sessionId = this.sessionId;
        event.timestamp = event.timestamp || Date.now();
        this.events.push(event);

        // Invia a tutti i client SSE
        const message = `data: ${JSON.stringify(event)}\n\n`;
        this.sseClients = this.sseClients.filter(client => {
            try {
                client.write(message);
                return true;
            } catch (e) {
                return false;
            }
        });
    }

    addSSEClient(res) {
        this.sseClients.push(res);
        res.on('close', () => {
            this.sseClients = this.sseClients.filter(c => c !== res);
        });

        // Invia eventi precedenti
        this.events.forEach(event => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
    }

    async stop() {
        this.isRunning = false;
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        this.sendEvent({ type: 'session_stopped' });
        console.log(`[FormTest] Sessione ${this.sessionId} terminata`);
    }
}

module.exports = FormTestSession;
