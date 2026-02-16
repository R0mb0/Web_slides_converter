const express = require('express');
const cors = require('cors');
const path = require('path');
// Su Render usiamo il pacchetto standard "puppeteer", che scarica il suo Chrome compatibile.
// Non servono più @sparticuz/chromium o puppeteer-core.
const puppeteer = require('puppeteer');

const app = express();
// Render ci assegna una porta tramite la variabile d'ambiente PORT
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log('Launching browser for:', url);

        // Configurazione standard per Render.com
        // L'ambiente di Render ha già le librerie, basta disabilitare la sandbox
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage' // Utile per evitare crash di memoria
            ]
        });

        const page = await browser.newPage();

        let targetUrl = url;
        // Aggiunge il parametro per la stampa di Reveal.js se manca
        if (!url.includes('print-pdf')) {
             targetUrl += (url.includes('?') ? '&' : '?') + 'print-pdf';
        }

        // Imposta viewport Full HD
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Timeout di 30 secondi per il caricamento
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Iniezione CSS per pulire la pagina
        await page.addStyleTag({
            content: `
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                button[aria-label="Next slide"], button[aria-label="Previous slide"],
                .bespoke-marp-osc, nav.navigation, .navigation-bar,
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }
                body { background-color: white !important; -webkit-print-color-adjust: exact; }
                .reveal .slides section { display: block !important; position: relative !important; top: auto !important; left: auto !important; transform: none !important; }
            `
        });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10px', bottom: '10px', left: '10px', right: '10px' }
        });

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename="slides.pdf"'
        });
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error during conversion:', error);
        res.status(500).send('Conversion error: ' + error.message);
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});