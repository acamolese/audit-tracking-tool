const { chromium } = require('playwright');

// === HEADLESS FORM TEST SESSION (per Railway) ===
class HeadlessFormTestSession {
    constructor(url, sessionId) {
        this.url = url;
        this.sessionId = sessionId;
        this.browser = null;
        this.page = null;
        this.events = [];
        this.sseClients = [];
        this.isRunning = false;
        this.startTime = Date.now();
        this.actionsLog = [];
    }

    async start() {
        try {
            this.browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });

            this.page = await context.newPage();
            this.isRunning = true;

            // Intercetta richieste di rete
            this.page.on('request', (request) => this.handleRequest(request));

            // Monitor dataLayer
            await this.setupDataLayerMonitor();

            // Naviga alla pagina
            await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Attendi caricamento completo
            await this.page.waitForTimeout(2000);

            this.sendEvent({ type: 'session_started', url: this.url, mode: 'headless' });
            this.logAction('Pagina caricata');
            console.log(`[HeadlessFormTest] Sessione ${this.sessionId} avviata per ${this.url}`);

            return true;
        } catch (error) {
            console.error(`[HeadlessFormTest] Errore avvio:`, error);
            this.sendEvent({ type: 'error', message: error.message });
            return false;
        }
    }

    async setupDataLayerMonitor() {
        await this.page.exposeFunction('__attDataLayerPush', (data) => {
            this.sendEvent({
                type: 'dataLayer',
                data: data,
                timestamp: Date.now()
            });
        });

        await this.page.addInitScript(() => {
            const checkDataLayer = () => {
                if (!window.dataLayer) window.dataLayer = [];
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
            timestamp: Date.now()
        });
    }

    identifyTracker(url) {
        const u = url.toLowerCase();
        if (u.includes('facebook.com/tr')) return 'Facebook Pixel';
        if (u.includes('connect.facebook.net') && u.includes('fbevents')) return 'Facebook SDK';
        if (u.includes('google-analytics.com/g/collect') || u.includes('analytics.google.com/g/collect')) return 'GA4';
        if (u.includes('googletagmanager.com/gtm.js') || u.includes('googletagmanager.com/gtag/js')) return 'GTM';
        if (u.includes('googleadservices.com') || u.includes('doubleclick.net')) return 'Google Ads';
        if (u.includes('clarity.ms')) return 'Clarity';
        if (u.includes('bat.bing.com')) return 'Bing Ads';
        if (u.includes('linkedin.com/px') || u.includes('snap.licdn.com')) return 'LinkedIn Insight';
        if (u.includes('analytics.tiktok.com')) return 'TikTok Pixel';
        if (u.includes('hotjar.com')) return 'Hotjar';
        if (u.includes('cookiebot.com')) return 'Cookiebot';
        if (u.includes('onetrust.com')) return 'OneTrust';
        if (u.includes('iubenda.com')) return 'iubenda';
        return null;
    }

    extractDetails(url, tracker, postData) {
        const details = { event: null, eventCategory: 'custom' };
        try {
            const urlObj = new URL(url);
            if (tracker === 'Facebook Pixel') {
                details.event = urlObj.searchParams.get('ev');
                const standardEvents = ['PageView', 'ViewContent', 'AddToCart', 'Purchase', 'Lead', 'CompleteRegistration'];
                details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
            }
            if (tracker === 'GA4') {
                details.event = urlObj.searchParams.get('en');
                if (!details.event && postData) {
                    const match = postData.match(/en=([^&]+)/);
                    if (match) details.event = decodeURIComponent(match[1]);
                }
                const standardEvents = ['page_view', 'scroll', 'click', 'view_item', 'purchase', 'generate_lead'];
                details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
            }
            if (tracker === 'Clarity') {
                details.event = 'Recording';
                details.eventCategory = 'session';
            }
        } catch (e) { }
        return details;
    }

    sendEvent(event) {
        event.sessionId = this.sessionId;
        event.timestamp = event.timestamp || Date.now();
        this.events.push(event);

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

    logAction(action) {
        const logEntry = { action, timestamp: Date.now() };
        this.actionsLog.push(logEntry);
        this.sendEvent({ type: 'action', action, timestamp: Date.now() });
    }

    addSSEClient(res) {
        this.sseClients.push(res);
        res.on('close', () => {
            this.sseClients = this.sseClients.filter(c => c !== res);
        });
        this.events.forEach(event => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
    }

    // === AZIONI PREDEFINITE ===
    async executeAction(actionName, params = {}) {
        if (!this.isRunning || !this.page) {
            return { success: false, error: 'Sessione non attiva' };
        }

        try {
            switch (actionName) {
                case 'scroll':
                    return await this.actionScroll(params);
                case 'scrollToBottom':
                    return await this.actionScrollToBottom();
                case 'acceptCookies':
                    return await this.actionAcceptCookies();
                case 'click':
                    return await this.actionClick(params);
                case 'getForms':
                    return await this.actionGetForms();
                case 'fillForm':
                    return await this.actionFillForm(params);
                case 'submitForm':
                    return await this.actionSubmitForm(params);
                case 'wait':
                    return await this.actionWait(params);
                case 'screenshot':
                    return await this.actionScreenshot();
                default:
                    return { success: false, error: `Azione '${actionName}' non supportata` };
            }
        } catch (error) {
            this.logAction(`Errore: ${actionName} - ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async actionScroll(params) {
        const amount = params.amount || 500;
        await this.page.evaluate((scrollAmount) => {
            window.scrollBy(0, scrollAmount);
        }, amount);
        this.logAction(`Scroll ${amount}px`);
        await this.page.waitForTimeout(500);
        return { success: true, message: `Scrollato di ${amount}px` };
    }

    async actionScrollToBottom() {
        await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        this.logAction('Scroll fino in fondo');
        await this.page.waitForTimeout(1000);
        return { success: true, message: 'Scrollato fino in fondo alla pagina' };
    }

    async actionAcceptCookies() {
        const selectors = [
            // Cookiebot
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
            '#CybotCookiebotDialogBodyButtonAccept',
            'button[data-cookieconsent="accept"]',
            // OneTrust
            '#onetrust-accept-btn-handler',
            '.onetrust-close-btn-handler',
            // iubenda
            '.iubenda-cs-accept-btn',
            // Generic
            'button[id*="accept"]',
            'button[class*="accept"]',
            'a[id*="accept"]',
            '[data-action="accept"]',
            '.cookie-accept',
            '#cookie-accept',
            'button:has-text("Accetta")',
            'button:has-text("Accept")',
            'button:has-text("Accetto")',
            'button:has-text("OK")',
        ];

        for (const selector of selectors) {
            try {
                const btn = await this.page.$(selector);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    this.logAction(`Cookie accettati (${selector})`);
                    await this.page.waitForTimeout(1000);
                    return { success: true, message: `Cookie accettati tramite: ${selector}` };
                }
            } catch (e) { }
        }

        this.logAction('Nessun banner cookie trovato');
        return { success: false, error: 'Nessun banner cookie trovato' };
    }

    async actionClick(params) {
        const { selector } = params;
        if (!selector) {
            return { success: false, error: 'Selettore richiesto' };
        }

        const element = await this.page.$(selector);
        if (!element) {
            return { success: false, error: `Elemento non trovato: ${selector}` };
        }

        await element.click();
        this.logAction(`Click su ${selector}`);
        await this.page.waitForTimeout(500);
        return { success: true, message: `Click eseguito su ${selector}` };
    }

    async actionGetForms() {
        const forms = await this.page.evaluate(() => {
            const formElements = document.querySelectorAll('form');
            return Array.from(formElements).map((form, index) => {
                const hasNameField = !!form.querySelector('input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i], input[placeholder*="name" i]');
                const hasSurnameField = !!form.querySelector('input[name*="surname" i], input[name*="cognome" i], input[placeholder*="cognome" i], input[placeholder*="surname" i]');
                const hasEmailField = !!form.querySelector('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');
                const hasPasswordField = !!form.querySelector('input[type="password"]');
                const hasSearchField = !!form.querySelector('input[type="search"], input[name*="search" i], input[name*="query" i], input[name*="q" i]');
                const hasPhoneField = !!form.querySelector('input[type="tel"], input[name*="phone" i], input[name*="telefono" i]');

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

                // Genera selettore per questo form
                let selector = 'form';
                if (form.id) {
                    selector = `form#${form.id}`;
                } else if (form.className) {
                    const firstClass = form.className.split(' ')[0];
                    if (firstClass) selector = `form.${firstClass}`;
                } else {
                    selector = `form:nth-of-type(${index + 1})`;
                }

                return {
                    index,
                    selector,
                    id: form.id || null,
                    className: form.className?.substring(0, 50) || null,
                    formType,
                    isVisible,
                    submitText,
                    fieldLabels,
                    hasEmailField,
                    hasNameField,
                    hasSurnameField,
                    hasPasswordField
                };
            });
        });

        this.logAction(`Trovati ${forms.length} form`);
        return { success: true, forms };
    }

    async actionFillForm(params) {
        const { formSelector, fields } = params;
        const formSel = formSelector || 'form';

        const form = await this.page.$(formSel);
        if (!form) {
            return { success: false, error: 'Form non trovato' };
        }

        // Dati di test predefiniti
        const testData = fields || {
            'input[type="email"]': 'test@example.com',
            'input[type="text"][name*="name"]': 'Test User',
            'input[type="text"][name*="nome"]': 'Test User',
            'input[type="tel"]': '+39 123 456 7890',
            'textarea': 'Questo è un messaggio di test generato automaticamente.',
            'input[type="text"]': 'Test input'
        };

        let filledCount = 0;
        for (const [selector, value] of Object.entries(testData)) {
            try {
                const input = await this.page.$(`${formSel} ${selector}`);
                if (input && await input.isVisible()) {
                    await input.fill(value);
                    filledCount++;
                }
            } catch (e) { }
        }

        this.logAction(`Form compilato (${filledCount} campi)`);
        return { success: true, message: `Compilati ${filledCount} campi` };
    }

    async actionSubmitForm(params) {
        const { formSelector } = params;
        const formSel = formSelector || 'form';

        const submitBtn = await this.page.$(`${formSel} button[type="submit"], ${formSel} input[type="submit"], ${formSel} button:not([type])`);
        if (submitBtn) {
            await submitBtn.click();
            this.logAction('Form inviato (click submit)');
        } else {
            await this.page.$eval(formSel, form => form.submit());
            this.logAction('Form inviato (submit())');
        }

        await this.page.waitForTimeout(2000);
        return { success: true, message: 'Form inviato' };
    }

    async actionWait(params) {
        const ms = params.ms || 2000;
        await this.page.waitForTimeout(ms);
        this.logAction(`Atteso ${ms}ms`);
        return { success: true, message: `Atteso ${ms}ms` };
    }

    async actionScreenshot() {
        const screenshot = await this.page.screenshot({ encoding: 'base64' });
        this.logAction('Screenshot catturato');
        return { success: true, screenshot: `data:image/png;base64,${screenshot}` };
    }

    async stop() {
        this.isRunning = false;
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        this.sendEvent({ type: 'session_stopped' });
        console.log(`[HeadlessFormTest] Sessione ${this.sessionId} terminata`);
    }
}

module.exports = HeadlessFormTestSession;
