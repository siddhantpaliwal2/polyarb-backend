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

  const [polyYes, polyNo] = polyPrices;
  const [kalshiYes, kalshiNo] = kalshiPrices;

  // Calculate potential arbitrage opportunities
  const arbitrage1 = 1 - (polyYes + kalshiNo);  // Buy Yes on Poly, No on Kalshi
  const arbitrage2 = 1 - (polyNo + kalshiYes);  // Buy No on Poly, Yes on Kalshi

  // Add minimum threshold for meaningful arbitrage (e.g., 2%)
  const MIN_ARBITRAGE = 0.01;
  // Add maximum threshold to filter out likely mismatches (e.g., 20%)
  const MAX_ARBITRAGE = 0.50;

  const bestArbitrage = Math.max(arbitrage1, arbitrage2);
  
  return {
    hasArbitrage: bestArbitrage > MIN_ARBITRAGE && bestArbitrage < MAX_ARBITRAGE,
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
  const MAX_EVENTS = 1000;

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
  const MAX_EVENTS = 1000;

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
    isMatch: similarity > 0.7 && numbersMatch && datesMatch && yearsMatch,
    similarity
  };
}

// Add new helper functions for better matching
function extractKeywords(title) {
  // Remove common words and punctuation
  const cleanTitle = title.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\b(will|the|be|in|by|at|on|for|of|to|and|or|a|an)\b/g, '')
    .trim();
  
  // Extract key terms
  return cleanTitle.split(' ').filter(word => word.length > 2);
}

function getMarketType(title) {
  const types = {
    crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto'],
    politics: ['election', 'president', 'senate', 'house', 'congress', 'democrat', 'republican', 'trump', 'biden'],
    sports: ['win', 'league', 'championship', 'cup', 'game', 'match'],
    finance: ['rate', 'fed', 'interest', 'market', 'price', 'index']
  };

  title = title.toLowerCase();
  for (const [type, keywords] of Object.entries(types)) {
    if (keywords.some(keyword => title.includes(keyword))) {
      return type;
    }
  }
  return 'other';
}

function compareMarkets(market1, market2) {
  const title1 = market1.title.toLowerCase();
  const title2 = market2.title.toLowerCase();

  // Check if they're the same type of market
  if (getMarketType(title1) !== getMarketType(title2)) {
    return { isMatch: false, confidence: 0 };
  }

  // Extract keywords from both titles
  const keywords1 = extractKeywords(title1);
  const keywords2 = extractKeywords(title2);

  // Calculate keyword overlap - require more common keywords
  const commonKeywords = keywords1.filter(word => keywords2.includes(word));
  const keywordScore = commonKeywords.length / Math.max(keywords1.length, keywords2.length);

  // More strict string similarity
  const similarity = stringSimilarity.compareTwoStrings(title1, title2);

  // Combined confidence score with higher threshold
  const confidence = (keywordScore * 0.5) + (similarity * 0.5);
  
  // More strict matching criteria
  return {
    isMatch: confidence > 0.7 && commonKeywords.length >= 3, // Require at least 3 common keywords
    confidence,
    commonKeywords
  };
}

app.get('/api/arbitrage', async (req, res) => {
  try {
    console.log('\n=== Starting Market Fetch ===');
    const [polymarketData, kalshiData] = await Promise.all([
      fetchAllPolymarketEvents(),
      fetchAllKalshiEvents()
    ]);

    // Extract markets and remove duplicates
    const polymarketMarkets = Array.from(new Set(
      polymarketData.flatMap(event => 
        event.markets.filter(market => market.outcomePrices).map(market => ({
          title: market.question,
          type: getMarketType(market.question),
          market: market
        }))
      ).map(m => JSON.stringify(m))
    )).map(str => JSON.parse(str));

    const kalshiMarkets = Array.from(new Set(
      kalshiData.flatMap(event => 
        event.markets.filter(market => market.yes_bid !== undefined).map(market => ({
          title: market.title,
          type: getMarketType(market.title),
          market: market
        }))
      ).map(m => JSON.stringify(m))
    )).map(str => JSON.parse(str));

    console.log(`Found ${polymarketMarkets.length} unique Polymarket markets`);
    console.log(`Found ${kalshiMarkets.length} unique Kalshi markets`);

    const matches = [];
    console.log('\n=== Finding Matches ===');
    
    // Find matches using comparison logic
    for (const polyMarket of polymarketMarkets) {
      const sameTypeMarkets = kalshiMarkets.filter(k => k.type === polyMarket.type);
      
      for (const kalshiMarket of sameTypeMarkets) {
        const { isMatch, confidence, commonKeywords } = compareMarkets(polyMarket, kalshiMarket);
        
        if (isMatch) {
          matches.push({
            polymarket: polyMarket,
            kalshi: kalshiMarket,
            confidence,
            commonKeywords
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
        const kalshiPrices = [
          match.kalshi.market.yes_bid / 100,
          (100 - match.kalshi.market.yes_bid) / 100
        ];

        const arbitrage = calculateArbitrage(
          [polyPrices[0], polyPrices[1]],
          kalshiPrices
        );

        if (!arbitrage.hasArbitrage) return null;

        return {
          polymarket: {
            title: match.polymarket.market.question,
            prices: {
              yes: polyPrices[0],
              no: polyPrices[1]
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
            yes: (polyPrices[0] - kalshiPrices[0]) * 100,
            no: (polyPrices[1] - kalshiPrices[1]) * 100
          }
        };
      } catch (error) {
        console.error('Error processing match:', error);
        return null;
      }
    }).filter(Boolean);

    console.log(`Found ${arbitrageOpportunities.length} valid arbitrage opportunities`);
    
    const sortedOpportunities = arbitrageOpportunities
      .sort((a, b) => b.potentialProfit - a.potentialProfit);
    
    res.json(sortedOpportunities);
  } catch (error) {
    console.error('\n=== Error ===');
    console.error('Server error:', error);
    res.status(500).json({ error: error.message || 'Failed to process markets' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});