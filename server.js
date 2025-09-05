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
        needsManualLogin: false
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
            width: 1050,
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
                    filename: `${config.county || 'unknown'}-${pageNum}-${description}-${Date.now()}.png`,
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
                
                // Navigate to login page
                await page.goto('https://www.texasfile.com/login');
                await page.waitForTimeout(2000);
                
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
        
        // START FROM HOMEPAGE
        console.log('Navigating to TexasFile homepage...');
        await page.goto('https://www.texasfile.com/', { waitUntil: 'networkidle2' });
        await page.waitForTimeout(3000);
        
        // Check if logged in
        const isLoggedIn = await checkLoginStatus();
        if (!isLoggedIn) {
            const loginSuccess = await performLogin();
            if (!loginSuccess && (!config.texasFileUsername || !config.texasFilePassword)) {
                results.needsManualLogin = true;
                results.message = 'Manual login required. Please log in via BrowserBase Session Inspector.';
                await saveScreenshot('login', 'manual-login-required');
                return res.json(results);
            }
            // Go back to homepage after login
            await page.goto('https://www.texasfile.com/');
            await page.waitForTimeout(2000);
        } else {
            results.wasAlreadyLoggedIn = true;
        }
        
        // SIMPLIFIED: Navigate directly to search page instead of clicking
        console.log('Navigating to search page...');
        await page.goto('https://www.texasfile.com/search/texas/', { waitUntil: 'networkidle2' });
        await page.waitForTimeout(3000);
        
        // DYNAMIC COUNTY SELECTION - Fixed
        console.log(`Selecting county: ${config.county || 'Travis'}...`);
        const countyName = config.county || 'Travis';
        
        // Try multiple methods to click county
        let countyClicked = false;
        
        // Method 1: Direct click on link containing county name
        try {
            await page.evaluate((county) => {
                const links = Array.from(document.querySelectorAll('a'));
                const countyLink = links.find(link => link.textContent.includes(county));
                if (countyLink) {
                    countyLink.click();
                    return true;
                }
                return false;
            }, countyName);
            countyClicked = true;
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        } catch (e) {
            console.log('Method 1 failed, trying alternative...');
        }
        
        // Method 2: Use puppeteer selector if Method 1 failed
        if (!countyClicked) {
            try {
                await page.click(`a:has-text("${countyName}")`);
                await page.waitForNavigation({ waitUntil: 'networkidle2' });
                countyClicked = true;
            } catch (e) {
                console.log('Method 2 failed, trying direct navigation...');
            }
        }
        
        // Method 3: Direct navigation as fallback
        if (!countyClicked) {
            const countyUrl = `https://www.texasfile.com/search/texas/${countyName.toLowerCase().replace(' ', '-')}/county-clerk-records/`;
            console.log(`Direct navigation to: ${countyUrl}`);
            await page.goto(countyUrl, { waitUntil: 'networkidle2' });
        }
        
        await page.waitForTimeout(2000);
        
        // WAIT FOR SEARCH FORM TO LOAD
        try {
            await page.waitForSelector('input#Form0Name', { timeout: 10000 });
        } catch (e) {
            console.log('Search form not found, checking if on correct page...');
            await saveScreenshot('error', 'search-form-not-found');
        }
        
        // Fill initial search term (required for form)
        console.log('Filling initial search term...');
        const searchInput = await page.$('input#Form0Name');
        if (searchInput) {
            await searchInput.click();
            await searchInput.type('a*');
        }
        
        // DYNAMIC DATE SELECTION - Fixed and simplified
        console.log('Setting date range to 1 month ago...');
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        
        // Click date input
        const dateInput = await page.$('div.dateSelectorWithRange input');
        if (dateInput) {
            await dateInput.click();
            await page.waitForTimeout(1000);
            
            // Click year dropdown
            const yearSelector = await page.$('span.react-datepicker__year-read-view--selected-year');
            if (yearSelector) {
                await yearSelector.click();
                await page.waitForTimeout(500);
                
                // Select correct year
                await page.evaluate((targetYear) => {
                    const yearOptions = document.querySelectorAll('div.react-datepicker__year-dropdown > div');
                    for (let option of yearOptions) {
                        if (option.textContent.trim() === targetYear.toString()) {
                            option.click();
                            return;
                        }
                    }
                }, oneMonthAgo.getFullYear());
                await page.waitForTimeout(500);
            }
            
            // Navigate to correct month
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                              'July', 'August', 'September', 'October', 'November', 'December'];
            const targetMonthName = monthNames[oneMonthAgo.getMonth()];
            const targetYear = oneMonthAgo.getFullYear();
            
            // Click month navigation buttons if needed
            for (let attempts = 0; attempts < 12; attempts++) {
                const currentMonth = await page.evaluate(() => {
                    const elem = document.querySelector('.react-datepicker__current-month');
                    return elem ? elem.textContent : '';
                });
                
                if (currentMonth.includes(targetMonthName) && currentMonth.includes(targetYear)) {
                    break;
                }
                
                // Determine if we need to go forward or backward
                const nextButton = await page.$('button.react-datepicker__navigation--next');
                const prevButton = await page.$('button.react-datepicker__navigation--previous');
                
                if (nextButton) {
                    await nextButton.click();
                    await page.waitForTimeout(300);
                }
            }
            
            // Click the specific day
            await page.evaluate((day) => {
                const dayElements = document.querySelectorAll('.react-datepicker__day');
                for (let elem of dayElements) {
                    if (elem.textContent.trim() === day.toString() &&
                        !elem.classList.contains('react-datepicker__day--outside-month')) {
                        elem.click();
                        return;
                    }
                }
            }, oneMonthAgo.getDate());
            
            await page.waitForTimeout(1000);
        }
        
        // DOCUMENT TYPE SELECTION - Fixed
        console.log(`Selecting document type: ${config.documentType || 'Deed of Trust'}...`);
        const docTypeToSelect = config.documentType || 'Deed of Trust';
        
        // Find and click document type
        const docTypeClicked = await page.evaluate((docType) => {
            const labels = document.querySelectorAll('fieldset label');
            for (let label of labels) {
                if (label.textContent.includes(docType)) {
                    // Try to click the span or input inside the label
                    const clickable = label.querySelector('span, input');
                    if (clickable) {
                        clickable.click();
                        return true;
                    }
                    // Fallback: click the label itself
                    label.click();
                    return true;
                }
            }
            return false;
        }, docTypeToSelect);
        
        if (!docTypeClicked) {
            console.log('Could not find document type, using default selector...');
            try {
                await page.click('label:nth-of-type(79) > span');
            } catch (e) {
                console.log('Default document type selector also failed');
            }
        }
        
        await page.waitForTimeout(1000);
        
        // ALPHABET LOOP
        const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
        const startLetter = config.startLetter || 'a';
        const endLetter = config.endLetter || 'c';  // Limited for testing
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
                // Find and clear search input
                const searchField = await page.$('input#Form0Name');
                if (searchField) {
                    await searchField.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await searchField.type(searchTerm);
                }
                
                // Submit search
                const searchButton = await page.$('#nameSearchBtn');
                if (searchButton) {
                    await Promise.race([
                        page.waitForNavigation({ waitUntil: 'networkidle2' }),
                        searchButton.click()
                    ]);
                }
                
                await page.waitForTimeout(3000);
                
                // Check for results
                const noResults = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    return bodyText.includes('No results') || bodyText.includes('0 results');
                });
                
                if (noResults) {
                    console.log(`No results for ${searchTerm}`);
                    allLetterResults[letter] = letterResults;
                    continue;
                }
                
                // Get page info
                const pageInfo = await page.evaluate(() => {
                    const pageText = document.body.innerText;
                    const match = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                    return match ? {
                        current: parseInt(match[1]),
                        total: parseInt(match[2])
                    } : { current: 1, total: 1 };
                });
                
                letterResults.totalPages = pageInfo.total;
                const maxPagesPerLetter = config.maxPagesPerLetter || 2;
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
                    
                    // Navigate to next page
                    if (currentPage < pagesToScrape) {
                        const nextButton = await page.$('i.fi-chevron-right');
                        if (nextButton) {
                            try {
                                await Promise.race([
                                    page.waitForNavigation({ waitUntil: 'networkidle2' }),
                                    nextButton.click()
                                ]);
                                await page.waitForTimeout(2000);
                            } catch (navError) {
                                console.log('Could not navigate to next page');
                                break;
                            }
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
                        county: config.county || 'Unknown',
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
