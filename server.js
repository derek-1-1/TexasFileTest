const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

app.post('/scrape', async (req, res) => {
    const { connectUrl, config } = req.body;
    console.log('Received scrape request for county:', config.county);
    
    try {
        const browser = await puppeteer.connect({
            browserWSEndpoint: connectUrl,
            defaultViewport: null
        });
        
        const page = await browser.newPage();
        await page.goto('https://www.texasfile.com');
        const title = await page.title();
        
        res.json({ 
            success: true, 
            title: title,
            message: 'Connected successfully' 
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'TexasFile Scraper API Running' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});