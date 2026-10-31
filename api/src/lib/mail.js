const { env } = require('../config/env');

/**
 * Email, through the SMTP account set in the SMTP_* variables (on cPanel, a
 * mailbox on the shop's own domain). Used only for the Owner's password codes.
 */

let transport = null;

const mailConfigured = () => Boolean(env.SMTP_HOST && env.SMTP_FROM);

function transporter() {
  // Loaded on first use: if the package is not installed yet, only mail fails, not the whole application.
  transport ||= require('nodemailer').createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transport;
}

async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) throw new Error('Email is not set up on the server.');
  await transporter().sendMail({ from: env.SMTP_FROM, to, subject, text });
}

/** Tests pass an object with its own sendMail, so no mail leaves the machine. */
const useTransport = (replacement) => {
  transport = replacement;
};

module.exports = { mailConfigured, sendMail, useTransport };
