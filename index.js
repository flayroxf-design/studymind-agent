require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { Pool } = require('pg');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const conversations = new Map();

async function getStripeStats() {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400);

  const [allSubs, newSubs, customers] = await Promise.all([
    stripe.subscriptions.list({ status: 'active', limit: 100 }),
    stripe.subscriptions.list({ status: 'active', created: { gte: startOfDay }, limit: 100 }),
    stripe.customers.list({ limit: 100 }),
  ]);

  const mrr = allSubs.data.reduce((total, sub) => {
    const price = sub.items.data[0]?.price;
    if (!price) return total;
    const amount = price.unit_amount / 100;
    return total + (price.recurring?.interval === 'year' ? amount / 12 : amount);
  }, 0);

  return {
    activeSubscriptions: allSubs.data.length,
    newToday: newSubs.data.length,
    totalCustomers: customers.data.length,
    mrr: mrr.toFixed(2),
  };
}

async function getDbStats() {
  const [totalRes, planRes, newTodayRes] = await Promise.all([
    db.query('SELECT COUNT(*) as count FROM "User"'),
    db.query('SELECT plan, COUNT(*) as count FROM "User" GROUP BY plan'),
    db.query(`SELECT COUNT(*) as count FROM "User" WHERE "createdAt" >= CURRENT_DATE`),
  ]);

  const plans = {};
  planRes.rows.forEach(row => { plans[row.plan] = parseInt(row.count); });

  return {
    totalUsers: parseInt(totalRes.rows[0].count),
    newToday: parseInt(newTodayRes.rows[0].count),
    freeUsers: plans['free'] ?? 0,
    premiumUsers: plans['premium'] ?? 0,
  };
}

function isStatsRequest(text) {
  const keywords = ['stats', 'stat ', 'abonnement', 'revenu', 'mrr', 'chiffre', 'combien', 'subscri', 'utilisateur', 'user', 'inscrit', 'visite'];
  return keywords.some(k => text.toLowerCase().includes(k));
}

const SYSTEM_PROMPT = `Tu es l'agent principal de StudyMind, le co-chef de Raphaël.
StudyMind est un SaaS edtech français (tuteur IA + planning + flashcards) pour les élèves de la 6ème au Bac.

Tes capacités :
- Donner les stats Stripe en temps réel (abonnements actifs, nouveaux du jour, MRR, clients)
- Donner les stats utilisateurs en temps réel (inscrits total, free vs premium, nouveaux du jour)
- Envoyer des emails au nom de Raphaël
- Conseiller sur le business, marketing, product

Règles :
- Réponds TOUJOURS en français
- Sois concis et professionnel comme un vrai co-chef
- Tutoie Raphaël
- Si tu ne peux pas faire quelque chose, dis-le honnêtement`;

client.on('clientReady', () => {
  console.log(`✅ Agent Principal connecté : ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.AGENT_CHANNEL_ID) return;

  const history = conversations.get(message.channel.id) ?? [];
  await message.channel.sendTyping();

  try {
    let userContent = message.content;

    if (isStatsRequest(message.content)) {
      const [stripe, db] = await Promise.all([getStripeStats(), getDbStats()]);
      userContent = `${message.content}

[DONNÉES EN TEMPS RÉEL]
Stripe :
- Abonnements actifs : ${stripe.activeSubscriptions}
- Nouveaux aujourd'hui : ${stripe.newToday}
- MRR : ${stripe.mrr} €
- Total clients Stripe : ${stripe.totalCustomers}

Base de données :
- Total utilisateurs inscrits : ${db.totalUsers}
- Nouveaux inscrits aujourd'hui : ${db.newToday}
- Plan free : ${db.freeUsers}
- Plan premium : ${db.premiumUsers}`;
    }

    history.push({ role: 'user', content: userContent });
    if (history.length > 20) history.splice(0, 2);
    conversations.set(message.channel.id, history);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: 'assistant', content: reply });

    if (reply.length > 2000) {
      const chunks = reply.match(/.{1,2000}/gs);
      for (const chunk of chunks) await message.reply(chunk);
    } else {
      await message.reply(reply);
    }

  } catch (error) {
    console.error('[Agent Principal]', error);
    await message.reply('❌ Erreur interne, réessaie dans quelques secondes.');
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
