// Sends login codes over SMTP (Gmail / Google Workspace, Outlook, SES, etc.).
const nodemailer = require("nodemailer");

let transport;

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

async function sendOtp(email, code, minutes) {
  if (!smtpConfigured()) {
    // Local testing only — never enable OTP_DEV_LOG in production.
    if (process.env.OTP_DEV_LOG === "true") {
      console.log(`[OTP_DEV_LOG] Login code for ${email}: ${code}`);
      return;
    }
    const err = new Error("Email login is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS.");
    err.status = 503;
    throw err;
  }

  try {
    await getTransport().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: `${code} is your DivOS chat login code`,
      text: `Your DivOS chat login code is ${code}.\n\nIt expires in ${minutes} minutes. If you didn't try to log in, you can ignore this email.`,
      html: `<p>Your DivOS chat login code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
<p>It expires in ${minutes} minutes. If you didn't try to log in, you can ignore this email.</p>`,
    });
  } catch (err) {
    console.error("OTP email failed:", err.message);
    const e = new Error("Could not send the login code email. Please try again.");
    e.status = 502;
    throw e;
  }
}

module.exports = { sendOtp };
