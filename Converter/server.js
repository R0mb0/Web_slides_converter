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
            protocolTimeout: 120000,
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

        // 1. URL Pulito (Proviamo SENZA ?print-pdf se il framework è custom,
        // ma lo teniamo come fallback perché spesso carica gli asset giusti)
        let targetUrl = url.split('#')[0];
        if (!targetUrl.includes('print-pdf')) {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'print-pdf';
        }

        console.log(`[NAV] Going to: ${targetUrl}`);

        // Viewport ampia
        await page.setViewport({ width: 1280, height: 1024 });

        // Navigazione
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 120000 });

        console.log("[HACK] Applying Brute-Force layout fix...");

        // 2. SCRIPT DI SBLOCCO MANUALE (DOM Unpacker)
        // Questo script viene eseguito DENTRO la pagina per manipolare il sito
        await page.evaluate(() => {
            // A. Nascondere l'Interfaccia Utente (Pulsanti, Footer, Contatori)
            const selectorsToHide = [
                'button',                 // Tutti i pulsanti
                '.controls',              // Reveal.js controls
                '.navigation',            // Barre navigazione generiche
                '.progress',              // Barre progresso
                '.slide-number',          // Numeri slide
                '.header', '.footer',     // Intestazioni/Piè di pagina
                'nav',                    // Elementi di navigazione HTML5
                '.navigate-right', '.navigate-left', // Frecce specifiche
                'div[class*="controls"]'  // Qualsiasi div con "controls" nel nome
            ];

            selectorsToHide.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
            });

            // B. Sbloccare le Slide (Reveal.js e simili usano <section>)
            const slides = document.querySelectorAll('.reveal .slides section, section');

            if (slides.length > 0) {
                // Sblocchiamo il contenitore principale
                const reveal = document.querySelector('.reveal');
                if (reveal) {
                    reveal.style.overflow = 'visible';
                    reveal.style.position = 'static';
                    reveal.style.height = 'auto';
                }
                const slidesContainer = document.querySelector('.reveal .slides');
                if (slidesContainer) {
                    slidesContainer.style.width = '100%';
                    slidesContainer.style.height = 'auto';
                    slidesContainer.style.overflow = 'visible';
                    slidesContainer.style.transform = 'none';
                    slidesContainer.style.position = 'static';
                    slidesContainer.style.left = 'auto';
                    slidesContainer.style.top = 'auto';
                }

                // Sblocchiamo ogni singola slide trovata
                slides.forEach(slide => {
                    slide.style.display = 'block';     // Mostra slide nascoste
                    slide.style.visibility = 'visible';
                    slide.style.opacity = '1';
                    slide.style.position = 'relative'; // Impila verticalmente
                    slide.style.top = 'auto';
                    slide.style.left = 'auto';
                    slide.style.transform = 'none';    // Rimuove effetti di transizione
                    slide.style.height = 'auto';       // Altezza automatica
                    slide.style.minHeight = '600px';   // Altezza minima per evitare schiacciamenti
                    slide.style.marginBottom = '20px'; // Spazio tra le slide
                    slide.style.pageBreakAfter = 'always'; // Pagina nuova nel PDF
                });

                // Forza lo sfondo bianco
                document.body.style.backgroundColor = 'white';
                document.body.style.height = 'auto';
                document.body.style.overflow = 'visible';
            }
        });

        // Pausa per lasciare che il browser ridisegni il layout modificato
        await new Promise(r => setTimeout(r, 2000));

        console.log(`[PDF] Generating PDF...`);

        const pdfBuffer = await page.pdf({
            printBackground: true,
            // Importante: togliamo preferCSSPageSize qui perché abbiamo manomesso il layout manualmente
            // Usiamo il formato A4 per avere pagine standard
            format: 'A4',
            margin: { top: '10px', bottom: '10px', left: '10px', right: '10px' }
        });

        console.log(`[SUCCESS] PDF Size: ${pdfBuffer.length} bytes`);

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