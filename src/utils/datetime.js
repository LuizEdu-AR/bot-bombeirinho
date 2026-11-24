'use strict';
const TIME_ZONE = 'America/Sao_Paulo';
const LOCALE = 'pt-BR';
const dateFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
const longFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const asDate = value => value instanceof Date ? value : new Date(value);
const formatDate = value => dateFormatter.format(asDate(value));
const formatLongDate = value => longFormatter.format(asDate(value));
const formatDateTime = (value = Date.now()) => `${formatDate(value)} às ${timeFormatter.format(asDate(value))} (Brasília)`;
// Preserve the existing date-only storage convention: noon UTC on the local calendar day.
function inspectionDate(value = Date.now()) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(asDate(value)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T12:00:00.000Z`;
}
function addCalendarDays(value, days) {
    const date = new Date(inspectionDate(value));
    date.setUTCDate(date.getUTCDate() + days);
    return date;
}
// Explicit footer instead of Discord's viewer-local embed timestamp.
function withBrasiliaTimestamp(embed, value = Date.now()) {
    const footer = embed.data.footer;
    const text = footer?.text ? `${footer.text} • ${formatDateTime(value)}` : formatDateTime(value);
    embed.setTimestamp(null);
    return embed.setFooter({ ...footer, text });
}
module.exports = { TIME_ZONE, LOCALE, formatDate, formatLongDate, formatDateTime, inspectionDate, addCalendarDays, withBrasiliaTimestamp };
