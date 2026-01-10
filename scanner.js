const { chromium } = require('playwright');

// === CONFIGURAZIONE BROWSER (anti bot-detection) ===
const BROWSER_CONFIG = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'it-IT',
  timezoneId: 'Europe/Rome',
  extraHTTPHeaders: {
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  }
};

// User Agent alternativi per evitare detection
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
];

// === CONFIGURAZIONE TRACKER ===
const TRACKER_PATTERNS = {
  'GTM Container': /googletagmanager\.com\/gtm\.js/i,
  'GTM Collect': /googletagmanager\.com\/gtag\/js/i,
  'Google Ads': /googleadservices\.com|googlesyndication\.com|doubleclick\.net|googleads\./i,
  'GA4': /google-analytics\.com|analytics\.google\.com|\/g\/collect|stape\.net|stape\.io|sgtm\./i,
  'Facebook Pixel': /facebook\.com\/tr/i,
  'Facebook SDK': /connect\.facebook\.net|facebook\.net/i,
  'Clarity': /clarity\.ms/i,
  'Bing Ads': /bat\.bing\.com/i,
  'LinkedIn Insight': /snap\.licdn\.com|linkedin\.com\/px|licdn\.com|px\.ads\.linkedin/i,
  'TikTok Pixel': /analytics\.tiktok\.com|tiktok\.com\/i18n\/pixel/i,
  'Hotjar': /hotjar\.com|static\.hotjar\.com/i,
  'Criteo': /criteo\.com|criteo\.net/i,
  'Taboola': /taboola\.com|trc\.taboola\.com/i,
  'Outbrain': /outbrain\.com/i,
  'Yahoo/Verizon': /analytics\.yahoo\.com|ads\.yahoo\.com/i,
  'Adobe Analytics': /omtrdc\.net|demdex\.net|2o7\.net/i,
  'Cookiebot': /cookiebot\.com|consentcdn\.cookiebot\.com/i,
  'OneTrust': /onetrust\.com|cdn\.cookielaw\.org/i,
  'iubenda': /iubenda\.com/i,
  'Commanders Act': /tagcommander\.com|commander1\.com|tC\.cmp/i,
  'Didomi': /didomi\.io|sdk\.privacy-center\.org/i,
  'Axeptio': /axeptio\.eu|client\.axept\.io/i,
  'Usercentrics': /usercentrics\.eu|app\.usercentrics\.eu/i,
  'Quantcast': /quantcast\.com|quantserve\.com/i,
};

// Pattern per Google Consent Mode
const GOOGLE_CONSENT_PATTERNS = {
  'gcs': {
    'G100': 'denied',
    'G110': 'analytics_only',
    'G101': 'ads_only',
    'G111': 'granted',
    'G1--': 'not_set'
  }
};

// Eventi GA4 standard
const GA4_STANDARD_EVENTS = [
  'page_view', 'scroll', 'click', 'form_start', 'form_submit',
  'generate_lead', 'view_item', 'view_item_list', 'add_to_cart',
  'remove_from_cart', 'begin_checkout', 'purchase', 'user_engagement',
  'session_start', 'first_visit'
];

// Eventi GA4 che potrebbero essere equivalenti a click_phone
const GA4_PHONE_EVENTS = [
  'click_phone', 'phone_click', 'call_click', 'tel_click',
  'click_to_call', 'phone_interaction', 'call_interaction'
];

// === BROWSER POOL MANAGER ===
class BrowserPool {
  constructor(maxSize = 7) {
    this.maxSize = maxSize;
    this.pool = [];
    this.waiting = [];
    this.inUse = new Set();
  }

  async acquire() {
    // Cerca browser disponibile nel pool
    const available = this.pool.find(b => !this.inUse.has(b));
    if (available) {
      this.inUse.add(available);
      return available;
    }

    // Crea nuovo browser se possibile
    if (this.pool.length < this.maxSize) {
      const browser = await this._createBrowser();
      this.pool.push(browser);
      this.inUse.add(browser);
      return browser;
    }

    // Attendi disponibilità
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async release(browser) {
    this.inUse.delete(browser);
    
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      this.inUse.add(browser);
      next(browser);
    }
  }

  async _createBrowser() {
    return await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }

  async dispose() {
    for (const browser of this.pool) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
    this.pool = [];
    this.inUse.clear();
    this.waiting = [];
  }
}

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
    
    console.log(`[${icons[level]}] ${message}`);
  }

  error(message, context = {}) {
    this.errors.push({ message, context, timestamp: Date.now() });
    this.log(message, 'error');
  }

  getErrors() {
    return this.errors;
  }
}

// === CLASSE PRINCIPALE SCANNER ===
class CookieAuditScanner {
  constructor(url, options = {}) {
    this.url = url;
    this.options = {
      headless: options.headless !== false,
      timeout: options.timeout || 10000,
      outputFile: options.outputFile || null,
      verbose: options.verbose || false,
      onPhase: options.onPhase || null,
      maxRetries: options.maxRetries || 3,
      skipInteractions: options.skipInteractions || false, // NUOVO: salta interazioni
      fastMode: options.fastMode || false, // NUOVO: modalità rapida
      ...options
    };

    this.logger = new Logger(this.options.verbose);
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
    this.browserPool = null;
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
          } catch (e) {}
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
      customData: details.customData || null
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

      const validForms = forms.filter(f => f.isValid);
      this.report.forms.found = validForms;
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
    this.logger.log(`Timestamp: ${this.report.timestamp}\n`);

    // Ottimizzazione: riduci timeout per pagine semplici ma aumenta per pagine lente
    // Aumentato timeout per fast mode da 15s a 25s per garantire rilevamento CMP
    // Aumentato ulteriormente per ambiente Railway (container più lento)
    const baseTimeout = this.options.fastMode ? 25000 : this.options.timeout;
    const optimizedTimeout = baseTimeout + 10000; // Aggiungi 10s extra per Railway
    this.logger.log(`Timeout configurato: ${optimizedTimeout}ms`);
    
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        this.logger.log(`Tentativo ${attempt}/${this.options.maxRetries}`);
        
        // Ottimizzazione: lancia browser direttamente senza pool complesso
        // Usa User Agent casuale per evitare detection
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
            '--disable-blink-features=AutomationControlled', // Anti-bot detection
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--window-size=1920,1080',
            '--start-maximized',
            '--disable-web-security', // Permette cross-origin
            '--disable-features=IsolateOrigins,site-per-process' // Disabilita isolamento
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

        // Ottimizzazione: disabilita risorse non essenziali
        await this.page.route('**/*.{png,jpg,jpeg,webp,woff2,font,css}', route => route.abort());

        // Registra handler richieste
        this.page.on('request', (req) => this.handleRequest(req));

        // === MONITORAGGIO DATA LAYER ===
        await this.page.addInitScript(() => {
          window.__dataLayerEvents = [];
          window.__auditPhase = 'UNKNOWN';

          // Intercetta dataLayer.push senza sovrascrivere l'array
          // GTM richiede che dataLayer sia un array, non un oggetto
          const setupDataLayerMonitoring = () => {
            if (!window.dataLayer) {
              window.dataLayer = [];
            }

            // Se già monitorato, esci
            if (window.dataLayer.__auditMonitored) return;

            const originalPush = window.dataLayer.push.bind(window.dataLayer);
            window.dataLayer.push = function(...args) {
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

          // Setup iniziale
          setupDataLayerMonitoring();

          // Re-setup se dataLayer viene ricreato (es. da GTM)
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

          // Monitora gtag se presente
          const setupGtagMonitoring = () => {
            if (window.gtag && !window.gtag.__auditMonitored) {
              const originalGtag = window.gtag;
              window.gtag = function(...args) {
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
          // Riprova dopo un po' per gtag caricato dinamicamente
          setTimeout(setupGtagMonitoring, 1000);
        });

        // === FASE 1: PRE-CONSENSO ===
        await this.page.evaluate(() => { window.__auditPhase = 'PRE_CONSENT'; });
        this.logger.log('--- FASE 1: Analisi PRE-CONSENSO ---');
        this.phase = 'PRE_CONSENT';
        this.notifyPhase('pre_consent', 'Analisi pre-consenso...');

        // Ottimizzazione: timeout ridotto e waitUntil più veloce
        // Per ambiente Railway, usa 'load' invece di 'domcontentloaded' per maggiore stabilità
        const waitUntilMode = this.options.fastMode ? 'load' : 'networkidle';
        this.logger.log(`Navigazione con waitUntil: ${waitUntilMode}, timeout: ${optimizedTimeout}ms`);
        
        await this.page.goto(this.url, {
          waitUntil: waitUntilMode,
          timeout: optimizedTimeout
        });
        
        // Log aggiuntivo per debug ambiente
        this.logger.log(`Pagina caricata, URL finale: ${this.page.url()}`);

        // Ottimizzazione: attesa per caricamento dinamico CMP
        // Aumentato da 500ms a 2000ms per garantire che CMP caricato dinamicamente sia visibile
        await this.page.waitForTimeout(this.options.fastMode ? 2000 : 3000);

        // Verifica CMP con retry aumentato per ambiente Railway
        let cmpState = await this.checkCMPState();
        let retryCount = 0;
        const maxRetries = 4; // Aumentato da 2 a 4 per Railway
        
        // Se non rilevato, aspetta ancora e riprova
        while (!cmpState.detected && retryCount < maxRetries) {
          this.logger.log(`CMP non rilevato, retry ${retryCount + 1}/${maxRetries}...`);
          
          // Attesa progressiva: 1.5s, 2s, 2.5s, 3s
          const waitTime = 1500 + (retryCount * 500);
          await this.page.waitForTimeout(waitTime);
          
          // Verifica anche script tag per Cookiebot
          if (retryCount >= 2) {
            const scriptCMP = await this.page.evaluate(() => {
              // Cerca script Cookiebot
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
              
              // Cerca script OneTrust
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

        // Raccogli dati pre-consenso DOPO aver verificato CMP
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

        // === FASE 2: ACCETTAZIONE ===
        this.logger.log('\n--- FASE 2: Accettazione Consenso ---');
        this.phase = 'POST_CONSENT';
        this.notifyPhase('consent', 'Accettazione consenso...');

        const accepted = await this.acceptCookies();
        if (!accepted) {
          this.logger.log('Nessun banner trovato o già accettato', 'warn');
        }

        // Ottimizzazione: adaptive waiting più aggressivo
        await this.waitForConsentEffectsOptimized();

        // Raccogli dati post-consenso
        this.notifyPhase('post_consent', 'Verifica post-consenso...');
        this.report.postConsent.cookies = await this.collectCookies();
        const postStorage = await this.collectStorage();
        this.report.postConsent.localStorage = postStorage.localStorage;
        this.report.postConsent.sessionStorage = postStorage.sessionStorage;

        // Verifica stato CMP post-consenso
        if (cmpState.detected) {
          const cmpStatePost = await this.checkCMPState();
          this.report.cmp.consentState = cmpStatePost.consent;
          this.logger.log(`Stato consenso ${cmpState.type}: ${JSON.stringify(cmpStatePost.consent)}`);
        }

        // === FASE 3: INTERAZIONI ===
        if (!this.options.skipInteractions && !this.options.fastMode) {
          this.logger.log('\n--- FASE 3: Test Interazioni ---');
          this.phase = 'INTERACTION';
          this.notifyPhase('interactions', 'Test interazioni...');

          await this.findForms();
          await this.simulateScroll();
          await this.simulateClicks();
          await this.interactWithForm();

          // Ottimizzazione: attesa minima per GA4
          this.logger.log('Attesa invio batch GA4...');
          await this.page.waitForTimeout(1500);
        } else {
          this.logger.log('\n--- FASE 3: Saltata (modalità rapida) ---');
          // Attesa minima per eventi base
          await this.page.waitForTimeout(500);
        }

        // === RACCOLTA EVENTI DATALAYER ===
        this.logger.log('\n--- RACCOLTA EVENTI DATALAYER ---');
        const dataLayerEvents = await this.page.evaluate(() => {
          return window.__dataLayerEvents || [];
        });

        // Processa eventi dataLayer
        if (dataLayerEvents.length > 0) {
          this.logger.log(`Trovati ${dataLayerEvents.length} eventi nel dataLayer`);
          
          dataLayerEvents.forEach(dlEvent => {
            const eventName = dlEvent.event;
            const phase = dlEvent.phase === 'PRE_CONSENT' ? 'PRE_CONSENT' : 
                         dlEvent.phase === 'POST_CONSENT' ? 'POST_CONSENT' : 'POST_CONSENT';
            
            // Determina tracker basato su sorgente
            let tracker = 'GA4';
            if (dlEvent.source === 'gtag') {
              tracker = 'GA4';
            } else if (dlEvent.data && dlEvent.data.tracker) {
              tracker = dlEvent.data.tracker;
            }

            // Determina categoria evento
            let eventCategory = 'custom';
            if (GA4_STANDARD_EVENTS.includes(eventName)) {
              eventCategory = 'standard';
            } else if (GA4_PHONE_EVENTS.includes(eventName) || eventName.startsWith('click_') || eventName.startsWith('cta_')) {
              eventCategory = 'click';
            }

            // Crea dettagli evento
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

            // Traccia l'evento
            this.trackEvent(details, phase, 'automatic');
            this.logger.log(`   [DATALAYER] ${tracker}: ${eventName}`);
          });
        } else {
          this.logger.log('Nessun evento dataLayer rilevato');
        }

        // Rilascia browser
        await this.page.close();
        await this.browser.close();
        this.browser = null;
        this.page = null;

        break; // Successo, esci dal loop

      } catch (error) {
        this.logger.error(`Errore tentativo ${attempt}: ${error.message}`);
        this.report.errors.push({
          phase: this.phase,
          message: error.message,
          attempt: attempt
        });

        if (this.page) {
          try { await this.page.close(); } catch (e) {}
        }
        if (this.browser) {
          try { await this.browser.close(); } catch (e) {}
        }

        if (attempt === this.options.maxRetries) {
          throw error;
        }

        // Attendi prima di retry (ridotto per velocità)
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    // === GENERA SUMMARY ===
    this.notifyPhase('finalizing', 'Generazione report...');
    this.generateSummary();

    // Cleanup
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
    // Aumentato timeout per garantire rilevamento eventi automatici come user_engagement
    const maxWait = this.options.fastMode ? 12000 : 15000; // 12s per fast, 15s per standard

    while (Date.now() - startTime < maxWait) {
      checkCount++;
      
      // Controlla ogni 300ms invece di 500ms
      await this.page.waitForTimeout(300);

      // Se ci sono nuove richieste post-consenso
      if (this.report.postConsent.requests.length > 0) {
        lastRequestTime = Date.now();
      }

      // Se non ci sono nuove richieste da 2 secondi, usciamo
      if (Date.now() - lastRequestTime > 2000 && checkCount > 6) {
        break;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    this.logger.log(`Adaptive waiting ottimizzato: ${elapsed}s (max: ${maxWait/1000}s)`);
  }

  // Adaptive waiting per effetti consenso
  async waitForConsentEffects() {
    const startTime = Date.now();
    let lastRequestTime = startTime;
    let checkCount = 0;

    while (Date.now() - startTime < 10000) {
      checkCount++;
      
      // Controlla ogni 500ms
      await this.page.waitForTimeout(500);

      // Se ci sono nuove richieste post-consenso
      if (this.report.postConsent.requests.length > 0) {
        lastRequestTime = Date.now();
      }

      // Se non ci sono nuove richieste da 2 secondi, usciamo
      if (Date.now() - lastRequestTime > 2000 && checkCount > 4) {
        break;
      }
    }

    this.logger.log(`Adaptive waiting completato in ${Math.round((Date.now() - startTime) / 1000)}s`);
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

    console.log('\nCOOKIE:');
    console.log(`  Pre-consenso: ${this.report.summary.cookiesPreConsent}`);
    console.log(`  Post-consenso: ${this.report.summary.cookiesPostConsent}`);
    console.log(`  Nuovi dopo accettazione: ${this.report.summary.newCookiesAfterConsent}`);

    console.log('\nEVENTI:');
    console.log(`  Pre-consenso: ${this.report.summary.events?.preConsent || 0}`);
    console.log(`  Post-consenso: ${this.report.summary.events?.postConsent || 0}`);
    console.log(`  Da interazioni: ${this.report.summary.events?.interactions || 0}`);
    console.log(`  Da test form: ${this.report.summary.events?.formTest || 0}`);

    const byTracker = this.report.summary.events?.byTracker || {};
    Object.entries(byTracker).forEach(([tracker, categories]) => {
      console.log(`\n  ${tracker}:`);
      Object.entries(categories).forEach(([category, events]) => {
        const eventNames = events.map(e => e.name).join(', ');
        console.log(`    [${category}] ${eventNames}`);
      });
    });

    console.log('\nFORM:');
    console.log(`  Trovati: ${this.report.summary.formsFound || 0}`);
    if (this.report.forms.submitted) {
      console.log(`  Invio testato: ${this.report.forms.submitted.success ? 'Successo' : 'Fallito'}`);
    }

    console.log('\nERRORI:');
    console.log(`  Totali: ${this.report.summary.errors || 0}`);

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
  --verbose             Mostra log dettagliati
  --help, -h            Mostra questo messaggio

Esempi:
  node scanner.js https://example.com
  node scanner.js https://example.com -o report.json
  node scanner.js https://example.com --visible --verbose
`);
    process.exit(0);
  }

  const url = args[0];
  const options = {
    headless: !args.includes('--visible') && !args.includes('-v'),
    outputFile: null,
    timeout: 10000,
    verbose: args.includes('--verbose')
  };

  const outputIdx = args.findIndex(a => a === '--output' || a === '-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    options.outputFile = args[outputIdx + 1];
  }

  const timeoutIdx = args.findIndex(a => a === '--timeout' || a === '-t');
  if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
    options.timeout = parseInt(args[timeoutIdx + 1], 10);
  }

  const scanner = new CookieAuditScanner(url, options);
  await scanner.run();
}

module.exports = { CookieAuditScanner };

if (require.main === module) {
  main().catch(console.error);
}
