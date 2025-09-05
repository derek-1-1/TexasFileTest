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
        wasAlreadyLoggedIn: false,
        needsManualLogin: false  // ADD THIS
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
            width: 855,
            height: 857
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
        
        // CHANGE: Navigate to TexasFile LOGIN PAGE FIRST
        console.log('Navigating to TexasFile login page...');
        await page.goto('https://www.texasfile.com/login');
        await page.waitForTimeout(2000);
        
        // CHECK IF WE'RE REDIRECTED (ALREADY LOGGED IN)
        const currentUrl = page.url();
        const pageContent = await page.content();
        const isAlreadyLoggedIn = !currentUrl.includes('/login') || 
                                 pageContent.includes('Logout') || 
                                 pageContent.includes('Dashboard');
        
        if (!isAlreadyLoggedIn) {
            // Check login and login if needed
            const isLoggedIn = await checkLoginStatus();
            if (!isLoggedIn) {
                const loginSuccess = await performLogin();
                if (!loginSuccess && (!config.texasFileUsername || !config.texasFilePassword)) {
                    // NO CREDENTIALS PROVIDED - NEED MANUAL LOGIN
                    results.needsManualLogin = true;
                    results.message = 'Manual login required. Please log in via BrowserBase Session Inspector.';
                    await saveScreenshot('login', 'manual-login-required');
                    return res.json(results);
                }
            }
        } else {
            results.wasAlreadyLoggedIn = true;
        }
        
        // NOW NAVIGATE TO SEARCH PAGE
        console.log('Navigating to search page...');
        await page.goto('https://www.texasfile.com/search/texas/');
        await page.waitForTimeout(2000);
        
        // Select county using exact selectors from recording
        console.log(`Selecting county: ${config.county}...`);
        const promises = [];
        const startWaitingForEvents = () => {
            promises.push(page.waitForNavigation());
        }
        
        await puppeteer.Locator.race([
            page.locator(`::-p-aria(${config.county})`),
            page.locator(`::-p-text(${config.county})`)
        ])
            .setTimeout(timeout)
            .on('action', () => startWaitingForEvents())
            .click();
        await Promise.all(promises);
        
        // Click date input using exact selectors
        console.log('Setting date range...');
        await puppeteer.Locator.race([
            page.locator('div.dateSelectorWithRange > div:nth-of-type(1) > div:nth-of-type(2) input'),
            page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[1]/div[3]/div/div[1]/div[1]/div/div[2]/div[1]/div[1]/div[2]/div/div/input)'),
            page.locator(':scope >>> div.dateSelectorWithRange > div:nth-of-type(1) > div:nth-of-type(2) input')
        ])
            .setTimeout(timeout)
            .click({
                offset: {
                    x: 64.25,
                    y: 23.5625,
                },
            });
        
        // Click year selector
        await puppeteer.Locator.race([
            page.locator('span.react-datepicker__year-read-view--selected-year'),
            page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[1]/div[3]/div/div[1]/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[2]/div[2]/div/div/div[2]/div[1]/div[2]/div/div/span[2])'),
            page.locator(':scope >>> span.react-datepicker__year-read-view--selected-year')
        ])
            .setTimeout(timeout)
            .click({
                offset: {
                    x: 17.8515625,
                    y: 6.5,
                },
            });
        
        // Select 2025
        await puppeteer.Locator.race([
            page.locator('div.react-datepicker__year-dropdown > div:nth-of-type(1)'),
            page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[1]/div[3]/div/div[1]/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[2]/div[2]/div/div/div[2]/div[1]/div[2]/div/div[1]/div[1])'),
            page.locator(':scope >>> div.react-datepicker__year-dropdown > div:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
                offset: {
                    x: 41.140625,
                    y: 6.5,
                },
            });
        
        // Select January 1st
        await puppeteer.Locator.race([
            page.locator('::-p-aria(Choose Wednesday, January 1st, 2025)'),
            page.locator('div:nth-of-type(1) > div.react-datepicker__day--001'),
            page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[1]/div[3]/div/div[1]/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[2]/div[2]/div/div/div[2]/div[2]/div[1]/div[4])'),
            page.locator(':scope >>> div:nth-of-type(1) > div.react-datepicker__day--001')
        ])
            .setTimeout(timeout)
            .click({
                offset: {
                    x: 13.875,
                    y: 14.359375,
                },
            });
        
        // Select document type (Deed of Trust) - exact selector from recording
        console.log('Selecting document type...');
        await puppeteer.Locator.race([
            page.locator('label:nth-of-type(79) > span'),
            page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[1]/div[3]/div/div[1]/div[1]/div/div[2]/div[3]/div/div/fieldset/label[79]/span)'),
            page.locator(':scope >>> label:nth-of-type(79) > span')
        ])
            .setTimeout(timeout)
            .click({
                offset: {
                    x: 9.25,
                    y: 5.5625,
                },
            });
        
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
                // Click and fill search field using exact selectors from recording
                await puppeteer.Locator.race([
                    page.locator('::-p-aria(Full Name 1 Grantor/Grantee)'),
                    page.locator('div.tabs-content > div > div:nth-of-type(1) > div:nth-of-type(1) input'),
                    page.locator('::-p-xpath(//*[@id="Form0Name"])'),
                    page.locator(':scope >>> div.tabs-content > div > div:nth-of-type(1) > div:nth-of-type(1) input')
                ])
                    .setTimeout(timeout)
                    .click({
                        offset: {
                            x: 112,
                            y: 25.5625,
                        },
                    });
                
                // Clear and type search term
                await page.keyboard.down('Control');
                await page.keyboard.press('A');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                
                await puppeteer.Locator.race([
                    page.locator('::-p-aria(Full Name 1 Grantor/Grantee)'),
                    page.locator('div.tabs-content > div > div:nth-of-type(1) > div:nth-of-type(1) input'),
                    page.locator('::-p-xpath(//*[@id="Form0Name"])'),
                    page.locator(':scope >>> div.tabs-content > div > div:nth-of-type(1) > div:nth-of-type(1) input')
                ])
                    .setTimeout(timeout)
                    .fill(searchTerm);
                
                // Submit search using exact selector
                const searchPromises = [];
                const startSearchWaiting = () => {
                    searchPromises.push(page.waitForNavigation());
                }
                
                await puppeteer.Locator.race([
                    page.locator('#nameSearchBtn'),
                    page.locator('::-p-xpath(//*[@id="nameSearchBtn"])'),
                    page.locator(':scope >>> #nameSearchBtn')
                ])
                    .setTimeout(timeout)
                    .on('action', () => startSearchWaiting())
                    .click({
                        offset: {
                            x: 312,
                            y: 17.5625,
                        },
                    });
                await Promise.all(searchPromises);
                
                await page.waitForTimeout(2000);
                
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
                    
                    await saveScreenshot(`${letter}-${currentPage}`, `letter-${letter}-page-${currentPage}`);
                    
                    // Extract data
                    const pageData = await page.evaluate(() => {
                        const records = [];
                        const rows = document.querySelectorAll('table tbody tr');
                        
                        rows.forEach(row => {
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 8) {
                                records.push({
                                    docNumber: cells[0]?.innerText?.trim() || '',
                                    docType: cells[1]?.innerText?.trim() || '',
                                    date: cells[2]?.innerText?.trim() || '',
                                    book: cells[3]?.innerText?.trim() || '',
                                    page: cells[4]?.innerText?.trim() || '',
                                    numberOfPages: cells[5]?.innerText?.trim() || '',
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
                    
                    // Navigate to next page using exact selectors from recording
                    if (currentPage < pagesToScrape) {
                        try {
                            const navPromises = [];
                            const startNavWaiting = () => {
                                navPromises.push(page.waitForNavigation());
                            }
                            
                            await puppeteer.Locator.race([
                                page.locator('div.u-hide--small-only i.fi-chevron-right'),
                                page.locator('::-p-xpath(//*[@id="react_rendered"]/div/form/div/div[2]/div[3]/div[1]/div/div[2]/div[2]/div/div[1]/div[2]/div/ul/li[4]/a/span/i[1])'),
                                page.locator(':scope >>> div.u-hide--small-only i.fi-chevron-right')
                            ])
                                .setTimeout(timeout)
                                .on('action', () => startNavWaiting())
                                .click({
                                    offset: {
                                        x: 8.375,
                                        y: 6.8046875,
                                    },
                                });
                            await Promise.all(navPromises);
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
                await saveScreenshot(`error-${letter}`, `error-letter-${letter}`);
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
        results.screenshots = results.screenshots.concat(
            Object.values(allLetterResults).flatMap(lr => lr.screenshots || [])
        );
        
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
