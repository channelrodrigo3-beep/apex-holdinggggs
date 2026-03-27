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

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            cash REAL DEFAULT 1000,
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
            change REAL DEFAULT 0
        )
    `);
    
    const result = await pool.query("SELECT COUNT(*) FROM stocks");
    if (parseInt(result.rows[0].count) === 0) {
        const stocks = [
            ['AAPL', 'Apple Inc.', 175.32],
            ['GOOGL', 'Alphabet Inc.', 142.65],
            ['MSFT', 'Microsoft Corp.', 378.45],
            ['AMZN', 'Amazon.com Inc.', 145.78],
            ['TSLA', 'Tesla Inc.', 245.67],
            ['META', 'Meta Platforms', 334.56],
            ['NVDA', 'NVIDIA Corp.', 895.23]
        ];
        for (const s of stocks) {
            await pool.query("INSERT INTO stocks (symbol, name, price) VALUES ($1, $2, $3)", s);
        }
    }
}

initDB();

async function getStocks() {
    const result = await pool.query("SELECT * FROM stocks");
    return result.rows;
}

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    try {
        await pool.query("INSERT INTO users (username, email, password, cash) VALUES ($1, $2, $3, 1000)", [username, email, hashed]);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Username exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid" });
    req.session.userId = user.id;
    res.json({ success: true, user });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]);
    const stocks = await getStocks();
    const portfolio = await pool.query("SELECT symbol, shares FROM portfolio WHERE user_id = $1", [req.session.userId]);
    let portfolioValue = 0;
    for (const p of portfolio.rows) {
        const stock = stocks.find(s => s.symbol === p.symbol);
        if (stock) portfolioValue += stock.price * p.shares;
    }
    res.json({ ...user.rows[0], portfolioValue, totalValue: user.rows[0].cash + portfolioValue });
});

app.get('/api/stocks', async (req, res) => {
    const stocks = await getStocks();
    res.json(stocks);
});

app.get('/api/portfolio', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const portfolio = await pool.query("SELECT symbol, shares, avg_price FROM portfolio WHERE user_id = $1", [req.session.userId]);
    const stocks = await getStocks();
    const enriched = portfolio.rows.map(p => {
        const stock = stocks.find(s => s.symbol === p.symbol);
        const currentPrice = stock?.price || 0;
        return { ...p, currentPrice, totalValue: currentPrice * p.shares, gainLoss: (currentPrice - p.avg_price) * p.shares };
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
    const stock = await pool.query("SELECT * FROM stocks WHERE symbol = $1", [symbol]);
    if (!stock.rows[0]) return res.status(400).json({ error: "Stock not found" });
    const cost = stock.rows[0].price * shares;
    const user = await pool.query("SELECT cash FROM users WHERE id = $1", [req.session.userId]);
    if (user.rows[0].cash < cost) return res.status(400).json({ error: "Insufficient funds" });
    
    await pool.query("UPDATE users SET cash = cash - $1 WHERE id = $2", [cost, req.session.userId]);
    
    const holding = await pool.query("SELECT * FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    if (holding.rows.length > 0) {
        const newShares = holding.rows[0].shares + shares;
        const newAvg = ((holding.rows[0].avg_price * holding.rows[0].shares) + (stock.rows[0].price * shares)) / newShares;
        await pool.query("UPDATE portfolio SET shares = $1, avg_price = $2 WHERE user_id = $3 AND symbol = $4", [newShares, newAvg, req.session.userId, symbol]);
    } else {
        await pool.query("INSERT INTO portfolio (user_id, symbol, shares, avg_price) VALUES ($1, $2, $3, $4)", [req.session.userId, symbol, shares, stock.rows[0].price]);
    }
    
    await pool.query("INSERT INTO transactions (user_id, symbol, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)", [req.session.userId, symbol, 'BUY', shares, stock.rows[0].price, cost]);
    res.json({ success: true, message: `Bought ${shares} shares of ${symbol}` });
});

app.post('/api/sell', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { symbol, shares } = req.body;
    const stock = await pool.query("SELECT * FROM stocks WHERE symbol = $1", [symbol]);
    if (!stock.rows[0]) return res.status(400).json({ error: "Stock not found" });
    const value = stock.rows[0].price * shares;
    const holding = await pool.query("SELECT * FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    if (!holding.rows[0] || holding.rows[0].shares < shares) return res.status(400).json({ error: "Not enough shares" });
    
    await pool.query("UPDATE users SET cash = cash + $1 WHERE id = $2", [value, req.session.userId]);
    if (holding.rows[0].shares === shares) {
        await pool.query("DELETE FROM portfolio WHERE user_id = $1 AND symbol = $2", [req.session.userId, symbol]);
    } else {
        await pool.query("UPDATE portfolio SET shares = shares - $1 WHERE user_id = $2 AND symbol = $3", [shares, req.session.userId, symbol]);
    }
    
    await pool.query("INSERT INTO transactions (user_id, symbol, type, shares, price, total) VALUES ($1, $2, $3, $4, $5, $6)", [req.session.userId, symbol, 'SELL', shares, stock.rows[0].price, value]);
    res.json({ success: true, message: `Sold ${shares} shares of ${symbol}` });
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
    const user = await pool.query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
    const valid = await bcrypt.compare(currentPassword, user.rows[0].password);
    if (!valid) return res.status(401).json({ error: "Current password incorrect" });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashed, req.session.userId]);
    res.json({ success: true });
});

app.post('/api/user/add-money', (req, res) => {
    res.json({ redirect: true, email: 'kelsey@charterflow.store' });
});

app.post('/api/user/withdraw-money', (req, res) => {
    res.json({ redirect: true, email: 'kelsey@charterflow.store' });
});

app.post('/api/verify-password', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { password } = req.body;
    const user = await pool.query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
    const valid = await bcrypt.compare(password, user.rows[0].password);
    res.json({ valid });
});

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
    const cashMap = { 1: 1000, 2: 5000, 3: 15000 };
    const newCash = cashMap[tier] || 1000;
    await pool.query("UPDATE users SET tier = $1, cash = $2 WHERE id = $3", [tier, newCash, req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/:secret/user/:id/reset', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const user = await pool.query("SELECT tier FROM users WHERE id = $1", [req.params.id]);
    const cashMap = { 1: 1000, 2: 5000, 3: 15000 };
    const newCash = cashMap[user.rows[0]?.tier || 1];
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
    const stocks = await getStocks();
    res.json(stocks);
});

app.post('/api/admin/:secret/stock/update', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { oldSymbol, newSymbol, name, price } = req.body;
    await pool.query("UPDATE stocks SET symbol = $1, name = $2, price = $3 WHERE symbol = $4", [newSymbol, name, price, oldSymbol]);
    res.json({ success: true });
});

app.post('/api/admin/:secret/stock/add', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { symbol, name, price } = req.body;
    await pool.query("INSERT INTO stocks (symbol, name, price) VALUES ($1, $2, $3)", [symbol.toUpperCase(), name, price]);
    res.json({ success: true });
});

app.post('/api/admin/:secret/stock/delete', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const { symbol } = req.body;
    await pool.query("DELETE FROM stocks WHERE symbol = $1", [symbol]);
    res.json({ success: true });
});

app.get('/api/admin/:secret/transactions', async (req, res) => {
    if (req.params.secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    const result = await pool.query("SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY date DESC LIMIT 200");
    res.json(result.rows);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
