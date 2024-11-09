require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = 3001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

// Calculate potential arbitrage between two markets
function calculateArbitrage(market1Prices, market2Prices) {
  const sumOfBestBids = Math.max(...market1Prices) + Math.max(...market2Prices);
  return 1 - sumOfBestBids;
}

app.get('/api/arbitrage', async (req, res) => {
  try {
    // Fetch data from both platforms
    const [polymarketRes, kalshiRes] = await Promise.all([
      fetch('https://gamma-api.polymarket.com/events?limit=12&active=true&archived=false&closed=false&order=volume24hr&ascending=false&offset=12', {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'origin': 'https://polymarket.com',
        }
      }),
      fetch('https://api.elections.kalshi.com/v1/events/?single_event_per_series=false&tickers=CONTROLH-2024%2CKXFEDDECISION-24DEC%2CKXGRAMSOTY-67%2CKXNEWSCOTUSCONF-29JAN20%2CKXSECHHS-26DEC31%2CKXSPEAKER%2CPOPVOTEMOV-24%2CPOPVOTEMOVSMALL-24%2CSENATEAZ-24&page_size=100&page_number=1', {
        headers: {
          'accept': 'application/json',
          'origin': 'https://kalshi.com',
        }
      })
    ]);

    const polymarketData = await polymarketRes.json();
    const kalshiData = await kalshiRes.json();

    // Extract markets
    const polymarketMarkets = polymarketData.flatMap(event => 
      event.markets.map(market => ({
        title: market.question,
        market: market
      }))
    );

    const kalshiMarkets = kalshiData.events.flatMap(event => 
      event.markets.map(market => ({
        title: market.title,
        market: market
      }))
    );

    // Ask Claude to find similar titles
    const message = `Compare these betting titles and find pairs that are betting on the same outcome, even if worded differently.

Polymarket titles:
${polymarketMarkets.map(m => m.title).join('\n')}

Kalshi titles:
${kalshiMarkets.map(m => m.title).join('\n')}

Return only pairs that are betting on exactly the same outcome. Format as JSON array:
[
  {
    "polymarket": "exact polymarket title",
    "kalshi": "exact kalshi title"
  }
]`;

    const response = await anthropic.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: 'user', content: message }]
    });

    const matches = JSON.parse(response.content[0].text);
    const comparisons = [];

    // Process matches and calculate arbitrage
    for (const match of matches) {
      const polyMarket = polymarketMarkets.find(m => m.title === match.polymarket);
      const kalshiMarket = kalshiMarkets.find(m => m.title === match.kalshi);

      if (polyMarket && kalshiMarket) {
        const polyPrices = JSON.parse(polyMarket.market.outcomePrices).map(price => parseFloat(price));
        const kalshiPrices = [
          kalshiMarket.market.yes_bid / 100,
          (100 - kalshiMarket.market.yes_bid) / 100
        ];

        const arbitrageAmount = calculateArbitrage(polyPrices, kalshiPrices);

        comparisons.push({
          polymarket: {
            title: polyMarket.market.question,
            prices: {
              yes: polyPrices[1],
              no: polyPrices[0]
            },
            volume: polyMarket.market.volume24hr
          },
          kalshi: {
            title: kalshiMarket.market.title,
            prices: {
              yes: kalshiPrices[0],
              no: kalshiPrices[1]
            },
            volume: kalshiMarket.market.dollar_recent_volume || 0
          },
          potentialProfit: arbitrageAmount * 100,
          priceDifference: {
            yes: (polyPrices[1] - kalshiPrices[0]) * 100,
            no: (polyPrices[0] - kalshiPrices[1]) * 100
          }
        });
      }
    }

    res.json(comparisons.sort((a, b) => Math.abs(b.potentialProfit) - Math.abs(a.potentialProfit)));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to process markets' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});