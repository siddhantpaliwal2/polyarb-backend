require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const stringSimilarity = require('string-similarity');
const OpenAI = require('openai');

const app = express();
const port = 3001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
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
  const allMarkets = [];
  const limit = 100;
  let offset = 0;
  const MAX_MARKETS = 1000;

  while (allMarkets.length < MAX_MARKETS) {
    try {
      console.log(`\nFetching Polymarket markets with offset ${offset}...`);
      const response = await fetch(
        `https://gamma-api.polymarket.com/markets?` + 
        `limit=${limit}` +
        `&offset=${offset}` +
        `&active=true` +
        `&archived=false` +
        `&closed=false` +
        `&order=volume24hr` +
        `&ascending=false` +
        `&volume_num_min=1000`,  // Only markets with significant volume
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

      const markets = await response.json();
      
      if (!markets || markets.length === 0) {
        console.log('No more markets found');
        break;
      }

      const validMarkets = markets.filter(market => 
        market.outcomePrices && 
        !market.question.toLowerCase().includes('kamala harris') &&
        market.volume24hr > 1000  // Double check volume requirement
      );

      console.log(`Found ${validMarkets.length} valid markets in this batch`);
      
      allMarkets.push(...validMarkets.slice(0, MAX_MARKETS - allMarkets.length));
      
      if (allMarkets.length >= MAX_MARKETS) {
        console.log('Reached maximum market limit');
        break;
      }
      
      offset += limit;
    } catch (error) {
      console.error('Polymarket fetch error:', error);
      break;
    }
  }

  // Transform markets into expected format
  return [{
    markets: allMarkets.map(market => ({
      question: market.question,
      outcomePrices: market.outcomePrices,
      volume24hr: market.volume24hr,
      outcomes: market.outcomes
    }))
  }];
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
    isMatch: confidence > 0.65 && commonKeywords.length >= 2, // Require at least 3 common keywords
    confidence,
    commonKeywords
  };
}

async function findAlgorithmMatches(polymarketMarkets, kalshiMarkets) {
  const matches = [];
  console.log('\n=== Finding Algorithm Matches ===');
  
  for (const polyMarket of polymarketMarkets) {
    const sameTypeMarkets = kalshiMarkets.filter(k => k.type === polyMarket.type);
    
    for (const kalshiMarket of sameTypeMarkets) {
      const { isMatch, confidence, commonKeywords } = compareMarkets(polyMarket, kalshiMarket);
      
      if (isMatch) {
        matches.push({
          polymarket: polyMarket,
          kalshi: kalshiMarket,
          confidence,
          commonKeywords,
          source: 'algorithm'
        });
      }
    }
  }

  console.log(`Found ${matches.length} algorithm matches`);
  return matches;
}

// Also need to add the calculateArbitrageForMatch function
function calculateArbitrageForMatch(match) {
  try {
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
      },
      source: match.source
    };
  } catch (error) {
    console.error('Error calculating arbitrage for match:', error);
    return null;
  }
}

// Add Perplexity analysis function
async function getPerplexityAnalysis(question) {
  try {
    const messages = [
      {
        role: "user",
        content: `Analyze this prediction market question: "${question}".

Provide a detailed analysis in markdown format:

1. Historical Context & Background
2. Key Statistics & Data Points
3. Market Sentiment Analysis
4. Risk Factors
5. Final Verdict

Keep response under 300 words but be thorough.`
      }
    ];

    const response = await client.chat.completions.create({
      model: "llama-3.1-sonar-large-128k-online",
      messages: messages,
      temperature: 0.2,
      max_tokens: 1000
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Perplexity analysis error:', error);
    return null;
  }
}

app.get('/api/arbitrage', async (req, res) => {
  try {
    console.log('\n=== Starting Market Fetch ===');
    const [polymarketData, kalshiData] = await Promise.all([
      fetchAllPolymarketEvents(),
      fetchAllKalshiEvents()
    ]);

    // Extract markets and filter out Kamala Harris titles
    const polymarketMarkets = Array.from(new Set(
      polymarketData.flatMap(event => 
        (event?.markets || [])  // Add null check
          .filter(market => market && market.outcomePrices)
          .filter(market => !market.question?.toLowerCase().includes('kamala harris'))
          .map(market => ({
            title: market.question,
            type: getMarketType(market.question),
            market: market
          }))
      ).map(m => JSON.stringify(m))
    )).map(str => JSON.parse(str));

    const kalshiMarkets = Array.from(new Set(
      kalshiData.flatMap(event => 
        (event?.markets || [])  // Add null check
          .filter(market => market && market.yes_bid !== undefined)
          .filter(market => !market.title?.toLowerCase().includes('kamala harris'))
          .map(market => ({
            title: market.title,
            type: getMarketType(market.title),
            market: market
          }))
      ).map(m => JSON.stringify(m))
    )).map(str => JSON.parse(str));

    // Find matches using algorithm
    const matches = await findAlgorithmMatches(polymarketMarkets, kalshiMarkets);
    console.log(`Found ${matches.length} potential matches`);

    // Calculate arbitrage for matches
    const arbitrageOpportunities = await Promise.all(
      matches.map(async match => {
        if (!match?.polymarket?.market || !match?.kalshi?.market) {
          return null;
        }
        const opportunity = calculateArbitrageForMatch(match);
        if (opportunity) {
          // Get analysis for the market
          opportunity.analysis = await getPerplexityAnalysis(opportunity.polymarket.title);
        }
        return opportunity;
      })
    );

    // Filter out null values and duplicates
    const validOpportunities = arbitrageOpportunities.filter(opp => 
      opp && opp.polymarket && opp.kalshi
    );

    // Remove duplicates based on Polymarket title
    const seenTitles = new Set();
    const uniqueOpportunities = validOpportunities.filter(opp => {
      const normalizedTitle = opp.polymarket.title.toLowerCase().trim();
      if (seenTitles.has(normalizedTitle)) {
        return false;
      }
      seenTitles.add(normalizedTitle);
      return true;
    });

    console.log(`Found ${validOpportunities.length} total opportunities`);
    console.log(`Removed ${validOpportunities.length - uniqueOpportunities.length} duplicates`);
    console.log(`Final count: ${uniqueOpportunities.length} unique opportunities`);
    
    res.json(uniqueOpportunities.sort((a, b) => b.potentialProfit - a.potentialProfit));
  } catch (error) {
    console.error('\n=== Error ===');
    console.error('Server error:', error);
    res.status(500).json({ error: error.message || 'Failed to process markets' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});