/**
 * OpenWord Admin Dashboard Server
 *
 * Provides system monitoring, customer management, and pricing controls
 */

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Import routes
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import customersRoutes from './routes/customers.js';
import pricingRoutes from './routes/pricing.js';
import monitoringRoutes from './routes/monitoring.js';
import analyticsRoutes from './routes/analytics.js';
import costsRoutes from './routes/costs.js';
import charityRegistersRoutes from './routes/charity-registers.js';
import logsRoutes from './routes/logs.js';
import communicationsRoutes from './routes/communications.js';

// Import services
import { startMonitoring } from './services/monitor.js';
import { startConsolidationCron } from './services/usage-consolidation.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(limiter);

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'openword-dashboard-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Auth middleware for protected routes
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

// Routes
app.use('/auth', authRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/customers', requireAuth, customersRoutes);
app.use('/api/pricing', requireAuth, pricingRoutes);
app.use('/api/monitoring', requireAuth, monitoringRoutes);
app.use('/api/logs', requireAuth, logsRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/costs', costsRoutes);
app.use('/api/charity-registers', requireAuth, charityRegistersRoutes);
app.use('/api/communications', requireAuth, communicationsRoutes);

// Page routes
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, '../views/login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

app.get('/customers', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/customers.html'));
});

app.get('/customers/:id', requireAuth, (req, res) => {
  // Redirect to customers page with view parameter to auto-open modal
  res.redirect(`/customers?view=${req.params.id}`);
});

app.get('/pricing', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/pricing.html'));
});

app.get('/monitoring', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/monitoring.html'));
});

app.get('/logs', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/logs.html'));
});

app.get('/charity-registers', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/charity-registers.html'));
});

app.get('/communications', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/communications.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           OpenWord Admin Dashboard                        ║
║                                                           ║
║   Server running on http://localhost:${PORT}                 ║
║                                                           ║
║   Routes:                                                 ║
║   - Dashboard:   http://localhost:${PORT}/                   ║
║   - Customers:   http://localhost:${PORT}/customers          ║
║   - Pricing:     http://localhost:${PORT}/pricing            ║
║   - Costs:       http://localhost:${PORT}/costs              ║
║   - Charities:   http://localhost:${PORT}/charity-registers  ║
║   - Monitoring:  http://localhost:${PORT}/monitoring         ║
║   - Logs:        http://localhost:${PORT}/logs               ║
║   - Analytics:   http://localhost:${PORT}/analytics          ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Start background services
  startMonitoring();
  startConsolidationCron();
});

export default app;
