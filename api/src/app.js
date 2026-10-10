const express = require('express');
const helmet = require('helmet');
const { env } = require('./config/env');
const { query } = require('./db/pool');
const { cors, csrfGuard, noStore } = require('./middleware/security');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind Passenger/LiteSpeed the visitor's address arrives in X-Forwarded-For.
  // Trust exactly the configured number of proxies, never the header blindly.
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(cors);
  app.use(noStore);
  app.use(express.json({ limit: '100kb' }));
  app.use(csrfGuard);

  const v1 = express.Router();

  v1.get('/health', async (_req, res) => {
    let database = 'ok';
    try {
      await query('SELECT 1');
    } catch {
      database = 'unavailable';
    }
    res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database });
  });

  v1.use('/auth', require('./modules/auth/routes'));
  v1.use('/portal', require('./modules/portal/routes'));
  v1.use(require('./modules/users/routes'));

  // API_BASE_PATH is "/api" when Passenger passes the full URL through, and ""
  // if it strips the mount path (DEPLOYMENT_PLAN.md, test T5).
  app.use(`${env.API_BASE_PATH}/v1`, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
