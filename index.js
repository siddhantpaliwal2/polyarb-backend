require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const stringSimilarity = require('string-similarity');

const app = express();
const port = 3001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

// Corrected arbitrage calculation
function calculateArbitrage(polyPrices, kalshiPrices) {
  // Validate inputs
  if (!Array.isArray(polyPrices) || !Array.isArray(kalshiPrices) ||
      polyPrices.length !== 2 || kalshiPrices.length !== 2) {
    throw new Error('Invalid price format');
  }

  // Extract prices
  const [polyYes, polyNo] = polyPrices;
  const [kalshiYes, kalshiNo] = kalshiPrices;

  // Calculate potential arbitrage opportunities:
  // 1. Buy Yes on Platform A, Buy No on Platform B
  // 2. Buy No on Platform A, Buy Yes on Platform B
  const arbitrage1 = 1 - (polyYes + kalshiNo);  // Buy Yes on Poly, No on Kalshi
  const arbitrage2 = 1 - (polyNo + kalshiYes);  // Buy No on Poly, Yes on Kalshi

  // Return the better opportunity if it exists
  const bestArbitrage = Math.max(arbitrage1, arbitrage2);
  
  // Return object with detailed information
  return {
    hasArbitrage: bestArbitrage > 0,
    amount: bestArbitrage,
    strategy: bestArbitrage === arbitrage1 ? 
      'Buy Yes on Polymarket, No on Kalshi' : 
      'Buy No on Polymarket, Yes on Kalshi'
  };
}

async function fetchAllPolymarketEvents() {
  const allEvents = [];
  const limit = 12;
  let offset = 0;
  const MAX_EVENTS = 500;

  while (allEvents.length < MAX_EVENTS) {
    try {
      const response = await fetch(
        `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&archived=false&closed=false&order=volume24hr&ascending=false&offset=${offset}`,
        {
          headers: {
            'accept': 'application/json',
            'origin': 'https://polymarket.com',
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const events = await response.json();
      
      if (!events || events.length === 0) break;

      const validEvents = events.filter(event => 
        event.markets && 
        event.markets.length > 0 && 
        event.markets.some(market => market.outcomePrices)
      );

      allEvents.push(...validEvents.slice(0, MAX_EVENTS - allEvents.length));
      
      if (allEvents.length >= MAX_EVENTS) break;
      
      offset += limit;
    } catch (error) {
      console.error('Polymarket fetch error:', error);
      break;
    }
  }

  return allEvents;
}

async function fetchAllKalshiEvents() {
  const allEvents = [];
  const pageSize = 100;
  let pageNumber = 1;
  const MAX_EVENTS = 500;

  while (allEvents.length < MAX_EVENTS) {
    try {
      const response = await fetch(
        `https://api.elections.kalshi.com/v1/events/?single_event_per_series=false&page_size=${pageSize}&page_number=${pageNumber}`,
        {
          headers: {
            'accept': 'application/json',
            'origin': 'https://kalshi.com',
            'referer': 'https://kalshi.com/',
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.events || data.events.length === 0) break;

      const validEvents = data.events.filter(event => 
        event.markets && 
        event.markets.length > 0 && 
        event.markets.some(market => market.yes_bid !== undefined)
      );

      allEvents.push(...validEvents.slice(0, MAX_EVENTS - allEvents.length));
      
      if (allEvents.length >= MAX_EVENTS) break;
      
      pageNumber++;
    } catch (error) {
      console.error('Kalshi fetch error:', error);
      break;
    }
  }

  return allEvents;
}

function normalizeTitle(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Market categorization functions
function categorizeMarket(title) {
  title = title.toLowerCase();
  if (title.includes('bitcoin') || title.includes('ethereum') || title.includes('btc') || title.includes('eth')) {
    return 'crypto';
  }
  if (title.includes('win') && (title.includes('house') || title.includes('senate') || title.includes('president'))) {
    return 'elections';
  }
  if (title.includes('premier league') || title.includes('la liga')) {
    return 'sports';
  }
  return 'other';
}

// Extract specific details from titles
function extractDetails(title) {
  const numbers = title.match(/\$?\d+([.,]\d+)?/g) || [];
  const dates = title.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi) || [];
  const years = title.match(/\b20\d{2}\b/g) || [];
  
  return {
    numbers: numbers.map(n => parseFloat(n.replace('$', ''))),
    dates,
    years
  };
}

// Check if two markets are about the same event
function areMarketsMatching(market1, market2) {
  const details1 = extractDetails(market1);
  const details2 = extractDetails(market2);
  
  // Check if numerical values match
  const numbersMatch = details1.numbers.length === details2.numbers.length &&
    details1.numbers.every(n => details2.numbers.includes(n));
  
  // Check if dates match
  const datesMatch = details1.dates.length === details2.dates.length &&
    details1.dates.every(d => details2.dates.some(d2 => d.toLowerCase() === d2.toLowerCase()));
  
  // Check if years match
  const yearsMatch = details1.years.length === details2.years.length &&
    details1.years.every(y => details2.years.includes(y));
  
  // Calculate string similarity
  const similarity = stringSimilarity.compareTwoStrings(market1.toLowerCase(), market2.toLowerCase());
  
  return {
    isMatch: similarity > 0.8 && numbersMatch && datesMatch && yearsMatch,
    similarity
  };
}

app.get('/api/arbitrage', async (req, res) => {
  try {
    const [polymarketData, kalshiData] = await Promise.all([
      fetchAllPolymarketEvents(),
      fetchAllKalshiEvents()
    ]);

    // Group markets by category
    const polymarketMarkets = polymarketData.flatMap(event => 
      event.markets.filter(market => market.outcomePrices).map(market => ({
        title: market.question,
        category: categorizeMarket(market.question),
        market: market
      }))
    );

    const kalshiMarkets = kalshiData.flatMap(event => 
      event.markets.filter(market => market.yes_bid !== undefined).map(market => ({
        title: market.title,
        category: categorizeMarket(market.title),
        market: market
      }))
    );

    const matches = [];
    
    // Find matches within each category
    for (const polyMarket of polymarketMarkets) {
      const sameCategory = kalshiMarkets.filter(k => k.category === polyMarket.category);
      
      for (const kalshiMarket of sameCategory) {
        const { isMatch, similarity } = areMarketsMatching(polyMarket.title, kalshiMarket.title);
        
        if (isMatch) {
          matches.push({
            polymarket: polyMarket,
            kalshi: kalshiMarket,
            similarity
          });
        }
      }
    }

    console.log(`Found ${matches.length} potential matches`);

    // Calculate arbitrage for matches
    const arbitrageOpportunities = matches.map(match => {
      try {
        const polyOutcomes = JSON.parse(match.polymarket.market.outcomes);
        const polyPrices = JSON.parse(match.polymarket.market.outcomePrices).map(price => parseFloat(price));

        console.log('\nProcessing match:', match.polymarket.title);
        console.log('Polymarket outcomes:', polyOutcomes);
        console.log('Polymarket raw prices:', polyPrices);

        const polyYesPrice = polyPrices[0];  // YES is first
        const polyNoPrice = polyPrices[1];   // NO is second

        const kalshiPrices = [
          match.kalshi.market.yes_bid / 100,
          (100 - match.kalshi.market.yes_bid) / 100
        ];

        console.log('Final prices:');
        console.log('Polymarket Yes/No:', [polyYesPrice, polyNoPrice]);
        console.log('Kalshi Yes/No:', kalshiPrices);

        const arbitrage = calculateArbitrage(
          [polyYesPrice, polyNoPrice],
          kalshiPrices
        );

        console.log('Arbitrage analysis:', arbitrage);

        // Skip if no arbitrage or if arbitrage is unrealistically high (>50%)
        if (!arbitrage.hasArbitrage || arbitrage.amount > 0.5) {
          console.log('No valid arbitrage opportunity found');
          return null;
        }

        return {
          polymarket: {
            title: match.polymarket.market.question,
            prices: {
              yes: polyYesPrice,
              no: polyNoPrice
            },
            volume: parseFloat(match.polymarket.market.volume24hr) || 0
          },
          kalshi: {
            title: match.kalshi.market.title,
            prices: {
              yes: kalshiPrices[0],
              no: kalshiPrices[1]
            },
            volume: parseFloat(match.kalshi.market.dollar_recent_volume) || 0
          },
          potentialProfit: arbitrage.amount * 100,
          strategy: arbitrage.strategy,
          priceDifference: {
            yes: (polyYesPrice - kalshiPrices[0]) * 100,
            no: (polyNoPrice - kalshiPrices[1]) * 100
          },
          similarity: match.similarity
        };
      } catch (error) {
        console.error('Error processing match:', error);
        return null;
      }
    }).filter(Boolean);

    // Sort by potential profit (but only including realistic opportunities)
    const sortedOpportunities = arbitrageOpportunities
      .sort((a, b) => b.potentialProfit - a.potentialProfit);

    console.log(`Found ${sortedOpportunities.length} valid arbitrage opportunities (<=50%)`);
    
    res.json(sortedOpportunities);
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message || 'Failed to process markets' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});