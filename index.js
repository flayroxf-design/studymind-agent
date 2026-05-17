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
      q: 'is:unread in:inbox newer_than:1h',
      maxResults: 10,
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
  const channelId = process.env.CALENDRIER_CHANNEL_ID;
  if (!channelId || !process.env.GOOGLE_CALENDAR_ID) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const today = new Date();
    const events = await getEventsForDate(today);
    const dayLabel = today.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const embed = buildCalendarEmbed(events, dayLabel);
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
// INTENT DETECTION
// ═══════════════════════════════════════════════════════════════

function detectIntent(text) {
  const t = text.toLowerCase().trim();

  if (['!stats', '!dashboard', '!kpi'].includes(t)) return 'stats';
  if (t === '!rapport' || t.startsWith('!rapport ')) return 'report';
  if (['!agenda', '!rappels', '!calendrier'].includes(t)) return 'agenda';
  if (t === '!notes') return 'notes_view';

  const statsKw = ['mrr', 'arr', 'chiffre d\'affaires', 'combien d\'abonnés', 'combien d\'inscrits', 'dashboard', 'kpi', 'mes stats', 'mes métriques'];
  if (statsKw.some(k => t.includes(k))) return 'stats';

  const reportKw = ['rapport mensuel', 'rapport du mois', 'paiements du mois', 'qui a payé', 'liste des paiements', 'liste des abonnés payants'];
  if (reportKw.some(k => t.includes(k))) return 'report';

  const agendaKw = ['mon agenda', 'mes rappels', 'prochains rappels', 'quoi cette semaine', 'prochain événement', "c'est quoi cette semaine", 'voir mes rappels'];
  if (agendaKw.some(k => t.includes(k))) return 'agenda';

  const reminderKw = ['rappelle-moi', 'rappelle moi', 'rappel :', "n'oublie pas", 'note que', 'ajoute au calendrier', 'mets dans le calendrier', 'planifie', 'lundi prochain', 'mardi prochain', 'mercredi prochain', 'jeudi prochain', 'vendredi prochain', 'samedi prochain', 'dimanche prochain', 'la semaine prochaine', 'dans une semaine', 'dans deux semaines', 'demain matin', 'ce soir', 'ajoute un rappel', 'crée un rappel'];
  if (reminderKw.some(k => t.includes(k))) return 'reminder';

  const noteKw = ['note ça', 'note ceci', 'sauvegarde ça', 'enregistre ça', 'garde en mémoire', 'idée :', 'mémorise ça'];
  if (noteKw.some(k => t.includes(k))) return 'note_save';

  return 'conversation';
}

// ═══════════════════════════════════════════════════════════════
// EXTRACT REMINDER DETAILS VIA CLAUDE
// ═══════════════════════════════════════════════════════════════

async function extractReminderDetails(userMessage) {
  const today = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const todayISO = new Date().toISOString().slice(0, 10);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Tu es un assistant qui extrait des informations de rappel depuis des messages en français.
Aujourd'hui : ${today} (${todayISO}).
Retourne UNIQUEMENT un JSON valide, sans markdown :
{"summary":"Titre court (10 mots max)","description":"Description complète","date":"YYYY-MM-DD"}
Si pas de date précise, utilise dans 7 jours. Ne retourne QUE le JSON.`,
    messages: [{ role: 'user', content: userMessage }],
  });

  return JSON.parse(response.content[0].text.trim());
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

  // ☀️ 9h00 : digest quotidien (stats) + rappels calendrier
  cron.schedule('0 9 * * *', async () => {
    await sendMorningDigest();
    await sendDailyReminders();
  }, { timezone: 'Europe/Paris' });

  // 📊 1er du mois à 8h00 : rapport mensuel automatique
  cron.schedule('0 8 1 * *', async () => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    try {
      const channel = await client.channels.fetch(process.env.AGENT_CHANNEL_ID);
      if (channel) await sendMonthlyReport(channel, prev.getFullYear(), prev.getMonth());
    } catch (err) { console.error('[Cron rapport mensuel]', err); }
  }, { timezone: 'Europe/Paris' });

  // 🔔 Toutes les 10 min : nouveaux abonnés → #alertes
  cron.schedule('*/10 * * * *', checkNewSubscribers, { timezone: 'Europe/Paris' });

  // 📧 Toutes les 5 min : nouveaux emails → #email
  cron.schedule('*/5 * * * *', checkNewEmails, { timezone: 'Europe/Paris' });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
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

    // ── Rappel Google Calendar
    if (intent === 'reminder') {
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CALENDAR_ID) {
        await message.reply('⚠️ Google Calendar non configuré. Vérifie `GOOGLE_SERVICE_ACCOUNT_JSON` et `GOOGLE_CALENDAR_ID` dans `.env`.');
        return;
      }
      try {
        const reminder = await extractReminderDetails(message.content);
        await createCalendarEvent(reminder.summary, reminder.description, reminder.date);

        const dateLabel = new Date(reminder.date + 'T12:00:00').toLocaleDateString('fr-FR', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });

        const embed = new EmbedBuilder()
          .setColor(0x43B581)
          .setTitle('📅 Rappel ajouté !')
          .addFields(
            { name: '📌 Rappel', value: reminder.summary },
            { name: '🗓️ Date', value: dateLabel, inline: true },
          );

        if (reminder.description && reminder.description !== reminder.summary) {
          embed.addFields({ name: '📝 Détails', value: reminder.description });
        }
        embed.setFooter({ text: 'Tu recevras un message dans #calendrier ce matin-là à 9h00.' });
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

client.login(process.env.DISCORD_BOT_TOKEN);
