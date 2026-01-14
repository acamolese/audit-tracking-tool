class CMPManager {
    constructor(page, logger) {
        this.page = page;
        this.logger = logger;
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

                // TrustCommander / TagCommander (e.g. brt.it)
                const tcBanner = document.querySelector('#popin_tc_privacy') ||
                    document.querySelector('.tc-privacy-banner') ||
                    window.tc_privacy || window.TagCommander;
                if (tcBanner) {
                    return {
                        detected: true,
                        type: 'TrustCommander',
                        loaded: true,
                        consent: null,
                        hasResponse: document.querySelector('#popin_tc_privacy') === null
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
            '#popin_tc_privacy_button',
            '#popin_tc_privacy_button_all',
            '[id*="tc-privacy-button"]',
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
}

module.exports = CMPManager;
