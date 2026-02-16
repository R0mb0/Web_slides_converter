const express = require('express');
const cors = require('cors');
const path = require('path');
// Importiamo le librerie specifiche per Serverless/Vercel
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// Serve i file statici dalla cartella public
app.use(express.static(path.join(__dirname, 'public')));

// Impostazioni grafiche per il browser headless
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log('Launching browser for:', url);

        // Lancio browser ottimizzato per Vercel/AWS Lambda
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        // Aggiunge ?print-pdf se manca per attivare la modalità stampa di Reveal.js
        let targetUrl = url;
        if (!url.includes('print-pdf')) {
             targetUrl += (url.includes('?') ? '&' : '?') + 'print-pdf';
        }

        // Imposta risoluzione Full HD
        await page.setViewport({ width: 1920, height: 1080 });

        // Timeout impostato a 25s per stare nei limiti del piano Hobby di Vercel
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 });

        // Iniezione CSS per nascondere pulsanti e barre di navigazione
        await page.addStyleTag({
            content: `
                .reveal .controls, .reveal .progress, .reveal .playback, .reveal .state-background,
                .navigate-left, .navigate-right, .navigate-up, .navigate-down,
                button[aria-label="Next slide"], button[aria-label="Previous slide"],
                .bespoke-marp-osc, nav.navigation, .navigation-bar,
                .ytp-chrome-top, .ytp-chrome-bottom
                { display: none !important; }
                
                body { background-color: white !important; -webkit-print-color-adjust: exact; }
                
                .reveal .slides section { 
                    display: block !important; position: relative !important; 
                    top: auto !important; left: auto !important; transform: none !important;
                }
            `
        });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10px', bottom: '10px', left: '10px', right: '10px' }
        });

        // Invia il PDF generato al browser
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