const crypto = require('crypto');

const TICKET_TTL_MS = 2 * 60 * 1000;
const tickets = new Map();

function cleanupExpiredTickets(now = Date.now()) {
  for (const [ticket, item] of tickets.entries()) {
    if (item.expiresAt <= now) tickets.delete(ticket);
  }
}

function issueDownloadTicket(token) {
  cleanupExpiredTickets();
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { token: String(token), expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function consumeDownloadTicket(ticket) {
  cleanupExpiredTickets();
  const key = String(ticket || '');
  const item = tickets.get(key);
  if (!item) return '';
  tickets.delete(key);
  return item.expiresAt > Date.now() ? item.token : '';
}

module.exports = { issueDownloadTicket, consumeDownloadTicket };
