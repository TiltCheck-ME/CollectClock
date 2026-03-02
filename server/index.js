require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

require('./config/passport');
const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Make io accessible to bot
bot.setIo(io);

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Serve static files from the root directory
app.use(express.static(path.join(__dirname, '../')));

// MongoDB Connection
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('Connected to MongoDB'))
        .catch(err => console.error('MongoDB connection error:', err));
}

// Basic Route
app.get('/', (req, res) => {
    res.send('Collect Clock API is running');
});

// Auth Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/auth/failure',
    successRedirect: '/'
}));

app.get('/auth/success', (req, res) => {
    if (req.user) {
        res.json({ message: 'Success', user: req.user });
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// API Routes
app.get('/api/admin/report', async (req, res) => {
    const ADMIN_ID = process.env.ADMIN_DISCORD_ID || '1153034319271559328';
    if (!req.user || req.user.discordId !== ADMIN_ID) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const users = await mongoose.model('User').find({});
        const report = {
            totalUsers: users.length,
            nerfAlerts: [],
            topCasinos: {}
        };

        users.forEach(u => {
            u.casinoSettings.forEach(c => {
                if (c.history && c.history.length > 0) {
                    report.nerfAlerts.push({
                        username: u.username,
                        casino: c.name,
                        history: c.history
                    });
                }
                
                if (c.lastCollected) {
                    report.topCasinos[c.name] = (report.topCasinos[c.name] || 0) + 1;
                }
            });
        });

        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/settings', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({
        casinoSettings: req.user.casinoSettings,
        globalSettings: req.user.globalSettings
    });
});

app.post('/api/user/settings', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { casinoSettings, globalSettings } = req.body;
    
    // Check for bonus changes to track nerfs
    casinoSettings.forEach(newSet => {
        const oldSet = req.user.casinoSettings.find(s => s.name === newSet.name);
        if (oldSet && oldSet.bonusAmount !== newSet.bonusAmount) {
            newSet.history = oldSet.history || [];
            newSet.history.push({
                bonusAmount: oldSet.bonusAmount,
                timestamp: new Date()
            });
        }
    });

    req.user.casinoSettings = casinoSettings;
    req.user.globalSettings = globalSettings;
    try {
        await req.user.save();
        res.json({ message: 'Settings saved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

app.post('/api/submit-casino', async (req, res) => {
    const { name, url } = req.body;
    const DISCORD_WEBHOOK_URL = process.env.DISCORD_SUBMISSION_WEBHOOK;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    console.log(`New Casino Submission: ${name} (${url || 'No URL'})`);

    if (DISCORD_WEBHOOK_URL) {
        try {
            await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `<@1153034319271559328> **New Casino Submission!**`,
                    embeds: [{
                        title: "Submission Details",
                        fields: [
                            { name: "Casino Name", value: name, inline: true },
                            { name: "URL", value: url || "N/A", inline: true },
                            { name: "User", value: req.user ? req.user.username : "Guest", inline: true }
                        ],
                        color: 5763719 // Green
                    }]
                })
            });
        } catch (err) {
            console.error('Failed to send Discord webhook:', err);
        }
    }

    res.json({ message: 'Submitted successfully' });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
