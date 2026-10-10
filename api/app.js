// Startup file named in the cPanel "Setup Node.js App" form.
// Under Passenger the port is supplied by the host; locally it comes from PORT.
const { env } = require('./src/config/env');
const { createApp } = require('./src/app');

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`SSCTC Shop API listening on ${env.PORT} (${env.NODE_ENV}), base ${env.API_BASE_PATH}/v1`);
});
