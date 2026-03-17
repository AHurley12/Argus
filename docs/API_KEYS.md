# Guide to Obtaining and Configuring Free-Tier API Keys

This document provides a comprehensive guide on how to obtain and configure free-tier API keys for various data sources used in the Argus project. The data sources covered include NewsData, GDELT, EIA, FRED, Alpha Vantage, Finnhub, Twelve Data, and Polygon.io. Each section includes rate limits, registration links, and configuration instructions.

## 1. NewsData
- **Registration Link:** [NewsData](https://newsdata.io/register)
- **Rate Limits:** Up to 1000 requests per day on the free tier.
- **Configuration:*
  1. Sign up using the registration link above.
  2. Retrieve your API key from the dashboard.
  3. Configure your application to include the API key in the header or query parameters:
     ```bash
     curl -H 'Authorization: YOUR_API_KEY' 'https://newsdata.io/api/1/news'
     ```

## 2. GDELT
- **Registration Link:** [GDELT API](https://blog.gdeltproject.org/gdelt-2-0-our-global-news-graph/)
- **Rate Limits:** 500 requests per day on the free tier.
- **Configuration:**
  1. Visit the GDELT API documentation.
  2. Use the following endpoint structure:
     ```bash
     curl 'http://api.gdeltproject.org/api/v2/doc/doc?query=Obama'
     ```

## 3. EIA (U.S. Energy Information Administration)
- **Registration Link:** [EIA Registration](https://www.eia.gov/opendata/register.php)
- **Rate Limits:** 10 requests per second.
- **Configuration:**
  1. Sign up for an EIA API key.
  2. Use the following example:
     ```bash
     curl 'http://api.eia.gov/series/?api_key=YOUR_API_KEY&series_id=SEDS.BA.A' 
     ```

## 4. FRED (Federal Reserve Economic Data)
- **Registration Link:** [FRED API](https://fred.stlouisfed.org/docs/api/fred/)
- **Rate Limits:** 120 requests per minute.
- **Configuration:**
  1. Create an account on the FRED website.
  2. Use the following example:
     ```bash
     curl 'https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=YOUR_API_KEY'
     ```

## 5. Alpha Vantage
- **Registration Link:** [Alpha Vantage](https://www.alphavantage.co/support/#api-key)
- **Rate Limits:** 5 requests per minute and 500 requests per day.
- **Configuration:**
  1. Get your API key after registration.
  2. Use the following example:
     ```bash
     curl 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=YOUR_API_KEY'
     ```

## 6. Finnhub
- **Registration Link:** [Finnhub](https://finnhub.io/register)
- **Rate Limits:** 60 requests per minute.
- **Configuration:**
  1. Sign up and fetch your API key.
  2. Configure your application as follows:
     ```bash
     curl -H 'Content-Type: application/json' -X GET 'https://finnhub.io/api/v1/quote?symbol=AAPL&token=YOUR_API_KEY'
     ```

## 7. Twelve Data
- **Registration Link:** [Twelve Data](https://twelvedata.com/signup)
- **Rate Limits:** 800 requests per day.
- **Configuration:**
  1. After signing up, retrieve your API key.
  2. Use the following structure:
     ```bash
     curl 'https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day&apikey=YOUR_API_KEY'
     ```

## 8. Polygon.io
- **Registration Link:** [Polygon.io](https://polygon.io/register)
- **Rate Limits:** 5 requests per second on the free tier.
- **Configuration:**
  1. Register and get your API key.
  2. Implement the following command:
     ```bash
     curl 'https://api.polygon.io/v1/open-close/AAPL/2022-01-10?apiKey=YOUR_API_KEY'
     ```

---

Make sure to replace `YOUR_API_KEY` with the actual API key obtained from the respective sources. Keep your keys confidential and do not share them publicly.