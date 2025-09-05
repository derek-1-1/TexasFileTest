const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

app.post('/scrape', async (req, res) => {
    const { connectUrl, config } = req.body;
    
    const results = {
        executionId: Date.now().toString(),
        timestamp: new Date().toISOString(),
        screenshots: [],
        records: [],
        totalPages: 0,
        pagesScraped: 0,
        errors: [],
        captchaEncountered: false,
        loginPerformed: false,
        wasAlreadyLoggedIn: false
    };
    
    let browser;
    let page;
    
    try {
        // Connect to BrowserBase
        console.log('Connecting to BrowserBase session...');
        browser = await puppeteer.connect({
            browserWSEndpoint: connectUrl,
            defaultViewport: null
        });
        
        page = await browser.newPage();
        const timeout = 30000;
        page.setDefaultTimeout(timeout);
        
        await page.setViewport({
            width: 1280,
            height: 1024
        });
        
        // Helper function to save screenshots
        async function saveScreenshot(pageNum, description = '') {
            try {
                const screenshot = await page.screenshot({
                    fullPage: true,
                    type: 'png',
                    encoding: 'base64'
                });
                
                results.screenshots.push({
                    pageNumber: pageNum,
                    filename: `${config.county}-${pageNum}-${description}-${Date.now()}.png`,
                    description: description,
                    timestamp: new Date().toISOString(),
                    data: screenshot
                });
                
                console.log(`Screenshot saved: ${description}`);
                return screenshot;
            } catch (error) {
                console.error(`Failed to save screenshot:`, error);
            }
        }
        
        // Check login status
        async function checkLoginStatus() {
            try {
                const loginIndicators = [
                    '.user-dashboard',
                    '.user-menu',
                    '.logout-button',
                    'a[href*="logout"]'
                ];
                
                for (const selector of loginIndicators) {
                    const element = await page.$(selector);
                    if (element) {
                        console.log(`Found login indicator: ${selector}`);
                        results.wasAlreadyLoggedIn = true;
                        return true;
                    }
                }
                return false;
            } catch (error) {
                console.error('Error checking login status:', error);
                return false;
            }
        }
        
        // Perform login if needed
        async function performLogin() {
            if (!config.texasFileUsername || !config.texasFilePassword) {
                console.log('No login credentials provided');
                return false;
            }
            
            try {
                console.log('Performing login...');
                
                // Try to find and fill username
                const usernameSelectors = ['input[type="email"]', 'input[name="username"]', '#username'];
                for (const selector of usernameSelectors) {
                    const field = await page.$(selector);
                    if (field) {
                        await field.click({ clickCount: 3 });
                        await field.type(config.texasFileUsername, { delay: 50 });
                        break;
                    }
                }
                
                // Try to find and fill password
                const passwordSelectors = ['input[type="password"]', '#password'];
                for (const selector of passwordSelectors) {
                    const field = await page.$(selector);
                    if (field) {
                        await field.click({ clickCount: 3 });
                        await field.type(config.texasFilePassword, { delay: 50 });
                        break;
                    }
                }
                
                // Click login button
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2' }),
                    page.click('button[type="submit"], input[type="submit"]')
                ]);
                
                await page.waitForTimeout(3000);
                results.loginPerformed = true;
                return true;
            } catch (error) {
                console.error('Login failed:', error);
                return false;
            }
        }
        
        // Navigate to TexasFile
        console.log('Navigating to TexasFile...');
        await page.goto('https://www.texasfile.com/search/texas/', {
            waitUntil: 'networkidle2'
        });
        
        // Check login and login if needed
        const isLoggedIn = await checkLoginStatus();
        if (!isLoggedIn) {
            await performLogin();
        }
        
        // Select county
        console.log(`Selecting county: ${config.county}...`);
        try {
            await page.click(`a:has-text("${config.county}")`);
            await page.waitForNavigation();
        } catch (e) {
            console.log('Could not select county, trying alternative method...');
            await page.goto(`https://www.texasfile.com/search/texas/${config.county.toLowerCase()}/county-clerk-records/`, {
                waitUntil: 'networkidle2'
            });
        }
        
        // Set date range (from config.startDate)
        console.log('Setting date range...');
        const dateInput = await page.$('div.dateSelectorWithRange input');
        if (dateInput) {
            await dateInput.click();
            await page.waitForTimeout(1000);
            // Select year and date logic here
        }
        
        // Select document type (Deed of Trust)
        console.log('Selecting document type...');
        const docTypeSelector = 'label:has-text("Deed of Trust") input, label:nth-of-type(79) > span';
        const docType = await page.$(docTypeSelector);
        if (docType) {
            await docType.click();
        }
        
        // ALPHABET LOOP
        const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
        const startLetter = config.startLetter || 'a';
        const endLetter = config.endLetter || 'z';
        const startIndex = alphabet.indexOf(startLetter.toLowerCase());
        const endIndex = alphabet.indexOf(endLetter.toLowerCase());
        const lettersToSearch = alphabet.slice(startIndex, endIndex + 1);
        
        console.log(`Will search letters: ${lettersToSearch.join(', ')}`);
        const allLetterResults = {};
        
        for (const letter of lettersToSearch) {
            const searchTerm = `${letter}*`;
            console.log(`Searching for: ${searchTerm}`);
            
            const letterResults = {
                letter: letter.toUpperCase(),
                searchTerm: searchTerm,
                records: [],
                screenshots: [],
                totalPages: 0,
                pagesScraped: 0
            };
            
            try {
                // Clear and enter search term
                const nameInput = await page.$('input#Form0Name, div.tabs-content input');
                if (nameInput) {
                    await nameInput.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await nameInput.type(searchTerm);
                }
                
                // Submit search
                await Promise.all([
                    page.waitForNavigation(),
                    page.click('#nameSearchBtn')
                ]);
                
                await page.waitForSelector('table, .results-container, .no-results', { timeout: 30000 });
                
                // Check for results
                const noResults = await page.$('.no-results');
                if (noResults) {
                    console.log(`No results for ${searchTerm}`);
                    allLetterResults[letter] = letterResults;
                    continue;
                }
                
                // Get page info
                const pageInfo = await page.evaluate(() => {
                    const pageText = document.body.innerText;
                    const match = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                    return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : { current: 1, total: 1 };
                });
                
                letterResults.totalPages = pageInfo.total;
                const maxPagesPerLetter = config.maxPagesPerLetter || 3;
                const pagesToScrape = Math.min(maxPagesPerLetter, pageInfo.total);
                
                // Scrape each page
                for (let currentPage = 1; currentPage <= pagesToScrape; currentPage++) {
                    console.log(`Scraping page ${currentPage} of ${pagesToScrape} for ${searchTerm}...`);
                    
                    // Take screenshot
                    const screenshot = await page.screenshot({
                        fullPage: true,
                        type: 'png',
                        encoding: 'base64'
                    });
                    
                    letterResults.screenshots.push({
                        letter: letter.toUpperCase(),
                        pageNumber: currentPage,
                        data: screenshot
                    });
                    
                    // Extract data
                    const pageData = await page.evaluate(() => {
                        const records = [];
                        const rows = document.querySelectorAll('table tbody tr');
                        
                        rows.forEach(row => {
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 3) {
                                records.push({
                                    docNumber: cells[0]?.innerText?.trim() || '',
                                    docType: cells[1]?.innerText?.trim() || '',
                                    date: cells[2]?.innerText?.trim() || '',
                                    grantor: cells[6]?.innerText?.trim() || '',
                                    grantee: cells[7]?.innerText?.trim() || ''
                                });
                            }
                        });
                        return records;
                    });
                    
                    letterResults.records.push({
                        pageNumber: currentPage,
                        recordCount: pageData.length,
                        data: pageData
                    });
                    
                    letterResults.pagesScraped++;
                    
                    // Navigate to next page if not last
                    if (currentPage < pagesToScrape) {
                        try {
                            await Promise.all([
                                page.waitForNavigation(),
                                page.click('a[aria-label="Next"], i.fi-chevron-right')
                            ]);
                            await page.waitForTimeout(2000);
                        } catch (navError) {
                            console.log('Could not navigate to next page');
                            break;
                        }
                    }
                }
                
                allLetterResults[letter] = letterResults;
                
            } catch (letterError) {
                console.error(`Error processing letter ${letter}:`, letterError);
                results.errors.push({
                    type: 'letter_processing',
                    letter: letter,
                    error: letterError.message
                });
            }
        }
        
        // Compile results
        results.letterSearches = allLetterResults;
        results.totalRecords = Object.values(allLetterResults).reduce((sum, lr) => 
            sum + lr.records.reduce((s, r) => s + r.recordCount, 0), 0
        );
        results.totalPages = Object.values(allLetterResults).reduce((sum, lr) => sum + lr.totalPages, 0);
        results.pagesScraped = Object.values(allLetterResults).reduce((sum, lr) => sum + lr.pagesScraped, 0);
        
        // Flatten records
        const flatRecords = [];
        for (const [letter, letterResult] of Object.entries(allLetterResults)) {
            letterResult.records.forEach(page => {
                page.data.forEach(record => {
                    flatRecords.push({
                        ...record,
                        searchLetter: letter.toUpperCase(),
                        county: config.county,
                        pageNumber: page.pageNumber,
                        executionId: results.executionId
                    });
                });
            });
        }
        results.flatRecords = flatRecords;
        
        console.log(`Complete: ${results.totalRecords} records, ${results.pagesScraped} pages`);
        
        res.json(results);
        
    } catch (error) {
        console.error('Fatal error:', error);
        results.errors.push({
            type: 'fatal',
            error: error.message,
            stack: error.stack
        });
        
        if (page) {
            await saveScreenshot('error', 'fatal-error');
        }
        
        res.status(500).json(results);
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'TexasFile Scraper API Running' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
