class InteractionSimulator {
    constructor(page, logger) {
        this.page = page;
        this.logger = logger;
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

    // Simula click realistici
    async simulateClicks() {
        this.logger.log('Simulazione click REALISTICA...');

        try {
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
                                isPhone: href.includes('tel:') || href.includes('phone') || href.includes('call') || onclick.includes('tel:') || onclick.includes('phone') || onclick.includes('click_phone')
                            });
                        }
                    });
                });
                return elements;
            });

            this.logger.log(`   Trovati ${phoneLinks.length} link telefonici/interattivi`);

            let clicks = 0;
            for (const link of phoneLinks) {
                if (clicks >= 5) break;

                try {
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
                        this.logger.log(`   Clicco: ${link.href} (${link.text.substring(0, 30)})`);

                        await this.page.evaluate((el) => {
                            if (!el) return;
                            const rect = el.getBoundingClientRect();
                            const x = rect.left + rect.width / 2;
                            const y = rect.top + rect.height / 2;

                            const events = [
                                new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }),
                                new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }),
                                new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }),
                                new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 })
                            ];

                            events.forEach(event => el.dispatchEvent(event));
                        }, elementHandle);

                        clicks++;
                        await this.page.waitForTimeout(1500);
                    }
                } catch (e) {
                    this.logger.error(`   Errore click: ${e.message}`);
                }
            }
        } catch (e) {
            this.logger.error(`Click simulation failed: ${e.message}`);
        }
    }

    // Trova form
    async findForms() {
        try {
            return await this.page.evaluate(() => {
                const formElements = document.querySelectorAll('form');
                return Array.from(formElements).map((form, index) => {
                    const hasNameField = !!form.querySelector('input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i], input[placeholder*="name" i]');
                    const hasSurnameField = !!form.querySelector('input[name*="surname" i], input[name*="cognome" i], input[placeholder*="cognome" i], input[placeholder*="surname" i]');
                    const hasEmailField = !!form.querySelector('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');
                    const hasPasswordField = !!form.querySelector('input[type="password"]');
                    const hasSearchField = !!form.querySelector('input[type="search"], input[name*="search" i], input[name*="query" i], input[name*="q" i]');
                    const hasPhoneField = !!form.querySelector('input[type="tel"], input[name*="phone" i], input[name*="telefono" i]');
                    const isValid = hasNameField || hasSurnameField || hasEmailField;

                    const rect = form.getBoundingClientRect();
                    const style = window.getComputedStyle(form);
                    const isVisible = rect.width > 0 && rect.height > 0 &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0';

                    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                    const submitText = submitBtn ? (submitBtn.textContent || submitBtn.value || '').trim().substring(0, 50) : null;

                    const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
                    const fieldLabels = Array.from(inputs).slice(0, 5).map(input => {
                        const label = form.querySelector(`label[for="${input.id}"]`);
                        return label?.textContent?.trim()?.substring(0, 30) ||
                            input.placeholder?.substring(0, 30) ||
                            input.name?.substring(0, 30) ||
                            input.type;
                    }).filter(Boolean);

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
        } catch (e) {
            this.logger.error(`Failed to find forms: ${e.message}`);
            return [];
        }
    }

    // Interagisce con form
    async interactWithForm() {
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
        } catch (e) {
            this.logger.error(`Form interaction failed: ${e.message}`);
        }
        return false;
    }
}

module.exports = InteractionSimulator;
