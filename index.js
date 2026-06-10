require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { Pool } = require('pg');
const cron = require('node-cron');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const conversations = new Map();

// ═══════════════════════════════════════════════════════════════
// STOCKAGE LOCAL (notes + alertes déjà envoyées)
// ═══════════════════════════════════════════════════════════════

const NOTES_FILE = path.join(__dirname, 'notes.json');
const ALERTED_SUBS_FILE = path.join(__dirname, 'alerted-subs.json');
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const FINANCES_FILE = path.join(__dirname, 'finances.json');
const GROWTH_SNAPSHOT_FILE = path.join(__dirname, 'growth-snapshot.json');
const MILESTONES_FILE = path.join(__dirname, 'milestones.json');

function readJSON(file, defaultVal) {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return defaultVal; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function saveNote(text) {
  const notes = readJSON(NOTES_FILE, []);
  notes.push({ text, date: new Date().toISOString() });
  writeJSON(NOTES_FILE, notes);
}

function loadReminders() { return readJSON(REMINDERS_FILE, []); }
function saveReminders(data) { writeJSON(REMINDERS_FILE, data); }

function addReminder({ summary, description, datetime, channelId, userId }) {
  const reminders = loadReminders();
  reminders.push({ id: Date.now().toString(), summary, description, datetime, channelId, userId, sent: false });
  saveReminders(reminders);
}

async function checkPendingReminders() {
  const reminders = loadReminders();
  if (reminders.length === 0) return;

  const now = new Date();
  let changed = false;

  for (const r of reminders) {
    if (r.sent) continue;
    if (now >= new Date(r.datetime)) {
      try {
        const channel = await client.channels.fetch(r.channelId);
        if (channel) {
          const timeLabel = new Date(r.datetime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
          const embed = new EmbedBuilder()
            .setColor(0xFAA61A)
            .setTitle('⏰ Rappel !')
            .setDescription(`**${r.summary}**`)
            .setFooter({ text: `Programmé à ${timeLabel}` });
          if (r.description && r.description !== r.summary) {
            embed.addFields({ name: '📝', value: r.description });
          }
          await channel.send({ content: `<@${r.userId}>`, embeds: [embed] });
        }
      } catch (e) { console.error('[Reminder fire]', e.message); }
      r.sent = true;
      changed = true;
    }
  }

  if (changed) {
    // Garde les rappels envoyés moins de 24h (pour historique), supprime les plus vieux
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    saveReminders(reminders.filter(r => !r.sent || new Date(r.datetime) > cutoff));
  }
}

// ═══════════════════════════════════════════════════════════════
// GMAIL
// ═══════════════════════════════════════════════════════════════

const GMAIL_SEEN_FILE = path.join(__dirname, 'gmail-seen.json');

function getGmailClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

async function checkNewEmails() {
  const channelId = process.env.GMAIL_CHANNEL_ID;
  if (!channelId || channelId === 'REMPLACE_PAR_ID_DU_SALON_EMAIL') return;
  if (!process.env.GMAIL_REFRESH_TOKEN) return;

  const seen = readJSON(GMAIL_SEEN_FILE, { ids: [] });

  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:inbox newer_than:2h',
      maxResults: 15,
    });

    const messages = res.data.messages || [];
    const newMessages = messages.filter(m => !seen.ids.includes(m.id));
    if (newMessages.length === 0) return;

    const channel = await client.channels.fetch(channelId);
    if (!channel) return;

    for (const msg of newMessages.slice(0, 5)) {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload?.headers || [];
      const from = getHeader(headers, 'From');
      const subject = getHeader(headers, 'Subject') || '(sans objet)';
      const date = getHeader(headers, 'Date');
      const snippet = full.data.snippet || '';

      // Analyse IA
      const analysis = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `Tu analyses des emails reçus par Raphaël, fondateur de StudyMind (SaaS edtech).
Réponds en JSON uniquement : {"expediteur":"qui envoie (nom/société)","sujet_resume":"résumé du sujet en 10 mots","urgence":"haute|moyenne|faible","action":"que faire concrètement (1 phrase)"}`,
        messages: [{ role: 'user', content: `De: ${from}\nObjet: ${subject}\nContenu: ${snippet}` }],
      });

      let parsed;
      try { parsed = JSON.parse(analysis.content[0].text.trim()); }
      catch { parsed = { expediteur: from, sujet_resume: subject, urgence: 'faible', action: 'À lire' }; }

      const urgenceColor = { haute: 0xED4245, moyenne: 0xFAA61A, faible: 0x5865F2 };
      const urgenceEmoji = { haute: '🔴', moyenne: '🟡', faible: '🔵' };

      const embed = new EmbedBuilder()
        .setColor(urgenceColor[parsed.urgence] ?? 0x5865F2)
        .setTitle(`✉️ ${parsed.expediteur}`)
        .addFields(
          { name: '📋 Sujet', value: subject.slice(0, 100), inline: false },
          { name: '📝 Résumé', value: parsed.sujet_resume, inline: true },
          { name: `${urgenceEmoji[parsed.urgence] ?? '🔵'} Urgence`, value: parsed.urgence, inline: true },
          { name: '✅ Action', value: parsed.action, inline: false },
        )
        .setFooter({ text: date ? new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '' });

      await channel.send({ embeds: [embed] });
      seen.ids.push(msg.id);
    }

    if (seen.ids.length > 1000) seen.ids = seen.ids.slice(-1000);
    writeJSON(GMAIL_SEEN_FILE, seen);
  } catch (err) {
    console.error('[Gmail check]', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE CALENDAR
// ═══════════════════════════════════════════════════════════════

function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

async function createCalendarEvent(summary, description, dateISO) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const start = new Date(dateISO);
  if (isNaN(start.getTime())) throw new Error('Date invalide : ' + dateISO);

  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(dateISO.trim());
  let eventBody;

  if (isAllDay) {
    const endDate = new Date(start);
    endDate.setDate(endDate.getDate() + 1);
    eventBody = {
      summary, description,
      start: { date: dateISO.trim() },
      end: { date: endDate.toISOString().slice(0, 10) },
    };
  } else {
    const endTime = new Date(start.getTime() + 60 * 60 * 1000);
    eventBody = {
      summary, description,
      start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
      end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Paris' },
    };
  }

  const res = await calendar.events.insert({ calendarId, requestBody: eventBody });
  return res.data;
}

async function getEventsForDate(targetDate) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const startOfDay = new Date(targetDate); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate); endOfDay.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId,
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

async function getUpcomingEvents(days = 7) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });
  return res.data.items || [];
}

// ═══════════════════════════════════════════════════════════════
// STRIPE & BASE DE DONNÉES
// ═══════════════════════════════════════════════════════════════

async function getStripeStats() {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY manquant dans .env');
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400);
  const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);

  const [allSubs, newToday, newThisMonth, balance] = await Promise.all([
    stripe.subscriptions.list({ status: 'active', limit: 100 }),
    stripe.subscriptions.list({ status: 'active', created: { gte: startOfDay }, limit: 100 }),
    stripe.subscriptions.list({ status: 'active', created: { gte: startOfMonth }, limit: 100 }),
    stripe.balance.retrieve(),
  ]);

  const mrr = allSubs.data.reduce((total, sub) => {
    const price = sub.items.data[0]?.price;
    if (!price) return total;
    const amount = price.unit_amount / 100;
    return total + (price.recurring?.interval === 'year' ? amount / 12 : amount);
  }, 0);

  const annualSubs = allSubs.data.filter(s => s.items.data[0]?.price?.recurring?.interval === 'year');

  return {
    activeSubscriptions: allSubs.data.length,
    monthlySubscriptions: allSubs.data.length - annualSubs.length,
    annualSubscriptions: annualSubs.length,
    newToday: newToday.data.length,
    newThisMonth: newThisMonth.data.length,
    mrr: mrr.toFixed(2),
    arr: (mrr * 12).toFixed(2),
    availableBalance: (balance.available.reduce((s, b) => s + b.amount, 0) / 100).toFixed(2),
  };
}

async function getDbStats() {
  if (!db) throw new Error('DATABASE_URL manquant dans .env');
  const [totalRes, planRes, newTodayRes, newWeekRes] = await Promise.all([
    db.query('SELECT COUNT(*) as count FROM "User"'),
    db.query('SELECT plan, COUNT(*) as count FROM "User" GROUP BY plan'),
    db.query('SELECT COUNT(*) as count FROM "User" WHERE "createdAt" >= CURRENT_DATE'),
    db.query(`SELECT COUNT(*) as count FROM "User" WHERE "createdAt" >= NOW() - INTERVAL '7 days'`),
  ]);

  const plans = {};
  planRes.rows.forEach(row => { plans[row.plan] = parseInt(row.count); });
  const total = parseInt(totalRes.rows[0].count);
  const premium = plans['premium'] ?? 0;

  return {
    totalUsers: total,
    newToday: parseInt(newTodayRes.rows[0].count),
    newThisWeek: parseInt(newWeekRes.rows[0].count),
    freeUsers: plans['free'] ?? 0,
    premiumUsers: premium,
    conversionRate: total > 0 ? ((premium / total) * 100).toFixed(1) : '0',
  };
}

async function getMonthlyPayments(year, month) {
  if (!stripe || !db) throw new Error('Stripe ou DB non configuré');
  const startOfMonth = Math.floor(new Date(year, month, 1).getTime() / 1000);
  const startOfNextMonth = Math.floor(new Date(year, month + 1, 1).getTime() / 1000);

  const invoices = await stripe.invoices.list({
    status: 'paid',
    created: { gte: startOfMonth, lt: startOfNextMonth },
    limit: 100,
  });

  const payments = [];
  for (const invoice of invoices.data) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId || !invoice.amount_paid) continue;
    const customer = await stripe.customers.retrieve(customerId);
    const result = await db.query(
      'SELECT "firstName", email, "planInterval" FROM "User" WHERE "stripeCustomerId" = $1',
      [customerId]
    );
    const dbUser = result.rows[0];
    payments.push({
      name: dbUser?.firstName || customer.name || 'N/A',
      email: dbUser?.email || customer.email || 'N/A',
      plan: dbUser?.planInterval === 'year' ? 'Annuel' : 'Mensuel',
      amount: (invoice.amount_paid / 100).toFixed(2),
    });
  }
  return payments;
}

// ═══════════════════════════════════════════════════════════════
// DISCORD EMBEDS
// ═══════════════════════════════════════════════════════════════

function buildStatsEmbed(stripeData, dbData) {
  const now = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📊 StudyMind — Dashboard')
    .setFooter({ text: `Mis à jour ${now}` });

  if (stripeData) {
    embed.addFields(
      { name: '💰 MRR', value: `**${stripeData.mrr} €**`, inline: true },
      { name: '📈 ARR', value: `**${stripeData.arr} €**`, inline: true },
      { name: '💳 Solde dispo', value: `**${stripeData.availableBalance} €**`, inline: true },
      { name: '👤 Abonnés actifs', value: `${stripeData.activeSubscriptions} (${stripeData.monthlySubscriptions} mensuel · ${stripeData.annualSubscriptions} annuel)`, inline: false },
      { name: "🆕 Aujourd'hui", value: `${stripeData.newToday} nouveau(x)`, inline: true },
      { name: '📅 Ce mois', value: `${stripeData.newThisMonth} nouveau(x)`, inline: true },
    );
  }

  if (dbData) {
    embed.addFields(
      { name: '​', value: '**── Base de données ──**' },
      { name: '👥 Total inscrits', value: `**${dbData.totalUsers.toLocaleString('fr-FR')}**`, inline: true },
      { name: '🎯 Conversion', value: `**${dbData.conversionRate}%**`, inline: true },
      { name: '📊 Free / Premium', value: `${dbData.freeUsers} / ${dbData.premiumUsers}`, inline: true },
      { name: "🆕 Inscrits auj.", value: `${dbData.newToday}`, inline: true },
      { name: '📆 Cette semaine', value: `${dbData.newThisWeek}`, inline: true },
    );
  }

  if (!stripeData && !dbData) {
    embed.setDescription(
      '⚠️ Stripe et DB non configurés.\nAjoute `STRIPE_SECRET_KEY` et `DATABASE_URL` dans `.env` pour voir les vraies métriques.'
    );
  }

  return embed;
}

function buildCalendarEmbed(events, dayLabel) {
  const embed = new EmbedBuilder()
    .setColor(0x43B581)
    .setTitle(`📅 Rappels — ${dayLabel}`);

  if (events.length === 0) {
    embed.setDescription('Aucun rappel aujourd\'hui. Bonne journée ! 🚀');
    return embed;
  }

  let description = '';
  for (const event of events) {
    const time = event.start?.dateTime
      ? new Date(event.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : null;
    description += time ? `🕐 **${time}** — **${event.summary}**` : `📌 **${event.summary}**`;
    if (event.description && event.description !== event.summary) {
      description += `\n> ${event.description}`;
    }
    description += '\n\n';
  }

  embed.setDescription(description.trim());
  embed.setFooter({ text: `${events.length} rappel${events.length > 1 ? 's' : ''} aujourd'hui` });
  return embed;
}

// ═══════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════

async function sendDailyReminders() {
  const channelId = process.env.CALENDRIER_CHANNEL_ID || process.env.AGENT_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const today = new Date();
    const dayLabel = today.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Rappels Google Calendar
    let calEvents = [];
    if (process.env.GOOGLE_CALENDAR_ID) {
      try { calEvents = await getEventsForDate(today); } catch (e) { console.error('[Cal]', e.message); }
    }

    // Rappels locaux du jour (non encore envoyés)
    const todayStr = today.toISOString().slice(0, 10);
    const localReminders = loadReminders().filter(r => {
      if (r.sent) return false;
      return r.datetime.slice(0, 10) === todayStr;
    });

    const embed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle(`📅 Rappels du jour — ${dayLabel}`);

    let description = '';

    if (calEvents.length === 0 && localReminders.length === 0) {
      description = 'Aucun rappel aujourd\'hui. Bonne journée ! 🚀';
    } else {
      // Affiche d'abord les rappels locaux (avec heure précise)
      if (localReminders.length > 0) {
        for (const r of localReminders.sort((a, b) => new Date(a.datetime) - new Date(b.datetime))) {
          const timeLabel = new Date(r.datetime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
          description += `⏰ **${timeLabel}** — **${r.summary}**\n`;
          if (r.description && r.description !== r.summary) description += `> ${r.description}\n`;
          description += '\n';
        }
      }
      // Puis les événements Google Calendar
      for (const event of calEvents) {
        const time = event.start?.dateTime
          ? new Date(event.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
          : null;
        description += time ? `🗓️ **${time}** — **${event.summary}**` : `📌 **${event.summary}**`;
        if (event.description && event.description !== event.summary) description += `\n> ${event.description}`;
        description += '\n\n';
      }
    }

    embed.setDescription(description.trim());
    const total = calEvents.length + localReminders.length;
    if (total > 0) embed.setFooter({ text: `${total} rappel${total > 1 ? 's' : ''} aujourd'hui` });
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Daily reminders]', err);
  }
}

async function sendMorningDigest() {
  const channelId = process.env.STATS_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;

    let stripeData = null, dbData = null;
    if (stripe) { try { stripeData = await getStripeStats(); } catch (e) { console.error('[Digest Stripe]', e.message); } }
    if (db) { try { dbData = await getDbStats(); } catch (e) { console.error('[Digest DB]', e.message); } }

    if (!stripeData && !dbData) return;

    const now = new Date();
    const day = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const embed = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle(`☀️ Rapport du ${day}`);

    if (stripeData) {
      embed.addFields(
        { name: '💰 MRR', value: `${stripeData.mrr} €`, inline: true },
        { name: '👤 Abonnés', value: `${stripeData.activeSubscriptions}`, inline: true },
        { name: "🆕 Aujourd'hui", value: `+${stripeData.newToday}`, inline: true },
      );
    }
    if (dbData) {
      embed.addFields(
        { name: '👥 Inscrits total', value: `${dbData.totalUsers.toLocaleString('fr-FR')}`, inline: true },
        { name: '🎯 Conversion', value: `${dbData.conversionRate}%`, inline: true },
        { name: '🆕 Inscrits auj.', value: `${dbData.newToday}`, inline: true },
      );
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Morning digest]', err);
  }
}

async function sendMonthlyReport(channel, year, month) {
  const monthName = new Date(year, month, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  try {
    const payments = await getMonthlyPayments(year, month);

    if (payments.length === 0) {
      await channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`📊 Rapport mensuel — ${monthName}`)
          .setDescription('Aucun paiement enregistré ce mois-ci.'),
      ]});
      return;
    }

    const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📊 Rapport mensuel — ${monthName}`)
      .setDescription(`**${payments.length} paiement(s)** · Total encaissé : **${total.toFixed(2)} €**`);

    let details = '';
    payments.forEach((p, i) => {
      details += `${i + 1}. **${p.name}** — ${p.email} — ${p.plan} — ${p.amount} €\n`;
    });

    for (let i = 0; i < details.length; i += 1000) {
      embed.addFields({ name: i === 0 ? 'Détail des paiements' : '​', value: details.slice(i, i + 1000) });
    }

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[Rapport mensuel]', error);
    await channel.send('❌ Erreur lors du rapport mensuel : ' + error.message);
  }
}

async function checkNewSubscribers() {
  if (!stripe || !process.env.ALERTES_CHANNEL_ID) return;

  const store = readJSON(ALERTED_SUBS_FILE, { ids: [] });
  const tenMinAgo = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);

  try {
    const newSubs = await stripe.subscriptions.list({
      status: 'active',
      created: { gte: tenMinAgo },
      limit: 10,
      expand: ['data.customer'],
    });

    for (const sub of newSubs.data) {
      if (store.ids.includes(sub.id)) continue;

      const customer = typeof sub.customer === 'object' ? sub.customer : await stripe.customers.retrieve(sub.customer);
      const price = sub.items.data[0]?.price;
      const amount = price ? (price.unit_amount / 100).toFixed(2) : '?';
      const interval = price?.recurring?.interval === 'year' ? '🗓️ Annuel' : '📅 Mensuel';

      try {
        const channel = await client.channels.fetch(process.env.ALERTES_CHANNEL_ID);
        const embed = new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Nouveau Premium !')
          .addFields(
            { name: '👤 Client', value: customer.name || 'N/A', inline: true },
            { name: '📧 Email', value: customer.email || 'N/A', inline: true },
            { name: '💰 Montant', value: `${amount} €`, inline: true },
            { name: '📅 Plan', value: interval, inline: true },
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      } catch (e) { console.error('[Alert send]', e.message); }

      store.ids.push(sub.id);
      if (store.ids.length > 500) store.ids = store.ids.slice(-500);
    }

    writeJSON(ALERTED_SUBS_FILE, store);
  } catch (err) {
    console.error('[New sub check]', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// FINANCES
// ═══════════════════════════════════════════════════════════════

function loadFinances() {
  return readJSON(FINANCES_FILE, { balance: { current: 0, incoming: [] }, expenses: [] });
}

function euros(n) {
  return n != null ? `${Number(n).toFixed(2)} €` : 'variable';
}

function urgencyDot(daysLeft) {
  if (daysLeft <= 3)  return '🔴';
  if (daysLeft <= 7)  return '🟠';
  if (daysLeft <= 14) return '🟡';
  return '🟢';
}

function estimatedBalance(fin) {
  const incoming = fin.balance.incoming.reduce((s, i) => s + i.amount, 0);
  const total    = fin.balance.current + incoming;
  const fixed    = fin.expenses
    .filter(e => e.amount != null && e.amount > 0 && e.dueInDays <= 30)
    .reduce((s, e) => s + e.amount, 0);
  return { total, fixed, remaining: total - fixed };
}

async function buildFinancesEmbed() {
  const fin = loadFinances();
  const bal = estimatedBalance(fin);

  // Stripe revenue
  let stripeData = null;
  try { if (stripe) stripeData = await getStripeStats(); } catch { /* noop */ }

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('📊 StudyMind — Vue financière')
    .setTimestamp()
    .setFooter({ text: 'studymind.net' });

  // Solde & entrées
  const balLines = [
    `Solde actuel : **${euros(fin.balance.current)}**`,
    ...fin.balance.incoming.map(i => `+ ${euros(i.amount)} dans ${i.inDays}j _(${i.label})_`),
    `\n**Total disponible : ${euros(bal.total)}**`,
  ];
  embed.addFields({ name: '💳 Solde & entrées', value: balLines.join('\n'), inline: false });

  // Charges à venir (30 jours)
  const chargesLines = fin.expenses
    .filter(e => e.dueInDays <= 30 && e.amount > 0)
    .sort((a, b) => a.dueInDays - b.dueInDays)
    .map(e => `${urgencyDot(e.dueInDays)} ${e.icon} **${e.name}** — ${euros(e.amount)} (J+${e.dueInDays})`)
    .join('\n');
  embed.addFields({ name: '📋 Charges (30 prochains jours)', value: chargesLines || 'Aucune', inline: false });

  // Stripe
  if (stripeData) {
    const mrrLine = `MRR : **${euros(stripeData.mrr)}** | ARR : **${euros(stripeData.arr)}**\nAbonnés actifs : **${stripeData.activeSubscriptions}** (${stripeData.monthlySubscriptions} mensuel, ${stripeData.annualSubscriptions} annuel)\nNouveaux ce mois : ${stripeData.newThisMonth}`;
    embed.addFields({ name: '💰 Revenus Stripe', value: mrrLine, inline: false });
  }

  // Résultat
  const rem = bal.remaining;
  const remStatus = rem > 80 ? '✅ Confortable' : rem > 30 ? '⚠️ Marge faible' : '🚨 Budget serré';
  embed.addFields({
    name: '📈 Solde après charges fixes',
    value: `**${euros(rem)}** — ${remStatus}`,
    inline: false,
  });

  // 🤖 Crédits Anthropic API
  if (fin.apiCredits?.anthropic) {
    const api = fin.apiCredits.anthropic;
    const daysLeft = api.estimatedDailyBurn > 0
      ? Math.floor(api.balance / api.estimatedDailyBurn)
      : 99;
    const apiStatus = api.balance < api.alertThreshold
      ? '🚨 RECHARGER MAINTENANT'
      : api.balance < api.alertThreshold * 2
      ? '⚠️ Bientôt vide'
      : '✅ OK';
    embed.addFields({
      name: '🤖 Crédits Anthropic API',
      value: `Solde : **${euros(api.balance)}** — ${apiStatus}\nBurn estimé : ~${euros(api.estimatedDailyBurn)}/jour → **${daysLeft} jours** restants\nSeuil d'alerte : ${euros(api.alertThreshold)} | _Recharger sur console.anthropic.com_`,
      inline: false,
    });
  }

  return embed;
}

// ═══════════════════════════════════════════════════════════════
// CROISSANCE — rapport hebdo + alertes milestones
// ═══════════════════════════════════════════════════════════════

// Milestones à surveiller (dans l'ordre)
const MILESTONE_DEFS = [
  { key: 'premium_1',   label: '🥇 Premier abonné Premium !',       type: 'premium', value: 1 },
  { key: 'premium_5',   label: '🎯 5 abonnés Premium !',            type: 'premium', value: 5 },
  { key: 'premium_10',  label: '🚀 10 abonnés Premium !',           type: 'premium', value: 10 },
  { key: 'premium_25',  label: '💎 25 abonnés Premium !',           type: 'premium', value: 25 },
  { key: 'premium_50',  label: '🏆 50 abonnés Premium !',           type: 'premium', value: 50 },
  { key: 'premium_100', label: '👑 100 abonnés Premium !',          type: 'premium', value: 100 },
  { key: 'mrr_50',      label: '💰 50€ MRR atteints !',             type: 'mrr',     value: 50 },
  { key: 'mrr_100',     label: '💰 100€ MRR atteints !',            type: 'mrr',     value: 100 },
  { key: 'mrr_250',     label: '💰 250€ MRR atteints !',            type: 'mrr',     value: 250 },
  { key: 'mrr_500',     label: '🤑 500€ MRR atteints !',            type: 'mrr',     value: 500 },
  { key: 'mrr_1000',    label: '🎰 1 000€ MRR — ça devient sérieux !', type: 'mrr', value: 1000 },
  { key: 'users_50',    label: '👥 50 inscrits !',                  type: 'users',   value: 50 },
  { key: 'users_100',   label: '👥 100 inscrits !',                 type: 'users',   value: 100 },
  { key: 'users_500',   label: '👥 500 inscrits !',                 type: 'users',   value: 500 },
  { key: 'users_1000',  label: '🌍 1 000 inscrits — produit validé !', type: 'users', value: 1000 },
];

async function checkMilestones(stripeData, dbData) {
  const channelId = process.env.CROISSANCE_CHANNEL_ID;
  if (!channelId || (!stripeData && !dbData)) return;

  const achieved = readJSON(MILESTONES_FILE, { done: [] });

  for (const m of MILESTONE_DEFS) {
    if (achieved.done.includes(m.key)) continue;

    let reached = false;
    if (m.type === 'premium' && stripeData) reached = stripeData.activeSubscriptions >= m.value;
    if (m.type === 'mrr'     && stripeData) reached = stripeData.mrr >= m.value;
    if (m.type === 'users'   && dbData)     reached = dbData.totalUsers >= m.value;

    if (reached) {
      try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;

        const embed = new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle(`🎉 MILESTONE DÉBLOQUÉ`)
          .setDescription(`## ${m.label}`)
          .addFields(
            stripeData ? { name: '💰 MRR actuel', value: `**${stripeData.mrr}€**`, inline: true } : [],
            stripeData ? { name: '👥 Premium actifs', value: `**${stripeData.activeSubscriptions}**`, inline: true } : [],
            dbData     ? { name: '📊 Total inscrits', value: `**${dbData.totalUsers}**`, inline: true } : [],
          ).filter(f => f)
          .setTimestamp()
          .setFooter({ text: 'studymind.net — continue comme ça 🚀' });

        await channel.send({ embeds: [embed] });
        achieved.done.push(m.key);
        writeJSON(MILESTONES_FILE, achieved);
      } catch (err) { console.error('[Milestone]', err.message); }
    }
  }
}

async function sendWeeklyGrowthReport() {
  const channelId = process.env.CROISSANCE_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // Stats actuelles
    let stripeData = null, dbData = null;
    try { if (stripe) stripeData = await getStripeStats(); } catch { /* noop */ }
    try { if (db) dbData = await getDbStats(); } catch { /* noop */ }

    if (!stripeData && !dbData) return;

    // Snapshot de la semaine dernière
    const snap = readJSON(GROWTH_SNAPSHOT_FILE, null);
    const now = new Date();

    // Calcul des variations
    const diffUsers   = snap ? (dbData?.totalUsers ?? 0) - (snap.totalUsers ?? 0) : null;
    const diffPremium = snap ? (stripeData?.activeSubscriptions ?? 0) - (snap.premiumUsers ?? 0) : null;
    const diffMrr     = snap ? (stripeData?.mrr ?? 0) - (snap.mrr ?? 0) : null;
    const convRate    = dbData && stripeData && dbData.totalUsers > 0
      ? ((stripeData.activeSubscriptions / dbData.totalUsers) * 100).toFixed(1)
      : '—';

    function delta(n) {
      if (n === null) return '—';
      return n > 0 ? `+${n}` : `${n}`;
    }
    function deltaMrr(n) {
      if (n === null) return '—';
      return n > 0 ? `+${n.toFixed(2)}€` : `${n.toFixed(2)}€`;
    }
    function trend(n) {
      if (n === null || n === 0) return '➡️';
      return n > 0 ? '📈' : '📉';
    }

    // Générer les 3 actions prioritaires via Claude
    let actions = '1. Continue à poster sur TikTok 3x/semaine\n2. Analyse les mails des nouveaux inscrits\n3. Vérifie le taux de conversion';
    try {
      const prompt = `StudyMind SaaS stats cette semaine:
- Inscrits: ${dbData?.totalUsers ?? '?'} total (${delta(diffUsers)} vs semaine dernière)
- Premium: ${stripeData?.activeSubscriptions ?? '?'} (${delta(diffPremium)} vs semaine dernière)
- MRR: ${stripeData?.mrr ?? '?'}€ (${deltaMrr(diffMrr)} vs semaine dernière)
- Conversion: ${convRate}%
- Nouveaux abonnés ce mois: ${stripeData?.newThisMonth ?? '?'}

Donne 3 actions CONCRÈTES et ACTIONNABLES pour cette semaine pour améliorer ces métriques. Format: liste numérotée, 1 ligne par action, très concis.`;

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      actions = resp.content[0].text.trim();
    } catch { /* garde les actions par défaut */ }

    // Construire l'embed
    const weekLabel = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle(`📈 Rapport hebdomadaire — ${weekLabel}`)
      .setTimestamp()
      .setFooter({ text: 'studymind.net' });

    if (dbData) {
      embed.addFields({
        name: `👥 Utilisateurs  ${trend(diffUsers)}`,
        value: `Total : **${dbData.totalUsers}** inscrits\nCette semaine : **${delta(diffUsers)}** nouveaux\nAujourd'hui : **+${dbData.newToday}** | Cette semaine : **+${dbData.newThisWeek}**`,
        inline: false,
      });
    }

    if (stripeData) {
      embed.addFields({
        name: `💰 Revenus  ${trend(diffMrr)}`,
        value: `MRR : **${stripeData.mrr}€** (${deltaMrr(diffMrr)} vs S-1)\nARR : **${stripeData.arr}€**\nPremium actifs : **${stripeData.activeSubscriptions}** (${delta(diffPremium)} vs S-1)\nConversion : **${convRate}%**`,
        inline: false,
      });
    }

    embed.addFields({
      name: '🎯 Top 3 actions cette semaine',
      value: actions,
      inline: false,
    });

    await channel.send({ embeds: [embed] });

    // Sauvegarde snapshot pour la semaine prochaine
    writeJSON(GROWTH_SNAPSHOT_FILE, {
      date: now.toISOString(),
      totalUsers: dbData?.totalUsers ?? 0,
      premiumUsers: stripeData?.activeSubscriptions ?? 0,
      mrr: stripeData?.mrr ?? 0,
    });

  } catch (err) { console.error('[Weekly growth]', err.message); }
}

// ═══════════════════════════════════════════════════════════════
// SECRÉTAIRE FINANCIER — channel dédié
// ═══════════════════════════════════════════════════════════════

const SECRETAIRE_SYSTEM = `Tu es le secrétaire financier de Raphaël, fondateur de StudyMind (SaaS edtech).
Tu gères ses finances personnelles liées au SaaS dans ce channel Discord dédié.

**Tes données en temps réel (finances.json) :**
- balance.current : solde actuel en euros
- balance.incoming : virements attendus (label, amount, inDays)
- expenses : charges mensuelles (name, icon, amount, dueInDays, billingCycle, note)

**Charges connues du SaaS :**
- Vercel Pro : 18€/mois (hébergement)
- Claude API (Anthropic) : ~18€/mois (IA de l'app)
- Google One : 22€/mois
- Domaine studymind.net : 13€/an
- Resend Pro : 18€/mois (emails marketing — 50 000/mois)
- Railway Hobby : 5$/mois (hébergement bot Discord)
- Revenues : Stripe Premium (6,99€/mois ou 69,99€/an par abonné)

**Crédits API Anthropic (suivi séparé) :**
- Raphaël recharge manuellement par tranches de 20€ sur console.anthropic.com
- Burn estimé : ~0,80€/jour (varie selon trafic app)
- Alerte automatique quand < 5€

**Quand Raphaël te dit quelque chose, tu dois retourner un JSON UNIQUEMENT dans ce format :**
{
  "action": "update" | "status" | "respond",
  "message": "ta réponse courte en français (max 3 phrases)",
  "changes": {          // seulement si action = "update"
    "balance_current": 50,         // nouveau solde (si mentionné)
    "add_incoming": { "label": "...", "amount": 0, "inDays": 0 },  // si virement attendu
    "clear_incoming": true,        // si on veut vider les entrées attendues
    "update_expense": { "name": "...", "dueInDays": 0, "amount": 0 },  // si charge modifiée
    "add_expense": { "name": "...", "icon": "💸", "amount": 0, "dueInDays": 0, "billingCycle": "mensuel", "note": "" },
    "mark_paid": "NomDeLaCharge",  // remet dueInDays à 30 pour cette charge
    "recharge_anthropic": 20       // AJOUTE ce montant aux crédits Anthropic API
  },
  "show_embed": true | false       // true si tu veux afficher le résumé financier complet
}

**Règles :**
- "j'ai payé Vercel" → action update, mark_paid: "Vercel Pro", show_embed: true
- "mon solde est 80€" → action update, balance_current: 80, show_embed: true
- "j'attends 50€ vendredi" → action update, add_incoming avec inDays estimé, show_embed: false
- "c'est quoi ma situation ?" → action status, show_embed: true
- "j'ai rechargé 20€ sur Anthropic/Claude" → action update, recharge_anthropic: 20, show_embed: true
- question/discussion → action respond, show_embed: false
- Toujours analyser : est-ce qu'on est en positif après les charges du mois prochain ?
- Répondre en français, tutoyer Raphaël, être direct et concis`;

async function handleSecretaire(message, financesData, stripeData) {
  const fin = financesData;
  const bal = estimatedBalance(fin);

  const context = `Données actuelles :
Solde=${fin.balance.current}€ | Entrées=${JSON.stringify(fin.balance.incoming)} | Total dispo=${bal.total.toFixed(2)}€ | Charges30j=${bal.fixed.toFixed(2)}€ | Net=${bal.remaining.toFixed(2)}€
${stripeData ? `MRR=${stripeData.mrr}€ | Abonnés=${stripeData.activeSubscriptions}` : ''}
Charges: ${fin.expenses.filter(e => e.amount > 0).map(e => `${e.name}=${e.amount}€ J+${e.dueInDays}`).join(', ')}

Message: "${message.slice(0, 800)}"`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SECRETAIRE_SYSTEM,
    messages: [{ role: 'user', content: context }],
  });

  const raw = response.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    const parsed = JSON.parse(raw);
    // Valider la structure minimale
    if (!parsed.action) parsed.action = 'respond';
    if (!parsed.message) parsed.message = 'Données mises à jour.';
    return parsed;
  } catch {
    return { action: 'respond', message: raw.slice(0, 500), show_embed: false };
  }
}

function applyFinancesChanges(fin, changes) {
  if (!changes) return fin;
  const updated = JSON.parse(JSON.stringify(fin)); // deep copy

  try {
    if (changes.balance_current !== undefined && changes.balance_current !== null) {
      updated.balance.current = Number(changes.balance_current);
    }
    if (changes.add_incoming && changes.add_incoming.amount) {
      updated.balance.incoming.push(changes.add_incoming);
    }
    if (changes.clear_incoming) {
      updated.balance.incoming = [];
    }
    if (changes.update_expense && changes.update_expense.name) {
      const exp = updated.expenses.find(e =>
        e.name && e.name.toLowerCase().includes(changes.update_expense.name.toLowerCase())
      );
      if (exp) {
        if (changes.update_expense.dueInDays !== undefined) exp.dueInDays = changes.update_expense.dueInDays;
        if (changes.update_expense.amount !== undefined) exp.amount = changes.update_expense.amount;
      }
    }
    if (changes.add_expense && changes.add_expense.name) {
      updated.expenses.push(changes.add_expense);
    }
    if (changes.mark_paid && typeof changes.mark_paid === 'string') {
      const exp = updated.expenses.find(e =>
        e.name && e.name.toLowerCase().includes(changes.mark_paid.toLowerCase())
      );
      if (exp) exp.dueInDays = 30;
    }
    // Recharge crédits Anthropic API
    if (changes.recharge_anthropic !== undefined && changes.recharge_anthropic !== null) {
      if (!updated.apiCredits) updated.apiCredits = {};
      if (!updated.apiCredits.anthropic) updated.apiCredits.anthropic = { balance: 0, alertThreshold: 5, estimatedDailyBurn: 0.80 };
      updated.apiCredits.anthropic.balance = Math.round((updated.apiCredits.anthropic.balance + Number(changes.recharge_anthropic)) * 100) / 100;
      updated.apiCredits.anthropic.lastRecharge = new Date().toISOString().slice(0, 10);
    }
    // Mise à jour burn rate Anthropic
    if (changes.anthropic_daily_burn !== undefined) {
      if (!updated.apiCredits?.anthropic) {
        if (!updated.apiCredits) updated.apiCredits = {};
        updated.apiCredits.anthropic = { balance: 0, alertThreshold: 5, estimatedDailyBurn: 0.80 };
      }
      updated.apiCredits.anthropic.estimatedDailyBurn = Number(changes.anthropic_daily_burn);
    }
  } catch (err) {
    console.error('[applyFinancesChanges]', err.message);
  }

  return updated;
}

// ═══════════════════════════════════════════════════════════════
// INTENT DETECTION
// ═══════════════════════════════════════════════════════════════

function detectIntent(text) {
  const t = text.toLowerCase().trim();

  if (['!stats', '!dashboard', '!kpi'].includes(t)) return 'stats';
  if (t === '!rapport' || t.startsWith('!rapport ')) return 'report';
  if (['!agenda', '!rappels', '!calendrier'].includes(t)) return 'agenda';
  if (t === '!notes') return 'notes_view';
  if (['!finances', '!finance', '!budget', '!charges', '!depenses', '!dépenses'].includes(t)) return 'finances';
  if (['!solde', '!cashflow', '!tresorerie', '!trésorerie'].includes(t)) return 'solde';

  const statsKw = ['mrr', 'arr', 'chiffre d\'affaires', 'combien d\'abonnés', 'combien d\'inscrits', 'dashboard', 'kpi', 'mes stats', 'mes métriques'];
  if (statsKw.some(k => t.includes(k))) return 'stats';

  const reportKw = ['rapport mensuel', 'rapport du mois', 'paiements du mois', 'qui a payé', 'liste des paiements', 'liste des abonnés payants'];
  if (reportKw.some(k => t.includes(k))) return 'report';

  const agendaKw = ['mon agenda', 'mes rappels', 'prochains rappels', 'quoi cette semaine', 'prochain événement', "c'est quoi cette semaine", 'voir mes rappels'];
  if (agendaKw.some(k => t.includes(k))) return 'agenda';

  const reminderKw = ['rappelle-moi', 'rappelle moi', 'rappel :', "n'oublie pas", 'ajoute au calendrier', 'mets dans le calendrier', 'planifie', 'lundi prochain', 'mardi prochain', 'mercredi prochain', 'jeudi prochain', 'vendredi prochain', 'samedi prochain', 'dimanche prochain', 'la semaine prochaine', 'dans une semaine', 'dans deux semaines', 'demain matin', 'ce soir', 'ajoute un rappel', 'crée un rappel', 'dans une heure', 'dans deux heures'];
  if (reminderKw.some(k => t.includes(k))) return 'reminder';
  if (/dans \d+h\d*/.test(t) || /dans \d+ ?(min|minute|heure)/.test(t) || /rappelle.{0,10}dans/.test(t) || /à \d{1,2}h\d{0,2}/.test(t)) return 'reminder';

  const noteKw = ['note ça', 'note ceci', 'sauvegarde ça', 'enregistre ça', 'garde en mémoire', 'idée :', 'mémorise ça'];
  if (noteKw.some(k => t.includes(k))) return 'note_save';

  return 'conversation';
}

// ═══════════════════════════════════════════════════════════════
// EXTRACT REMINDER DETAILS VIA CLAUDE
// ═══════════════════════════════════════════════════════════════

async function extractReminderDetails(userMessage) {
  const now = new Date();
  const todayFR = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeFR = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const nowISO = now.toISOString();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Tu extrais des rappels depuis des messages français. Maintenant : ${todayFR} à ${timeFR} (ISO: ${nowISO}).
Retourne UNIQUEMENT un JSON valide sans markdown :
{"summary":"Titre court (10 mots max)","description":"Description complète","datetime":"YYYY-MM-DDTHH:MM:00+02:00","hasTime":true}
Règles :
- "dans 1h30" → ajoute 1h30 à l'heure actuelle
- "dans 30 minutes" / "dans 2h" → calcule depuis maintenant
- "à 15h" / "à 15h30" → cette heure aujourd'hui (ou demain si déjà passée)
- "ce soir à 20h" → aujourd'hui 20:00
- "demain matin" → demain 09:00, hasTime: true
- Pas d'heure → hasTime: false, utilise 08:00 le bon jour
- Timezone Europe/Paris = +02:00 en été, +01:00 en hiver
Ne retourne QUE le JSON.`,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(raw);
  if (!parsed.datetime && parsed.date) {
    parsed.datetime = parsed.date + 'T08:00:00+02:00';
    parsed.hasTime = false;
  }
  return parsed;
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Tu es l'agent IA de Raphaël — son co-fondateur virtuel, bras droit et expert business pour son SaaS StudyMind.

**StudyMind** : SaaS edtech B2C français — tuteur IA + planning + flashcards pour les élèves de la 6ème au Bac+2.
- Freemium : gratuit (20 msgs/jour) → Premium Mensuel 6.99€ (1er mois 3.99€) → Premium Annuel 69.99€/an
- Stack : Next.js 15, TypeScript, Tailwind CSS v4, ShadCN UI, Prisma + PostgreSQL, Stripe, Cloudflare Turnstile
- Raphaël est le seul fondateur — il gère tout : produit, code, marketing, TikTok

**TES CAPACITÉS :**

📊 **STATS** — métriques Stripe en temps réel (MRR, ARR, abonnés, conversion)
📋 **RAPPORT MENSUEL** — liste complète des paiements du mois
📅 **RAPPELS** — créer des événements Google Calendar
🗓️ **AGENDA** — voir les prochains rappels
📝 **NOTES** — sauvegarder des idées importantes
📱 **TIKTOK** — scripts optimisés pour l'algo FR
📧 **EMAILS** — séquences de nurturing, newsletters, cold emails
🎯 **STRATÉGIE** — croissance, pricing, acquisition, conversion, rétention
💡 **BRAINSTORMING** — features, offres, partenariats, growth hacks
✍️ **COPYWRITING** — landing pages, accroches, CTA, posts LinkedIn/Instagram
📞 **PITCH** — élévator pitch, présentation investisseurs, message créateur de contenu

**COMMANDES RAPIDES :**
!stats → dashboard métriques
!rapport → rapport mensuel des paiements
!agenda → prochains rappels calendrier (7 jours)
!notes → tes notes sauvegardées
!finances → vue complète : solde, charges, revenus Stripe
!solde → solde rapide après charges

---

**CONNAISSANCE TIKTOK STUDYMIND :**

Format FR (< 9s, watchtime parfait) :
- [0-4s] Screenshots notes excellentes qui défilent vite (17/20, 18/20, 20/20)
- [4-9s] Plan accéléré de l'app (flashcards, photo cours, planning)
- Caption : courte + 1 emoji, 0 hashtag

Format US d'inspiration (< 15s) :
- [0-2s] Hook choc : "cette app devrait être illégale 🚨" ou "j'aurais voulu avoir ça en 3ème"
- [2-10s] B-roll : personnes qui travaillent dans espaces esthétiques/clean
- [10-15s] Demo rapide app

Hooks qui marchent : "cette app sauve mes notes 📚" | "comment j'ai eu 18 en maths avec ça 🤯" | "mon tuteur IA a changé ma vie" | "j'ai passé mon bac avec ça 🎓" | "l'app qui devrait être interdite dans les lycées 🚨"

Format script à générer :
🎬 DURÉE : X secondes
🎵 MUSIQUE : [type son à chercher]
📱 CAPTION : [texte exact]
PLAN PAR PLAN :
[0-Xs] description précise de ce qu'on voit
💡 CONSEIL MONTAGE : [tip spécifique]

---

**RÈGLES :**
- Réponds TOUJOURS en français
- Tutoie Raphaël, sois direct et concis comme un vrai co-fondateur
- Conseils actionnables, pas de théorie inutile
- Quand tu crées un rappel, confirme toujours la date et le titre
- Quand tu analyses des données, donne ton avis (bon/mauvais signe, opportunité, risque)
- Tu peux suggérer des actions concrètes à prendre immédiatement`;

// ═══════════════════════════════════════════════════════════════
// DISCORD EVENTS
// ═══════════════════════════════════════════════════════════════

client.on('clientReady', () => {
  console.log(`✅ StudyMind Agent connecté : ${client.user.tag}`);
  console.log(`📡 Channels :`);
  console.log(`   AGENT     → ${process.env.AGENT_CHANNEL_ID}`);
  console.log(`   CALENDRIER → ${process.env.CALENDRIER_CHANNEL_ID || '—'}`);
  console.log(`   STATS     → ${process.env.STATS_CHANNEL_ID || '— (optionnel)'}`);
  console.log(`   ALERTES   → ${process.env.ALERTES_CHANNEL_ID || '— (optionnel)'}`);

  // Planificateur — calcul fiable de l'heure Paris (Intl API, fonctionne sur Linux/Railway)
  function msUntilNext(hour, minute = 0) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (type) => parseInt(parts.find(p => p.type === type).value);
    const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    const target = hour * 3600 + minute * 60;
    let diff = target - elapsed;
    if (diff <= 0) diff += 24 * 3600;
    return diff * 1000;
  }

  // ☀️ 4h00 Paris : digest + rappels du jour
  function scheduleMorning() {
    setTimeout(async () => {
      await sendMorningDigest();
      await sendDailyReminders();
      scheduleMorning(); // re-planifie pour le lendemain
    }, msUntilNext(4, 0));
  }
  scheduleMorning();

  // 📊 1er du mois à 8h00 : rapport mensuel
  function scheduleMonthlyReport() {
    setTimeout(async () => {
      const now = new Date();
      const parisNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      if (parisNow.getDate() === 1) {
        const prev = new Date(parisNow.getFullYear(), parisNow.getMonth() - 1, 1);
        try {
          const channel = await client.channels.fetch(process.env.AGENT_CHANNEL_ID);
          if (channel) await sendMonthlyReport(channel, prev.getFullYear(), prev.getMonth());
        } catch (err) { console.error('[Rapport mensuel]', err); }
      }
      scheduleMonthlyReport();
    }, msUntilNext(8, 0));
  }
  scheduleMonthlyReport();

  // ⏰ Toutes les minutes : rappels précis
  setInterval(checkPendingReminders, 60 * 1000);

  // 🔔 Toutes les 10 min : nouveaux abonnés + milestones
  setInterval(async () => {
    await checkNewSubscribers();
    // Check milestones en parallèle
    try {
      let sData = null, dData = null;
      if (stripe) sData = await getStripeStats().catch(() => null);
      if (db) dData = await getDbStats().catch(() => null);
      if (sData || dData) await checkMilestones(sData, dData);
    } catch { /* noop */ }
  }, 10 * 60 * 1000);

  // 📧 Toutes les 5 min : nouveaux emails
  setInterval(checkNewEmails, 5 * 60 * 1000);

  // 📈 Lundi 8h00 : rapport hebdomadaire #croissance
  function scheduleWeeklyReport() {
    const now = new Date();
    const parisParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris',
      weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now);
    const getP = (type) => parisParts.find(p => p.type === type).value;
    const isMonday = getP('weekday') === 'Mon';
    const h = parseInt(getP('hour')), m = parseInt(getP('minute')), s = parseInt(getP('second'));
    const elapsedSec = h * 3600 + m * 60 + s;
    const targetSec  = 8 * 3600; // 8h00
    const daysUntilMonday = isMonday ? 0 : ((1 - now.getDay() + 7) % 7 || 7);
    let diffSec = daysUntilMonday * 86400 + (targetSec - elapsedSec);
    if (diffSec <= 0) diffSec += 7 * 86400; // semaine prochaine
    setTimeout(async () => {
      await sendWeeklyGrowthReport();
      scheduleWeeklyReport();
    }, diffSec * 1000);
  }
  scheduleWeeklyReport();

  // 🔄 Minuit chaque jour : décrémente les dueInDays de toutes les charges
  function scheduleDailyDecrement() {
    setTimeout(async () => {
      try {
        const fin = loadFinances();
        let changed = false;
        for (const expense of fin.expenses) {
          if (expense.dueInDays > 0) {
            expense.dueInDays = Math.max(0, expense.dueInDays - 1);
            changed = true;
          }
          // Décrémente aussi les inDays des virements attendus
        }
        for (const inc of fin.balance.incoming) {
          if (inc.inDays > 0) inc.inDays = Math.max(0, inc.inDays - 1);
        }
        // Supprime les virements reçus (inDays = 0 depuis la veille)
        fin.balance.incoming = fin.balance.incoming.filter(i => i.inDays > 0);

        // 🤖 Décrémente les crédits Anthropic API selon le burn quotidien
        if (fin.apiCredits?.anthropic && fin.apiCredits.anthropic.estimatedDailyBurn > 0) {
          fin.apiCredits.anthropic.balance = Math.max(
            0,
            fin.apiCredits.anthropic.balance - fin.apiCredits.anthropic.estimatedDailyBurn
          );
          fin.apiCredits.anthropic.balance = Math.round(fin.apiCredits.anthropic.balance * 100) / 100;
          changed = true;

          // Alerte si balance < seuil
          const api = fin.apiCredits.anthropic;
          if (api.balance < api.alertThreshold) {
            const channelId = process.env.SECRETAIRE_CHANNEL_ID;
            if (channelId) {
              try {
                const ch = await client.channels.fetch(channelId);
                if (ch) await ch.send(
                  `🚨 **Alerte Anthropic API** — Crédits bas !\n\n` +
                  `Solde actuel : **${euros(api.balance)}** (seuil : ${euros(api.alertThreshold)})\n` +
                  `Recharger sur → https://console.anthropic.com/settings/billing\n` +
                  `_(Dis-moi "j'ai rechargé 20€ sur Anthropic" quand c'est fait)_`
                );
              } catch (e) { console.error('[Anthropic alert]', e.message); }
            }
          }
        }

        if (changed) writeJSON(FINANCES_FILE, fin);
      } catch (err) { console.error('[Daily decrement]', err.message); }
      scheduleDailyDecrement();
    }, msUntilNext(0, 1)); // 00h01 chaque nuit
  }
  scheduleDailyDecrement();

  // 💰 9h00 chaque matin : résumé financier dans #secrétaire (si charges urgentes)
  function scheduleFinanceDigest() {
    setTimeout(async () => {
      const channelId = process.env.SECRETAIRE_CHANNEL_ID;
      if (channelId) {
        try {
          const fin = loadFinances();
          const urgent = fin.expenses.filter(e => e.amount > 0 && e.dueInDays <= 7);
          const bal = estimatedBalance(fin);

          if (urgent.length > 0 || bal.remaining < 30) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) return;

            const lines = urgent.map(e =>
              `${urgencyDot(e.dueInDays)} **${e.name}** — ${euros(e.amount)} dans **${e.dueInDays} jour(s)**`
            );

            const embed = new EmbedBuilder()
              .setColor(bal.remaining < 30 ? 0xef4444 : 0xf59e0b)
              .setTitle('🔔 Rappel financier du matin')
              .setTimestamp();

            if (urgent.length > 0) {
              embed.addFields({ name: '⚠️ Charges à venir', value: lines.join('\n'), inline: false });
            }
            embed.addFields({
              name: '💳 Solde net estimé',
              value: `**${euros(bal.remaining)}** ${bal.remaining > 30 ? '✅' : '🚨'}`,
              inline: false,
            });

            await channel.send({ embeds: [embed] });
          }
        } catch (err) { console.error('[Finance digest]', err.message); }
      }
      scheduleFinanceDigest();
    }, msUntilNext(9, 0));
  }
  scheduleFinanceDigest();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ══════════════════════════════════════════
  // CANAL SECRÉTAIRE FINANCIER
  // ══════════════════════════════════════════
  if (process.env.SECRETAIRE_CHANNEL_ID && message.channel.id === process.env.SECRETAIRE_CHANNEL_ID) {
    await message.channel.sendTyping();
    try {
      const fin = loadFinances();
      let stripeData = null;
      try { if (stripe) stripeData = await getStripeStats(); } catch { /* noop */ }

      const result = await handleSecretaire(message.content, fin, stripeData);

      // Appliquer les changements si nécessaire
      if (result.action === 'update' && result.changes) {
        const updated = applyFinancesChanges(fin, result.changes);
        writeJSON(FINANCES_FILE, updated);
      }

      // Envoyer la réponse texte
      if (result.message) {
        await message.reply(result.message);
      }

      // Envoyer l'embed financier complet si demandé
      if (result.show_embed) {
        const embed = await buildFinancesEmbed();
        await message.channel.send({ embeds: [embed] });
      }

    } catch (err) {
      console.error('[Secrétaire]', err.message);
      await message.reply('❌ Erreur secrétaire : ' + err.message);
    }
    return;
  }

  // ══════════════════════════════════════════
  // CANAL AGENT PRINCIPAL
  // ══════════════════════════════════════════
  if (message.channel.id !== process.env.AGENT_CHANNEL_ID) return;

  const history = conversations.get(message.channel.id) ?? [];
  await message.channel.sendTyping();

  try {
    const intent = detectIntent(message.content);

    // ── Stats dashboard
    if (intent === 'stats') {
      let stripeData = null, dbData = null;
      try { if (stripe) stripeData = await getStripeStats(); } catch (e) { console.error(e.message); }
      try { if (db) dbData = await getDbStats(); } catch (e) { console.error(e.message); }
      await message.reply({ embeds: [buildStatsEmbed(stripeData, dbData)] });
      return;
    }

    // ── Rapport mensuel
    if (intent === 'report') {
      if (!stripe || !db) {
        await message.reply('⚠️ Ajoute `STRIPE_SECRET_KEY` et `DATABASE_URL` dans `.env` pour le rapport mensuel.');
        return;
      }
      const now = new Date();
      await sendMonthlyReport(message.channel, now.getFullYear(), now.getMonth());
      return;
    }

    // ── Agenda
    if (intent === 'agenda') {
      if (!process.env.GOOGLE_CALENDAR_ID) {
        await message.reply('⚠️ GOOGLE_CALENDAR_ID manquant dans .env.');
        return;
      }
      try {
        const events = await getUpcomingEvents(7);
        const embed = new EmbedBuilder()
          .setColor(0x43B581)
          .setTitle('📅 Prochains rappels — 7 jours');

        if (events.length === 0) {
          embed.setDescription('Aucun rappel dans les 7 prochains jours.');
        } else {
          let desc = '';
          for (const event of events) {
            const raw = event.start?.date || event.start?.dateTime;
            const dateLabel = raw ? new Date(raw).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '?';
            desc += `📌 **${event.summary}** — ${dateLabel}\n`;
            if (event.description && event.description !== event.summary) {
              desc += `> ${event.description}\n`;
            }
            desc += '\n';
          }
          embed.setDescription(desc.trim());
        }
        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply('❌ Impossible de récupérer l\'agenda : ' + err.message);
      }
      return;
    }

    // ── Finances
    if (intent === 'finances') {
      try {
        const embed = await buildFinancesEmbed();
        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply('❌ Erreur finances : ' + err.message);
      }
      return;
    }

    // ── Solde rapide
    if (intent === 'solde') {
      const fin = loadFinances();
      const bal = estimatedBalance(fin);
      const rem = bal.remaining;
      const status = rem > 80 ? '✅' : rem > 30 ? '⚠️' : '🚨';
      const embed = new EmbedBuilder()
        .setColor(rem > 80 ? 0x10b981 : rem > 30 ? 0xf59e0b : 0xef4444)
        .setTitle('💳 Solde rapide')
        .addFields(
          { name: 'Disponible total',    value: euros(bal.total),     inline: true },
          { name: 'Charges fixes (30j)', value: euros(bal.fixed),     inline: true },
          { name: 'Reste estimé',        value: `**${euros(rem)}** ${status}`, inline: true },
        )
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── Voir les notes
    if (intent === 'notes_view') {
      const notes = readJSON(NOTES_FILE, []);
      if (notes.length === 0) {
        await message.reply('📝 Aucune note sauvegardée. Dis "note ça : [ton idée]" pour en créer une.');
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('📝 Tes notes');
      let desc = '';
      notes.slice(-10).forEach((n, i) => {
        const date = new Date(n.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
        desc += `**${i + 1}.** ${n.text}\n_${date}_\n\n`;
      });
      embed.setDescription(desc.trim());
      embed.setFooter({ text: `${notes.length} note(s) au total · affichage des 10 dernières` });
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── Sauvegarder une note
    if (intent === 'note_save') {
      const cleaned = message.content
        .replace(/^(note que|note ça|note ceci|sauvegarde ça|enregistre ça|mémorise ça|garde en mémoire|idée :|note :)/i, '')
        .trim();
      saveNote(cleaned || message.content);
      await message.reply(`✅ **Note sauvegardée !**\n> ${cleaned || message.content}\n\nTape \`!notes\` pour voir toutes tes notes.`);
      return;
    }

    // ── Rappel (local avec heure précise + Google Calendar optionnel)
    if (intent === 'reminder') {
      try {
        const reminder = await extractReminderDetails(message.content);
        const targetDate = new Date(reminder.datetime);

        // Stockage local → ping à l'heure exacte
        addReminder({
          summary: reminder.summary,
          description: reminder.description,
          datetime: reminder.datetime,
          channelId: message.channel.id,
          userId: message.author.id,
        });

        // Google Calendar optionnel (si configuré)
        let calAdded = false;
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID) {
          try {
            await createCalendarEvent(reminder.summary, reminder.description, reminder.datetime);
            calAdded = true;
          } catch (e) { console.error('[Cal add]', e.message); }
        }

        const embed = new EmbedBuilder().setColor(0x43B581).setTitle('⏰ Rappel programmé !');

        if (reminder.hasTime) {
          const timeLabel = targetDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
          const dateLabel = targetDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
          embed.addFields(
            { name: '📌 Rappel', value: reminder.summary },
            { name: '🗓️ Quand', value: `${dateLabel} à **${timeLabel}**`, inline: true },
          );
          embed.setFooter({ text: `Je te pingerai à ${timeLabel} pile ✅` });
        } else {
          const dateLabel = targetDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
          embed.addFields(
            { name: '📌 Rappel', value: reminder.summary },
            { name: '🗓️ Date', value: dateLabel, inline: true },
          );
          embed.setFooter({ text: 'Inclus dans le récap de 9h00 ce jour-là ✅' });
        }

        if (reminder.description && reminder.description !== reminder.summary) {
          embed.addFields({ name: '📝 Détails', value: reminder.description });
        }

        await message.reply({ embeds: [embed] });
        return;
      } catch (err) {
        console.error('[Reminder]', err);
        await message.reply('❌ Impossible de créer le rappel : ' + err.message);
        return;
      }
    }

    // ── Conversation IA (avec données enrichies si pertinent)
    let userContent = message.content;

    if (/mrr|arr|abonné|inscrit|stat|revenu|kpi|dashboard|conversion/i.test(message.content)) {
      try {
        const [sData, dData] = await Promise.all([
          stripe ? getStripeStats().catch(() => null) : null,
          db ? getDbStats().catch(() => null) : null,
        ]);
        if (sData || dData) {
          userContent += '\n\n[DONNÉES TEMPS RÉEL]\n';
          if (sData) userContent += `MRR: ${sData.mrr}€ | ARR: ${sData.arr}€ | Abonnés actifs: ${sData.activeSubscriptions} (${sData.monthlySubscriptions} mensuel, ${sData.annualSubscriptions} annuel) | Nouveaux auj: ${sData.newToday} | Ce mois: ${sData.newThisMonth}\n`;
          if (dData) userContent += `Total inscrits: ${dData.totalUsers} | Free: ${dData.freeUsers} | Premium: ${dData.premiumUsers} | Conversion: ${dData.conversionRate}% | Inscrits auj: ${dData.newToday} | Cette semaine: ${dData.newThisWeek}\n`;
        }
      } catch { /* silencieux */ }
    }

    history.push({ role: 'user', content: userContent });
    if (history.length > 30) history.splice(0, 2);
    conversations.set(message.channel.id, history);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: 'assistant', content: reply });

    // Split en chunks ≤ 1900 chars
    const chunks = [];
    const paragraphs = reply.split('\n\n');
    let current = '';
    for (const para of paragraphs) {
      const candidate = current ? current + '\n\n' + para : para;
      if (candidate.length > 1900) {
        if (current) chunks.push(current.trim());
        if (para.length > 1900) {
          const lines = para.split('\n');
          let block = '';
          for (const line of lines) {
            if ((block + '\n' + line).length > 1900) {
              if (block) chunks.push(block.trim());
              block = line;
            } else {
              block = block ? block + '\n' + line : line;
            }
          }
          current = block;
        } else {
          current = para;
        }
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current.trim());

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) await message.reply(chunks[i]);
      else await message.channel.send(chunks[i]);
    }

  } catch (error) {
    console.error('[Agent]', error);
    await message.reply('❌ Erreur interne : ' + (error.message || 'réessaie dans quelques secondes.'));
  }
});

// ─── Healthcheck HTTP (Railway garde le service vivant) ────────────────────────
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', bot: client.isReady() ? 'online' : 'connecting' }));
}).listen(process.env.PORT || 3000);

// ─── Protection anti-crash global ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[CRASH uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH unhandledRejection]', reason);
});

// ─── Reconnexion auto si Discord déconnecte ───────────────────────────────────
client.on('disconnect', () => {
  console.warn('[Discord] Déconnecté — tentative de reconnexion...');
});
client.on('error', (err) => {
  console.error('[Discord] Erreur client :', err.message);
});

client.login(process.env.DISCORD_BOT_TOKEN);
