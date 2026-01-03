const { chromium } = require('playwright');

// === CONFIGURAZIONE BROWSER (anti bot-detection) ===
const BROWSER_CONFIG = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'it-IT',
  timezoneId: 'Europe/Rome',
  // Evita detection headless
  extraHTTPHeaders: {
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
  }
};

// === CONFIGURAZIONE TRACKER ===
const TRACKER_PATTERNS = {
  // Google (inclusi sottodomini regionali come region1.google-analytics.com)
  'GA4': /google-analytics\.com\/g\/collect|analytics\.google\.com\/g\/collect/i,
  'Google Ads': /googleadservices\.com|googlesyndication\.com|googleads\.g\.doubleclick\.net/i,
  'GTM Container': /googletagmanager\.com\/gtm\.js/i,
  'GTM Collect': /googletagmanager\.com\/.*collect/i,

  // Meta/Facebook
  'Facebook Pixel': /facebook\.com\/tr/i,
  'Facebook SDK': /connect\.facebook\.net/i,

  // Microsoft
  'Clarity': /clarity\.ms/i,
  'Bing Ads': /bat\.bing\.com/i,

  // LinkedIn
  'LinkedIn Insight': /snap\.licdn\.com|linkedin\.com\/px/i,

  // TikTok
  'TikTok Pixel': /analytics\.tiktok\.com|tiktok\.com\/i18n\/pixel/i,

  // Altri comuni
  'Hotjar': /hotjar\.com|static\.hotjar\.com/i,
  'Pinterest': /pintrk|ct\.pinterest\.com/i,
  'Twitter/X': /ads-twitter\.com|t\.co\/i\/adsct|analytics\.twitter\.com/i,
  'Criteo': /criteo\.com|criteo\.net/i,
  'Taboola': /taboola\.com|trc\.taboola\.com/i,
  'Outbrain': /outbrain\.com/i,
  'Yahoo/Verizon': /analytics\.yahoo\.com|ads\.yahoo\.com/i,
  'Snapchat': /sc-static\.net\/scevent|tr\.snapchat\.com/i,
  'Reddit': /redditmedia\.com|reddit\.com\/rpixel/i,
  'Hubspot': /js\.hs-scripts\.com|track\.hubspot\.com/i,
  'Salesforce/Pardot': /pardot\.com|salesforce\.com\/track/i,
  'Adobe Analytics': /omtrdc\.net|demdex\.net|2o7\.net/i,
  'Segment': /cdn\.segment\.com|api\.segment\.io/i,
  'Mixpanel': /mixpanel\.com/i,
  'Amplitude': /amplitude\.com|cdn\.amplitude\.com/i,
  'Heap': /heap-analytics|heapanalytics\.com/i,
  'FullStory': /fullstory\.com|rs\.fullstory\.com/i,
  'Intercom': /intercom\.io|widget\.intercom\.io/i,
  'Drift': /drift\.com|js\.driftt\.com/i,
  'Cookiebot': /cookiebot\.com|consentcdn\.cookiebot\.com/i,
  'OneTrust': /onetrust\.com|cdn\.cookielaw\.org/i,
  'iubenda': /iubenda\.com/i,
  'Quantcast': /quantcast\.com|quantserve\.com/i,
};

// Pattern per Google Consent Mode
const GOOGLE_CONSENT_PATTERNS = {
  'gcs': { // Consent State
    'G100': 'denied',
    'G110': 'analytics_only',
    'G101': 'ads_only',
    'G111': 'granted',
    'G1--': 'not_set'
  }
};

// Eventi GA4 standard da monitorare
const GA4_STANDARD_EVENTS = [
  'page_view',
  'scroll',
  'click',
  'form_start',
  'form_submit',
  'generate_lead',
  'view_item',
  'view_item_list',
  'add_to_cart',
  'remove_from_cart',
  'begin_checkout',
  'purchase',
  'user_engagement',
  'session_start',
  'first_visit'
];

// === CLASSE PRINCIPALE SCANNER ===
class CookieAuditScanner {
  constructor(url, options = {}) {
    this.url = url;
    this.options = {
      headless: options.headless !== false,
      timeout: options.timeout || 10000,
      outputFile: options.outputFile || null,
      verbose: options.verbose || false,
      ...options
    };

    this.report = {
      url: url,
      timestamp: new Date().toISOString(),
      cmp: {
        detected: false,
        type: null,  // 'cookiebot', 'iubenda', 'onetrust', etc.
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
        interactions: []  // Eventi triggerati da interazioni simulate
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

      // Facebook Pixel: estrai evento e parametri
      if (trackerName === 'Facebook Pixel') {
        const eventName = urlObj.searchParams.get('ev');
        if (eventName) {
          details.event = eventName;
          // Categorizza evento
          const fbStandardEvents = ['PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration', 'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'Schedule', 'StartTrial', 'SubmitApplication', 'Subscribe'];
          details.eventCategory = fbStandardEvents.includes(eventName) ? 'standard' : 'custom';
        }
        const pixelId = urlObj.searchParams.get('id');
        if (pixelId) details.pixelId = pixelId;
        // URL destinazione (utile per click)
        const dl = urlObj.searchParams.get('dl');
        if (dl) details.destinationUrl = decodeURIComponent(dl);
        // Contenuto custom data
        const cd = urlObj.searchParams.get('cd');
        if (cd) {
          try {
            details.customData = JSON.parse(decodeURIComponent(cd));
          } catch (e) {}
        }
      }

      // LinkedIn Insight: estrai evento
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

      // TikTok Pixel: estrai evento
      if (trackerName === 'TikTok Pixel') {
        const eventName = urlObj.searchParams.get('event');
        if (eventName) {
          details.event = eventName;
          const ttStandardEvents = ['ViewContent', 'ClickButton', 'Search', 'AddToWishlist', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'CompletePayment', 'PlaceAnOrder', 'Contact', 'Download', 'SubmitForm', 'Subscribe'];
          details.eventCategory = ttStandardEvents.includes(eventName) ? 'standard' : 'custom';
        }
      }

      // Pinterest: estrai evento
      if (trackerName === 'Pinterest') {
        const eventName = urlObj.searchParams.get('event') || urlObj.searchParams.get('ed');
        if (eventName) {
          details.event = eventName;
          details.eventCategory = 'custom';
        }
      }

      // Twitter/X: estrai evento
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

      // Hotjar: identifica tipo di tracciamento
      if (trackerName === 'Hotjar') {
        details.event = 'Recording';
        details.eventCategory = 'session';
      }

      // Clarity: identifica tipo di tracciamento
      if (trackerName === 'Clarity') {
        details.event = 'Recording';
        details.eventCategory = 'session';
      }

      // Google: estrai consent state
      if (trackerName?.startsWith('GA') || trackerName?.startsWith('Google')) {
        const gcs = urlObj.searchParams.get('gcs');
        if (gcs) {
          details.gcsRaw = gcs; // Codice originale (es. G101)
          details.consentMode = GOOGLE_CONSENT_PATTERNS.gcs[gcs] || gcs;
        }
        const gcd = urlObj.searchParams.get('gcd');
        if (gcd) details.gcd = gcd;
      }

      // GA4: estrai evento e parametri (da URL o POST body)
      if (trackerName === 'GA4') {
        // Prima prova dall'URL
        let en = urlObj.searchParams.get('en');

        // Se non trovato in URL, cerca nel POST body
        if (!en && postData) {
          const events = this.parseGA4PostBody(postData);
          if (events.length > 0) {
            details.events = events; // Array di tutti gli eventi nel body
            en = events[0]; // Primo evento come principale
          }
        }

        if (en) {
          details.event = en;
          details.isStandardEvent = GA4_STANDARD_EVENTS.includes(en);
          // Categorizza evento
          if (GA4_STANDARD_EVENTS.includes(en)) {
            details.eventCategory = 'standard';
          } else if (en.startsWith('click_') || en.startsWith('cta_')) {
            details.eventCategory = 'click';
          } else {
            details.eventCategory = 'custom';
          }
        }

        // Parametri evento (ep.*)
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
      // URL parsing failed
    }

    return details;
  }

  // Parsing del POST body GA4 per estrarre eventi multipli
  parseGA4PostBody(postData) {
    const events = [];
    if (!postData) return events;

    try {
      // Il body può contenere più righe separate da \r\n
      // Formato: en=scroll&_et=2168\r\nen=page_view\r\n...
      const lines = postData.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;

        // Cerca en= all'inizio della riga o dopo &
        const matches = line.match(/(?:^|&)en=([^&\r\n]+)/g);
        if (matches) {
          for (const match of matches) {
            const eventName = match.replace(/^&?en=/, '');
            if (eventName && !events.includes(eventName)) {
              events.push(eventName);
            }
          }
        }
      }
    } catch (e) {
      // Parsing failed
    }

    return events;
  }

  // Traccia evento da qualsiasi tracker (GA4, Facebook, LinkedIn, ecc.)
  trackEvent(details, phase) {
    const eventData = {
      tracker: details.tracker || 'unknown',
      event: details.event || 'unknown',
      eventCategory: details.eventCategory || 'unknown',
      consentMode: details.consentMode || null,
      timestamp: new Date().toISOString(),
      phase: phase,
      isStandard: details.isStandardEvent || false,
      pixelId: details.pixelId || null,
      // Parametri aggiuntivi
      destinationUrl: details.destinationUrl || null,
      pageTitle: details.pageTitle || null,
      pageUrl: details.pageUrl || null,
      params: details.params || null,
      productName: details.productName || null,
      productPrice: details.productPrice || null,
      customData: details.customData || null
    };

    // Rimuovi campi null per pulizia
    Object.keys(eventData).forEach(key => {
      if (eventData[key] === null) delete eventData[key];
    });

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

    // Ottieni POST body
    const postData = request.postData();
    const details = this.extractRequestDetails(url, trackerName, postData);
    const isLibraryLoad = ['GTM Container', 'Facebook SDK', 'Cookiebot', 'OneTrust', 'iubenda'].includes(trackerName);
    const isGoogleDenied = this.isGoogleDeniedMode(url);

    // Traccia eventi da tutti i tracker (GA4, Facebook, LinkedIn, ecc.)
    if (details.event) {
      // GA4: può avere eventi multipli nel body POST
      if (trackerName === 'GA4' && details.events && details.events.length > 0) {
        for (const eventName of details.events) {
          // Ricalcola categoria per ogni evento
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
          this.log(`   [EVENT] ${trackerName}: ${eventName} (${details.consentMode || 'N/A'})`);
        }
      } else {
        // Tutti gli altri tracker (Facebook, LinkedIn, TikTok, ecc.)
        this.trackEvent(details, this.phase);
        this.log(`   [EVENT] ${trackerName}: ${details.event}`);
      }
    }

    if (this.phase === 'PRE_CONSENT') {
      if (isGoogleDenied) {
        // Google in denied mode - ping tecnico
        this.report.technicalPings.push({ ...details, reason: 'Google Consent Mode Denied' });
        this.log(`   [TECNICO] ${trackerName} (Consent Mode: denied)`);
      } else if (isLibraryLoad) {
        // Caricamento libreria - tecnico ma da segnalare
        this.report.technicalPings.push({ ...details, reason: 'Library/CMP Load' });
        this.log(`   [TECNICO] Caricamento: ${trackerName}`);
      } else {
        // VIOLAZIONE
        this.report.preConsent.requests.push(details);
        this.report.violations.push({
          type: 'tracking_before_consent',
          tracker: trackerName,
          details: details
        });
        this.log(`   [VIOLAZIONE] ${trackerName} attivo SENZA consenso!`, 'warn');
      }
    } else {
      // Post consenso - tutto ok
      this.report.postConsent.requests.push(details);
      this.log(`   [OK] ${trackerName} attivo dopo consenso`);
    }
  }

  // Raccoglie i cookie correnti
  async collectCookies() {
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
  }

  // Raccoglie LocalStorage e SessionStorage
  async collectStorage() {
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
  }

  // Verifica stato CMP (Cookiebot, iubenda, OneTrust, etc.)
  async checkCMPState() {
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
        // iubenda consent state
        const consent = cs.consent || {};
        return {
          detected: true,
          type: 'iubenda',
          loaded: true,
          consent: {
            necessary: true, // sempre true
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
          consent: null, // OneTrust ha struttura diversa
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

      return { detected: false, type: null };
    });
  }

  // Verifica script bloccati (type="text/plain")
  async checkBlockedScripts() {
    return await this.page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="text/plain"]');
      return Array.from(scripts).map(s => ({
        src: s.src || '(inline)',
        dataCookieconsent: s.getAttribute('data-cookieconsent')
      }));
    });
  }

  // Cerca e clicca il banner di consenso
  async acceptCookies() {
    // Selettori comuni per vari CMP
    const selectors = [
      // Cookiebot
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
      '[data-cookiebanner="accept_button"]',
      // iubenda
      '.iubenda-cs-accept-btn',
      '.iubenda-cs-btn-primary',
      '#iubenda-cs-banner .iubenda-cs-accept-btn',
      'button.iub-btn-consent',
      '[data-iub-action="accept"]',
      // OneTrust
      '#onetrust-accept-btn-handler',
      '.onetrust-close-btn-handler',
      // Didomi
      '#didomi-notice-agree-button',
      '[data-testid="notice-accept-button"]',
      // Generici
      '[data-action="accept"]',
      'button[aria-label*="Accept"]',
      'button[aria-label*="Accetta"]',
      '.cookie-accept',
      '#cookie-accept',
      'button:has-text("Accetta tutti")',
      'button:has-text("Accept all")',
    ];

    for (const selector of selectors) {
      try {
        const button = await this.page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          this.log(`Click su banner consenso: ${selector}`);
          return true;
        }
      } catch (e) {
        // Selettore non trovato, prova il prossimo
      }
    }

    return false;
  }

  // Log condizionale
  log(message, level = 'info') {
    const icons = {
      info: 'i',
      warn: '!',
      error: 'X',
      success: '+'
    };
    console.log(`[${icons[level]}] ${message}`);
  }

  // Simula scroll per triggerare evento scroll (GA4 triggera a 90%)
  async simulateScroll() {
    this.log('Simulazione scroll...');

    // Scroll graduale per simulare comportamento utente
    await this.page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight * 0.3, behavior: 'smooth' });
    });
    await this.page.waitForTimeout(800);

    await this.page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight * 0.6, behavior: 'smooth' });
    });
    await this.page.waitForTimeout(800);

    // Scroll oltre 90% - questo triggera l'evento scroll di GA4
    await this.page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight * 0.95, behavior: 'smooth' });
    });
    // Attesa più lunga per permettere a GA4 di rilevare la posizione
    await this.page.waitForTimeout(2000);

    // Scroll fino in fondo
    await this.page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
    await this.page.waitForTimeout(1500);

    // Torna su
    await this.page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await this.page.waitForTimeout(1000);
  }

  // Simula click su elementi per triggerare eventi click (inclusi custom)
  async simulateClicks() {
    this.log('Simulazione click...');

    // Selettori per elementi tipicamente tracciati
    const trackableSelectors = [
      // Link social e contatti
      'a[href*="whatsapp"]',
      'a[href*="wa.me"]',
      'a[href^="tel:"]',
      'a[href^="mailto:"]',
      // Elementi con data attributes GTM/GA
      '[data-gtm-click]',
      '[data-ga-click]',
      '[data-track]',
      '[data-event]',
      // CTA e bottoni comuni
      '.cta',
      '[class*="cta"]',
      '.btn-primary',
      '.btn-cta',
      // Link interni e bottoni
      'a[href^="#"]',
      'button:not([type="submit"])',
      // Social icons
      'a[href*="facebook"]',
      'a[href*="instagram"]',
      'a[href*="linkedin"]',
      'a[href*="twitter"]',
      // Elementi con onclick
      '[onclick]'
    ];

    const selector = trackableSelectors.join(', ');
    const elements = await this.page.$$(selector);

    this.log(`   Trovati ${elements.length} elementi cliccabili`);

    let clicked = 0;
    for (const element of elements) {
      if (clicked >= 10) break; // Max 10 click

      try {
        if (await element.isVisible()) {
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          const href = await element.evaluate(el => el.getAttribute('href') || '');

          // Evita navigazione esterna
          if (href && !href.startsWith('#') && !href.startsWith('tel:') && !href.startsWith('mailto:') && !href.includes('whatsapp') && !href.includes('wa.me')) {
            // Link esterno - previeni navigazione
            await element.evaluate(el => {
              el.addEventListener('click', e => e.preventDefault(), { once: true });
            });
          }

          await element.click({ force: true, noWaitAfter: true });
          clicked++;
          await this.page.waitForTimeout(500);
        }
      } catch (e) {
        // Ignora errori click
      }
    }

    this.log(`   Click effettuati: ${clicked}`);
  }

  // Trova form nella pagina
  async findForms() {
    const forms = await this.page.evaluate(() => {
      const formElements = document.querySelectorAll('form');
      return Array.from(formElements).map((form, index) => {
        // Cerca campi nome, cognome, email
        const hasNameField = !!form.querySelector('input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i], input[placeholder*="name" i]');
        const hasSurnameField = !!form.querySelector('input[name*="surname" i], input[name*="cognome" i], input[placeholder*="cognome" i], input[placeholder*="surname" i]');
        const hasEmailField = !!form.querySelector('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');

        // Form valido se ha almeno uno di questi campi
        const isValid = hasNameField || hasSurnameField || hasEmailField;

        return {
          index,
          id: form.id || null,
          action: form.action || null,
          hasNameField,
          hasSurnameField,
          hasEmailField,
          isValid
        };
      });
    });

    // Filtra solo form validi
    const validForms = forms.filter(f => f.isValid);
    this.report.forms.found = validForms;
    this.log(`Form trovati: ${forms.length} (validi: ${validForms.length})`);
    return validForms;
  }

  // Interagisce con un form valido (focus su campi per triggerare form_start)
  async interactWithForm() {
    if (this.report.forms.found.length === 0) {
      this.log('   Nessun form valido trovato', 'warn');
      return false;
    }

    this.log(`Interazione con form valido...`);

    try {
      // Selettori per campi nome/cognome/email
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
              this.log('   Form interaction completata');
              return true;
            }
          } catch (e) {
            continue;
          }
        }
      }
      this.log('   Nessun campo form visibile', 'warn');
    } catch (e) {
      this.log(`   Errore: ${e.message}`, 'warn');
    }
    return false;
  }

  // Compila e invia un form di contatto (per testare generate_lead)
  async submitContactForm() {
    this.log('Tentativo invio form contatto...');

    // Trova un form di contatto
    const contactForm = this.report.forms.found.find(f => f.isContactForm);
    if (!contactForm) {
      this.log('   Nessun form di contatto trovato', 'warn');
      return false;
    }

    try {
      const formSelector = contactForm.id
        ? `#${contactForm.id}`
        : `form:nth-of-type(${contactForm.index + 1})`;

      // Compila campi email
      const emailField = await this.page.$(`${formSelector} input[type="email"], ${formSelector} input[name*="email"]`);
      if (emailField) {
        await emailField.fill('test@test-audit.com');
      }

      // Compila campo nome se presente
      const nameField = await this.page.$(`${formSelector} input[name*="name"], ${formSelector} input[name*="nome"]`);
      if (nameField) {
        await nameField.fill('Test Audit');
      }

      // Compila campo telefono se presente
      const phoneField = await this.page.$(`${formSelector} input[type="tel"], ${formSelector} input[name*="phone"], ${formSelector} input[name*="telefono"]`);
      if (phoneField) {
        await phoneField.fill('+39123456789');
      }

      // Compila textarea se presente
      const textarea = await this.page.$(`${formSelector} textarea`);
      if (textarea) {
        await textarea.fill('Test audit automatico cookie');
      }

      // Accetta checkbox privacy se presente
      const privacyCheckbox = await this.page.$(`${formSelector} input[type="checkbox"]`);
      if (privacyCheckbox) {
        await privacyCheckbox.check();
      }

      await this.page.waitForTimeout(500);

      // Invia form
      const submitBtn = await this.page.$(`${formSelector} button[type="submit"], ${formSelector} input[type="submit"]`);
      if (submitBtn) {
        this.log('   Invio form...');
        await submitBtn.click();
        await this.page.waitForTimeout(3000);

        this.report.forms.submitted = {
          formIndex: contactForm.index,
          timestamp: new Date().toISOString(),
          success: true
        };

        this.log('   Form inviato', 'success');
        return true;
      }
    } catch (e) {
      this.log(`   Errore invio form: ${e.message}`, 'warn');
      this.report.forms.submitted = {
        formIndex: contactForm?.index,
        timestamp: new Date().toISOString(),
        success: false,
        error: e.message
      };
    }

    return false;
  }

  // Esecuzione principale
  async run() {
    console.log(`\n=== COOKIE AUDIT SCANNER ===`);
    console.log(`URL: ${this.url}`);
    console.log(`Timestamp: ${this.report.timestamp}\n`);

    try {
      // Avvia browser con configurazione anti bot-detection
      // Args necessari per ambiente cloud/container (Render, Docker, etc.)
      this.browser = await chromium.launch({
        headless: this.options.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
          '--no-zygote'
        ]
      });
      const context = await this.browser.newContext(BROWSER_CONFIG);
      this.page = await context.newPage();

      // Registra handler richieste
      this.page.on('request', (req) => this.handleRequest(req));

      // === FASE 1: PRE-CONSENSO ===
      console.log('--- FASE 1: Analisi PRE-CONSENSO ---');
      this.phase = 'PRE_CONSENT';

      await this.page.goto(this.url, {
        waitUntil: 'networkidle',
        timeout: this.options.timeout
      });

      // Attendi un po' per script lazy
      await this.page.waitForTimeout(2000);

      // Raccogli dati pre-consenso
      this.report.preConsent.cookies = await this.collectCookies();
      const preStorage = await this.collectStorage();
      this.report.preConsent.localStorage = preStorage.localStorage;
      this.report.preConsent.sessionStorage = preStorage.sessionStorage;

      // Verifica CMP (Cookiebot, iubenda, OneTrust, etc.)
      const cmpState = await this.checkCMPState();
      this.report.cmp = { ...this.report.cmp, ...cmpState };

      if (cmpState.detected) {
        this.log(`CMP rilevato: ${cmpState.type}`);
        this.report.cmp.blockedScripts = await this.checkBlockedScripts();
        this.log(`Script bloccati (type="text/plain"): ${this.report.cmp.blockedScripts.length}`);
      } else {
        this.log('Nessun CMP rilevato', 'warn');
      }

      // === FASE 2: ACCETTAZIONE ===
      console.log('\n--- FASE 2: Accettazione Consenso ---');
      this.phase = 'POST_CONSENT';

      const accepted = await this.acceptCookies();
      if (!accepted) {
        this.log('Nessun banner trovato o già accettato', 'warn');
      }

      // Attendi caricamento tracker post-consenso (alcuni hanno delay significativo)
      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(8000);

      // Raccogli dati post-consenso
      this.report.postConsent.cookies = await this.collectCookies();
      const postStorage = await this.collectStorage();
      this.report.postConsent.localStorage = postStorage.localStorage;
      this.report.postConsent.sessionStorage = postStorage.sessionStorage;

      // Verifica stato CMP dopo accettazione
      if (cmpState.detected) {
        const cmpStatePost = await this.checkCMPState();
        this.report.cmp.consentState = cmpStatePost.consent;
        this.log(`Stato consenso ${cmpState.type}: ${JSON.stringify(cmpStatePost.consent)}`);
      }

      // === FASE 3: INTERAZIONI (per testare eventi GA4) ===
      console.log('\n--- FASE 3: Test Interazioni ---');
      this.phase = 'INTERACTION';

      // Trova form nella pagina
      await this.findForms();

      // Simula scroll (triggera evento scroll)
      await this.simulateScroll();
      await this.page.waitForTimeout(1000);

      // Simula click (triggera eventi click)
      await this.simulateClicks();
      await this.page.waitForTimeout(1000);

      // Interagisci con form se presente (triggera form_start)
      await this.interactWithForm();
      await this.page.waitForTimeout(1000);

      // Attendi che GA4 invii gli eventi batch (può richiedere fino a 5-10 secondi)
      this.log('Attesa invio batch GA4...');
      await this.page.waitForTimeout(5000);

    } catch (error) {
      this.log(`Errore: ${error.message}`, 'error');
      this.report.error = error.message;
    } finally {
      if (this.browser) await this.browser.close();
    }

    // === GENERA SUMMARY (fuori dal try per garantire esecuzione) ===
    this.generateSummary();

    // Output
    this.printReport();

    if (this.options.outputFile) {
      await this.saveReport();
    }

    return this.report;
  }

  // Genera il summary
  generateSummary() {
    const newCookies = this.report.postConsent.cookies.filter(
      post => !this.report.preConsent.cookies.find(pre => pre.name === post.name)
    );

    // Estrai tutti gli eventi
    const allEvents = [
      ...this.report.events.preConsent,
      ...this.report.events.postConsent,
      ...this.report.events.interactions
    ];

    // Raggruppa eventi per tracker con dettagli
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
      // Evita duplicati
      const exists = eventsByTracker[e.tracker][category]?.some(ev => ev.name === e.event);
      if (!exists && eventsByTracker[e.tracker][category]) {
        eventsByTracker[e.tracker][category].push(eventInfo);
      }
    });

    // Pulisci categorie vuote
    Object.keys(eventsByTracker).forEach(tracker => {
      Object.keys(eventsByTracker[tracker]).forEach(cat => {
        if (eventsByTracker[tracker][cat].length === 0) {
          delete eventsByTracker[tracker][cat];
        }
      });
    });

    // Estrai eventi unici
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
      // Events summary (tutti i tracker)
      events: {
        total: allEvents.length,
        preConsent: this.report.events.preConsent.length,
        postConsent: this.report.events.postConsent.length,
        interactions: this.report.events.interactions.length,
        uniqueEvents: uniqueEvents,
        byTracker: eventsByTracker
      },
      // Forms summary
      formsFound: this.report.forms.found.length,
      formSubmitted: this.report.forms.submitted?.success || false
    };
  }

  // Stampa report
  printReport() {
    console.log('\n========================================');
    console.log('         RISULTATO AUDIT');
    console.log('========================================\n');

    // CMP status
    console.log('CMP STATUS:');
    console.log(`  Rilevato: ${this.report.cmp.detected ? 'Si' : 'NO'}`);
    if (this.report.cmp.detected) {
      console.log(`  Tipo: ${this.report.cmp.type}`);
      console.log(`  Script bloccati: ${this.report.summary.blockedScriptsCount}`);
      console.log(`  Consenso post-click: ${JSON.stringify(this.report.cmp.consentState)}`);
    }

    // Violazioni
    console.log('\nVIOLAZIONI (tracking pre-consenso):');
    if (this.report.violations.length === 0) {
      console.log('  Nessuna violazione rilevata');
    } else {
      this.report.violations.forEach(v => {
        let info = v.details.event || v.details.url.substring(0, 80);
        // Aggiungi stato consenso cookie per GA4/Google
        if (v.details.gcsRaw) {
          info += ` (Consent State: ${v.details.gcsRaw})`;
        }
        console.log(`  - ${v.tracker}: ${info}`);
      });
    }

    // Tracker post-consenso
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

    // Cookie
    console.log('\nCOOKIE:');
    console.log(`  Pre-consenso: ${this.report.summary.cookiesPreConsent}`);
    console.log(`  Post-consenso: ${this.report.summary.cookiesPostConsent}`);
    console.log(`  Nuovi dopo accettazione: ${this.report.summary.newCookiesAfterConsent}`);

    // Eventi (tutti i tracker)
    console.log('\nEVENTI:');
    console.log(`  Pre-consenso: ${this.report.summary.events?.preConsent || 0}`);
    console.log(`  Post-consenso: ${this.report.summary.events?.postConsent || 0}`);
    console.log(`  Da interazioni: ${this.report.summary.events?.interactions || 0}`);
    // Mostra eventi per tracker e categoria
    const byTracker = this.report.summary.events?.byTracker || {};
    Object.entries(byTracker).forEach(([tracker, categories]) => {
      console.log(`\n  ${tracker}:`);
      Object.entries(categories).forEach(([category, events]) => {
        const eventNames = events.map(e => e.name).join(', ');
        console.log(`    [${category}] ${eventNames}`);
      });
    });

    // Form
    console.log('\nFORM:');
    console.log(`  Trovati: ${this.report.summary.formsFound || 0}`);
    if (this.report.forms.submitted) {
      console.log(`  Invio testato: ${this.report.forms.submitted.success ? 'Successo' : 'Fallito'}`);
    }

    // Verdetto
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

  // Salva report su file
  async saveReport() {
    const fs = require('fs').promises;
    const filename = this.options.outputFile || `audit-${Date.now()}.json`;
    await fs.writeFile(filename, JSON.stringify(this.report, null, 2));
    this.log(`Report salvato: ${filename}`, 'success');
  }
}

// === CLI ===
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Cookie Audit Scanner - Verifica GDPR compliance

Uso: node scanner.js <url> [opzioni]

Opzioni:
  --output, -o <file>   Salva report in file JSON
  --visible, -v         Mostra il browser (non headless)
  --timeout, -t <ms>    Timeout navigazione (default: 10000)
  --help, -h            Mostra questo messaggio

Esempi:
  node scanner.js https://example.com
  node scanner.js https://example.com -o report.json
  node scanner.js https://example.com --visible
`);
    process.exit(0);
  }

  const url = args[0];
  const options = {
    headless: !args.includes('--visible') && !args.includes('-v'),
    outputFile: null,
    timeout: 10000
  };

  // Parse output file
  const outputIdx = args.findIndex(a => a === '--output' || a === '-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    options.outputFile = args[outputIdx + 1];
  }

  // Parse timeout
  const timeoutIdx = args.findIndex(a => a === '--timeout' || a === '-t');
  if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
    options.timeout = parseInt(args[timeoutIdx + 1], 10);
  }

  const scanner = new CookieAuditScanner(url, options);
  await scanner.run();
}

// Esporta per uso come modulo
module.exports = { CookieAuditScanner };

// Esegui CLI solo se chiamato direttamente
if (require.main === module) {
  main().catch(console.error);
}
