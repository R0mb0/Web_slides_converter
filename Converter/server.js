const express = require('express');
const cors = require('cors');
const path = require('path');
// 1. IMPOSTAZIONE CRITICA: Definiamo la cartella della cache
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache');

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTO-FIX: Scarica Chrome se manca ---
function ensureBrowserInstalled() {
    try {
        console.log("Checking Chrome installation...");
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    } catch (error) {
        console.error("Warning: Auto-install skipped.", error);
    }
}
ensureBrowserInstalled();

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log(`[START] Conversion requested for: ${url}`);

        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 180000, // Timeout esteso a 3 minuti
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();

        // 1. Navigazione Base
        let targetUrl = url.split('#')[0];
        console.log(`[NAV] Going to: ${targetUrl}`);

        // Risoluzione Desktop Standard
        await page.setViewport({ width: 1280, height: 800 });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        // FIX FOCUS: Clicchiamo al centro della pagina
        try {
            await page.mouse.click(640, 400);
            await page.focus('body');
        } catch (e) { }

        console.log("[BOT] Detecting Presentation Framework...");

        // 2. RILEVAMENTO FRAMEWORK JS
        const frameworkType = await page.evaluate(() => {
            if (window.Reveal) return 'reveal';
            if (window.remark) return 'remark';
            if (window.impress) return 'impress';
            if (document.querySelector('.bespoke-parent')) return 'bespoke';
            return 'generic';
        });

        console.log(`[BOT] Framework detected: ${frameworkType.toUpperCase()}`);

        // INIEZIONE CSS: Nascondiamo l'interfaccia rendendola trasparente
        // Manteniamo gli elementi cliccabili, ma invisibili allo screenshot
        await page.addStyleTag({
            content: `
                .controls, .progress, .slide-number, .header, .footer, 
                .ytp-chrome-top, .ytp-chrome-bottom,
                /* Nascondi pulsanti specifici visti negli screenshot */
                .navigate-right, .navigate-left, button[aria-label="Next slide"]
                { opacity: 0 !important; } 
            `
        });

        const screenshots = [];
        let hasNext = true;
        let slideCount = 0;
        const MAX_SLIDES = 100;

        // Variabile per confrontare lo screenshot precedente
        let previousScreenshotBase64 = "";
        // Tentativo di leggere il contatore slide (es. "1 / 12")
        let currentSlideIndex = 0;

        while (hasNext && slideCount < MAX_SLIDES) {
            // Attesa stabilizzazione (fondamentale per le transizioni)
            await new Promise(r => setTimeout(r, 1500));

            // Scatta Screenshot
            const imgBuffer = await page.screenshot({ encoding: 'base64', fullPage: false });

            // --- CHECK VISIVO ANTI-LOOP ---
            // Se l'immagine è identica alla precedente, siamo fermi.
            if (slideCount > 0 && imgBuffer === previousScreenshotBase64) {
                console.log("Visual check: Slide did not change. Stopping.");
                break;
            }

            previousScreenshotBase64 = imgBuffer;
            screenshots.push(imgBuffer);
            slideCount++;
            console.log(`Captured slide ${slideCount} (Method: ${frameworkType})`);

            // --- STRATEGIA DI NAVIGAZIONE "TRY-HARDER" ---
            // Proviamo vari metodi in sequenza finché uno non sembra funzionare

            const navResult = await page.evaluate((type) => {
                // METODO 1: API NATIVA (Se rilevata)
                if (type === 'reveal' && window.Reveal) {
                    if (window.Reveal.isLastSlide && window.Reveal.isLastSlide()) return 'finished';
                    window.Reveal.next();
                    return 'api';
                }
                if (type === 'remark' && window.remark && window.remark.slideshow) {
                    if (window.remark.slideshow.getCurrentSlideIndex() === window.remark.slideshow.getSlideCount() - 1) return 'finished';
                    window.remark.slideshow.gotoNextSlide();
                    return 'api';
                }

                // METODO 2: CERCA PULSANTE "NEXT" (Analisi Testuale)
                // Cerca bottoni con testo "Next", ">", "Avanti", o classi sospette
                const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], .next, .navigate-right, .arrow-right'));
                const nextBtn = candidates.find(el => {
                    const text = (el.innerText || "").toLowerCase();
                    const visible = el.offsetParent !== null; // Deve essere visibile
                    return visible && (text.includes('next') || text.includes('avanti') || text.includes('→') || text.includes('>'));
                });

                if (nextBtn) {
                    nextBtn.click();
                    return 'click-text-match';
                }

                // Se non troviamo nulla di specifico, torniamo 'fallback' per usare la tastiera
                return 'fallback';
            }, frameworkType);

            if (navResult === 'finished') {
                console.log("API reports end of presentation.");
                break;
            }

            // METODO 3: TASTIERA (Fallback)
            if (navResult === 'fallback') {
                try {
                    // Premiamo ArrowRight
                    await page.keyboard.press('ArrowRight');

                    // METODO 4: Iniezione Evento JS (Brute Force)
                    // A volte Puppeteer non ha il focus, ma questo evento JS viene ascoltato comunque
                    await page.evaluate(() => {
                        const event = new KeyboardEvent('keydown', {
                            key: 'ArrowRight',
                            code: 'ArrowRight',
                            keyCode: 39,
                            which: 39,
                            bubbles: true,
                            cancelable: true
                        });
                        document.dispatchEvent(event);
                    });
                } catch (e) {
                    console.error("Keyboard nav failed:", e.message);
                }
            }

            // Attesa post-navigazione per permettere il caricamento della prossima slide
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[BUILD] Stitched ${screenshots.length} slides. Generating PDF...`);

        const htmlContent = `
            <html>
                <body style="margin:0; padding:0; background: white;">
                    ${screenshots.map(img => `
                        <div style="width: 100%; height: 100vh; display: flex; justify-content: center; align-items: center; page-break-after: always; overflow: hidden;">
                            <img src="data:image/png;base64,${img}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
                        </div>
                    `).join('')}
                </body>
            </html>
        `;

        await page.setContent(htmlContent);

        const pdfBuffer = await page.pdf({
            printBackground: true,
            format: 'A4',
            margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        });

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename="slides.pdf"'
        });
        res.send(pdfBuffer);

    } catch (error) {
        console.error('[ERROR]', error);
        res.status(500).send('Conversion error: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});