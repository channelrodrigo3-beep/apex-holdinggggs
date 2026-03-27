const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'apex-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Add users table with tier column
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            cash REAL DEFAULT 0,
            tier INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            symbol TEXT,
            shares INTEGER,
            avg_price REAL
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            symbol TEXT,
            type TEXT,
            shares INTEGER,
            price REAL,
            total REAL,
            date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS stocks (
            symbol TEXT PRIMARY KEY,
            name TEXT,
            price REAL,
            change REAL,
            volume INTEGER,
            market_cap TEXT,
            day_high REAL,
            day_low REAL
        )
    `);
    
    const result = await pool.query("SELECT COUNT(*) FROM stocks");
    if (parseInt(result.rows[0].count) === 0) {
        const stocksData = [
            ['AAPL', 'Apple Inc.', 175.32, 0, 52400000, '2.8T', 178.12, 174.45],
            ['GOOGL', 'Alphabet Inc.', 142.65, 0, 18700000, '1.8T', 144.23, 141.87],
            ['MSFT', 'Microsoft Corp.', 378.45, 0, 19800000, '2.9T', 382.34, 376.89],
            ['AMZN', 'Amazon.com Inc.', 145.78, 0, 32100000, '1.5T', 147.56, 144.23],
            ['TSLA', 'Tesla Inc.', 245.67, 0, 98700000, '780B', 252.34, 242.56],
            ['META', 'Meta Platforms', 334.56, 0, 14500000, '860B', 338.12, 332.45],
            ['NVDA', 'NVIDIA Corp.', 895.23, 0, 43200000, '2.2T', 912.34, 887.65],
            ['JPM', 'JPMorgan Chase', 185.45, 0, 8900000, '540B', 187.23, 184.12],
            ['V', 'Visa Inc.', 268.34, 0, 6500000, '540B', 270.12, 266.45],
            ['WMT', 'Walmart Inc.', 165.78, 0, 5200000, '445B', 167.23, 164.56]
        ];
        for (const s of stocksData) {
            await pool.query("INSERT INTO stocks (symbol, name, price, change, volume, market_cap, day_high, day_low) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", s);
        }
    }
}

initDB();

async function getStockPrices() {
    const result = await pool.query("SELECT * FROM stocks");
    return result.rows;
}

// Tier capital amounts
const tierCapital = { 1: 1000, 2: 5000, 3: 15000 };

// Register - starting cash based on tier
app.post('/api/register', async (req, res) => {
    const { username, email, password, tier = 1 } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const startingCash = tierCapital[tier] || 1000;
    try {
        await pool.query("INSERT INTO users (username, email, password, cash, tier) VALUES ($1, $2, $3, $4, $5)", 
            [username, email, hashed, startingCash, tier]);
        res.json({ success: true, startingCash });
    } catch (err) {
        res.status(400).json({ error: 'Username or email already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    req.session.userId = user.id;
    req.session.user = user;
    res.json({ success: true, user });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]);
    const user = userResult.rows[0];
    const stocks = await getStockPrices();
    const portfolioResult = await pool.query("SELECT symbol, shares FROM portfolio WHERE user_id = $1", [req.session.userId]);
    let portfolioValue = 0;
    for (const p of portfolioResult.rows) {
        const stock = stocks.find(s => s.symbol === p.symbol);
        if (stock) portfolioValue += stock.price * p.shares;
    }
    res.json({ ...user, portfolioValue, totalValue: user.cash + portfolioValue });
});

app.get('/api/user-tier', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const result = await pool.query("SELECT tier FROM users WHERE id = $1", [req.session.userId]);
    res.json({ tier: result.rows[0]?.tier || 1 });
});

app.get('/api/stocks', async (req, res) => {
    res.json(await getStockPrices());
});

app.get('/api/portfolio', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const portfolioResult = await pool.query("SELECT symbol, shares, avg_price FROM portfolio WHERE user_id = $1", [req.session.userId]);
    const stocks = await getStockPrices();
    const enriched = portfolioResult.rows.map(p => {
        const stock = stocks.find(s => s.symbol === p.symbol);
        const currentPrice = stock?.price || 0;
        const totalValue = currentPrice * p.shares;
        const gainLoss = (currentPrice - p.avg_price) * p.shares;
        const gainPercent = p.avg_price ? ((currentPrice - p.avg_price) / p.avg_price) * 100 : 0;
        return { ...p, currentPrice, totalValue, gainLoss, gainPercent };
    });
    res.json(enriched);
});

app.get('/api/transactions', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const result = await pool.query("SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC LIMIT 50", [req.session.userId]);
    res.json(result.rows);
});

app.post('/api/buy', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { symbol, shares } = req.body;
    const stockResult = await pool.query("SELECT * FROM stocks WHERE symbol = $1", [symbol]);
    const stock = stockResult.rows[0];
    if (!stock) return res.status(400).json({ error: "Stock not found" });
    const cost = stock.price * shares;
    const userResult = await pool.query("SELECT cash FROM users WHERE id = $1", [req.session.userId]);
    if (userResult.rows[0].cash < cost) return res.status(400).json({ error: "Insufficient funds" });
    
    await pool.query("UPDATE users SET cash = cash - $1 WHERE id = $2", [cost, req.session.userId]);
    
    const holdingResult = await pool.query("SELECT * FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    if (holdingResult.rows.length > 0) {
        const holding = holdingResult.rows[0];
        const newShares = holding.shares + shares;
        const newAvg = ((holding.avg_price * holding.shares) + (stock.price * shares)) / newShares;
        await pool.query("UPDATE portfolio SET shares = $1, avg_price = $2 WHERE user_id = $3 AND symbol = $4", [newShares, newAvg, req.session.userId, symbol]);
    } else {
        await pool.query("INSERT INTO portfolio (user_id, symbol, shares, avg_price) VALUES ($1, $2, $3, $4)", [req.session.userId, symbol, shares, stock.price]);
    }
    
    await pool.query("INSERT INTO transactions (user_id, symbol, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)", [req.session.userId, symbol, 'BUY', shares, stock.price, cost]);
    res.json({ success: true, message: `Bought ${shares} shares of ${symbol} at $${stock.price}` });
});

app.post('/api/sell', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { symbol, shares } = req.body;
    const stockResult = await pool.query("SELECT * FROM stocks WHERE symbol = $1", [symbol]);
    const stock = stockResult.rows[0];
    if (!stock) return res.status(400).json({ error: "Stock not found" });
    const value = stock.price * shares;
    const holdingResult = await pool.query("SELECT * FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    const holding = holdingResult.rows[0];
    if (!holding || holding.shares < shares) return res.status(400).json({ error: "Not enough shares" });
    
    await pool.query("UPDATE users SET cash = cash + $1 WHERE id = $2", [value, req.session.userId]);
    if (holding.shares === shares) {
        await pool.query("DELETE FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    } else {
        await pool.query("UPDATE portfolio SET shares = shares - $1 WHERE user_id = $2 AND symbol = $3", [shares, req.session.userId, symbol]);
    }
    
    await pool.query("INSERT INTO transactions (user_id, symbol, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)", [req.session.userId, symbol, 'SELL', shares, stock.price, value]);
    res.json({ success: true, message: `Sold ${shares} shares of ${symbol} at $${stock.price}` });
});

app.put('/api/user/profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { username, email } = req.body;
    if (username) await pool.query("UPDATE users SET username = $1 WHERE id = $2", [username, req.session.userId]);
    if (email) await pool.query("UPDATE users SET email = $1 WHERE id = $2", [email, req.session.userId]);
    res.json({ success: true });
});

app.put('/api/user/password', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { currentPassword, newPassword } = req.body;
    const userResult = await pool.query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
    const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password);
    if (!valid) return res.status(401).json({ error: "Current password incorrect" });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashed, req.session.userId]);
    res.json({ success: true });
});

// Deposit/Withdraw redirect to email
app.post('/api/user/add-money', (req, res) => {
    res.json({ redirect: true, email: 'kelsey@charterflow.store' });
});

app.post('/api/user/withdraw-money', (req, res) => {
    res.json({ redirect: true, email: 'kelsey@charterflow.store' });
});

app.post('/api/verify-password', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { password } = req.body;
    const userResult = await pool.query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
    const valid = await bcrypt.compare(password, userResult.rows[0].password);
    res.json({ valid });
});

// Admin routes
const ADMIN_SECRET = 'ApexMaster2024';

app.get('/api/admin/:secret/users', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const result = await pool.query("SELECT id, username, email, cash, tier, created_at FROM users");
    res.json(result.rows);
});

app.post('/api/admin/:secret/user/:id/cash', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { amount } = req.body;
    await pool.query("UPDATE users SET cash = cash + $1 WHERE id = $2", [amount, req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/:secret/user/:id/tier', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { tier } = req.body;
    const newCash = tierCapital[tier] || 1000;
    await pool.query("UPDATE users SET tier = $1, cash = $2 WHERE id = $3", [tier, newCash, req.params.id]);
    res.json({ success: true, newCash });
});

app.post('/api/admin/:secret/user/:id/reset', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const userResult = await pool.query("SELECT tier FROM users WHERE id = $1", [req.params.id]);
    const tier = userResult.rows[0]?.tier || 1;
    const newCash = tierCapital[tier] || 1000;
    await pool.query("DELETE FROM portfolio WHERE user_id = $1", [req.params.id]);
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [req.params.id]);
    await pool.query("UPDATE users SET cash = $1 WHERE id = $2", [newCash, req.params.id]);
    res.json({ success: true });
});

app.delete('/api/admin/:secret/user/:id', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    await pool.query("DELETE FROM portfolio WHERE user_id = $1", [req.params.id]);
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [req.params.id]);
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ success: true });
});

app.get('/api/admin/:secret/stocks', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    res.json(await getStockPrices());
});

app.post('/api/admin/:secret/stock/update', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { oldSymbol, newSymbol, name, price } = req.body;
    try {
        await pool.query("UPDATE stocks SET symbol = $1, name = $2, price = $3 WHERE symbol = $4", [newSymbol, name, price, oldSymbol]);
        res.json({ success: true, message: "Stock updated" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/:secret/stock/delete', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { symbol } = req.body;
    await pool.query("DELETE FROM stocks WHERE symbol = $1", [symbol]);
    res.json({ success: true, message: "Stock deleted" });
});

app.post('/api/admin/:secret/stock/add', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { symbol, name, price } = req.body;
    await pool.query("INSERT INTO stocks (symbol, name, price, change) VALUES ($1, $2, $3, $4)", [symbol.toUpperCase(), name, price, 0]);
    res.json({ success: true, message: "Stock added" });
});

app.get('/api/admin/:secret/transactions', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const result = await pool.query("SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY date DESC LIMIT 200");
    res.json(result.rows);
});

app.get('/api/admin/:secret/stats', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const userStats = await pool.query("SELECT COUNT(*) as totalUsers, SUM(cash) as totalCash FROM users");
    const tradeStats = await pool.query("SELECT COUNT(*) as totalTrades FROM transactions");
    const portfolioStats = await pool.query("SELECT SUM(shares * s.price) as totalPortfolio FROM portfolio p JOIN stocks s ON p.symbol = s.symbol");
    res.json({
        totalUsers: parseInt(userStats.rows[0].totalUsers) || 0,
        totalCash: parseFloat(userStats.rows[0].totalCash) || 0,
        totalTrades: parseInt(tradeStats.rows[0].totalTrades) || 0,
        totalPortfolioValue: parseFloat(portfolioStats.rows[0].totalportfolio) || 0
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
