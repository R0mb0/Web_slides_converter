const express = require('express');
const cors = require('cors');
const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configurazioni critiche per Vercel
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

app.post('/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('URL is required');

    let browser = null;

    try {
        console.log('Launching browser for:', url);

        // Configurazione specifica per Node 20 su Vercel
        // Usiamo argomenti extra per disabilitare funzionalità che richiedono GPU o librerie mancanti
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--no-zygote"
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        // Aggiunge ?print-pdf se manca
        let targetUrl = url;
        if (!url.includes('print-pdf')) {
             targetUrl += (url.includes('?') ? '&' : '?') + 'print-pdf';
        }

        await page.setViewport({ width: 1920, height: 1080 });

        // Timeout 25s
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 });

        // Iniezione CSS
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