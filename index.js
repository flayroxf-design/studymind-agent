require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { Pool } = require('pg');
const cron = require('node-cron');

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

async function getMonthlyPayments(year, month) {
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
    const stripeName = customer.name || '';

    const result = await db.query(
      'SELECT "firstName", email, "planInterval" FROM "User" WHERE "stripeCustomerId" = $1',
      [customerId]
    );

    const dbUser = result.rows[0];
    const email = dbUser?.email || customer.email || 'N/A';
    const firstName = dbUser?.firstName || stripeName || 'N/A';
    const planInterval = dbUser?.planInterval;

    payments.push({
      name: stripeName || firstName,
      email,
      plan: planInterval === 'year' ? 'Annuel' : 'Mensuel',
      amount: (invoice.amount_paid / 100).toFixed(2),
    });
  }

  return payments;
}

async function sendMonthlyReport(channel, year, month) {
  const targetDate = new Date(year, month, 1);
  const monthName = targetDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  try {
    const payments = await getMonthlyPayments(year, month);

    if (payments.length === 0) {
      await channel.send(`📊 **Rapport mensuel — ${monthName}**\n\nAucun paiement enregistré ce mois-ci.`);
      return;
    }

    const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    let message = `📊 **Rapport mensuel — ${monthName}**\n`;
    message += `**${payments.length} paiement(s) :**\n\n`;

    payments.forEach((p, i) => {
      message += `${i + 1}. **${p.name}** | ${p.email} | ${p.plan} | ${p.amount} €\n`;
    });

    message += `\n💰 **Total encaissé : ${total.toFixed(2)} €**`;

    if (message.length > 2000) {
      const lines = message.split('\n');
      let current = '';
      for (const line of lines) {
        if ((current + '\n' + line).length > 1900) {
          if (current) await channel.send(current.trim());
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
      if (current) await channel.send(current.trim());
    } else {
      await channel.send(message);
    }
  } catch (error) {
    console.error('[Rapport mensuel]', error);
    await channel.send('❌ Erreur lors de la génération du rapport mensuel.');
  }
}

function isStatsRequest(text) {
  const keywords = ['stats', 'stat ', 'abonnement', 'revenu', 'mrr', 'chiffre', 'combien', 'subscri', 'utilisateur', 'user', 'inscrit', 'visite'];
  return keywords.some(k => text.toLowerCase().includes(k));
}

function isReportRequest(text) {
  const keywords = ['rapport mensuel', 'rapport du mois', 'paiements du mois', 'liste des abonnés', 'liste des paiements'];
  return keywords.some(k => text.toLowerCase().includes(k));
}

const SYSTEM_PROMPT = `Tu es l'agent principal de StudyMind, le co-chef de Raphaël.
StudyMind est un SaaS edtech français (tuteur IA + planning + flashcards) pour les élèves de la 6ème au Bac.

Tes capacités :
- Donner les stats Stripe en temps réel (abonnements actifs, nouveaux du jour, MRR, clients)
- Donner les stats utilisateurs en temps réel (inscrits total, free vs premium, nouveaux du jour)
- Générer le rapport mensuel des paiements (nom, email, type d'abonnement)
- Conseiller sur le business, marketing, product
- Générer des scripts TikTok optimisés pour StudyMind (demande "génère un script tiktok" ou "idée vidéo")

--- CONNAISSANCE TIKTOK STUDYMIND ---

PRINCIPES CLÉS :
- Le watchtime est la métrique n°1 sur TikTok. Une vidéo regardée à 100% est boostée algorithmiquement.
- Vidéos ultra courtes (< 9 sec FR, < 15 sec US) = watchtime quasi-parfait = boost algo.
- 0 hashtag ou très peu — juste une courte phrase + emoji en caption.
- Musique tendance du moment (vérifier les sons viraux TikTok FR de la semaine).
- Contenu répétitif assumé : même format qui marche → republier avec variation légère.

FORMAT FR QUI MARCHE (< 9 secondes) :
Structure en 2 temps :
  Partie 1 (4-5 sec) : Images/screenshots de notes excellentes qui défilent vite (17/20, 18/20, 20/20)
  Partie 2 (4-5 sec) : Plan ultra-accéléré montrant l'app en action (flashcards, photo de cours, planning)
Caption : phrase courte percutante + 1 emoji ("cette app sauve mes notes 📚", "comment j'ai eu 18 en maths 🤯")
Musique : son viral du moment

FORMAT US D'INSPIRATION (< 15 secondes) :
Hook visuel choc en 2 premières secondes — 2 types qui marchent :
  Type 1 — Question : "what's the best study app?" / "quelle app pour avoir 20/20 ?"
  Type 2 — Choc : "j'ai trouvé une app qui devrait être illégale 🚨" / "cette app est interdite dans mon lycée"
Ensuite : B-roll de personnes qui travaillent dans des espaces propres et esthétiques (clean girl, café, bureau lumineux)
Puis : démonstration rapide de l'app
Caption courte, 0 ou 1 hashtag max

HOOKS QUI MARCHENT POUR STUDYMIND :
- "cette app sauve mes notes 📚"
- "j'ai trouvé une app qui devrait être illégale 🚨"
- "comment j'ai eu 18 en maths avec ça 🤯"
- "le truc que j'aurais voulu avoir en 3ème"
- "mon tuteur IA a changé ma vie"
- "j'ai passé mon bac avec cette app 🎓"

FONCTIONNALITÉS À MONTRER À L'ÉCRAN :
- Tuteur IA : poser une question de cours, recevoir une explication claire
- Planning : planning de révision généré automatiquement
- Flashcards : révision rapide d'une notion
- Notes excellentes : résultats avant/après

QUAND RAPHAËL DEMANDE UN SCRIPT TIKTOK :
Génère-le dans ce format :
  🎬 DURÉE CIBLE : X secondes
  🎵 MUSIQUE : [type de son à chercher]
  📱 CAPTION : [texte exact]

  PLAN PAR PLAN :
  [0-2s] Description précise de ce qu'on voit à l'écran
  [2-5s] ...
  [5-9s] ...

  💡 CONSEIL DE MONTAGE : [tip spécifique]

--- FIN CONNAISSANCE TIKTOK ---

Règles :
- Réponds TOUJOURS en français
- Sois concis et professionnel comme un vrai co-chef
- Tutoie Raphaël
- Si tu ne peux pas faire quelque chose, dis-le honnêtement`;

client.on('clientReady', () => {
  console.log(`✅ Agent Principal connecté : ${client.user.tag}`);

  // Rapport automatique le 1er de chaque mois à 8h00
  cron.schedule('0 8 1 * *', async () => {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    try {
      const channel = await client.channels.fetch(process.env.AGENT_CHANNEL_ID);
      if (channel) await sendMonthlyReport(channel, prevMonth.getFullYear(), prevMonth.getMonth());
    } catch (err) {
      console.error('[Cron rapport mensuel]', err);
    }
  }, { timezone: 'Europe/Paris' });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.AGENT_CHANNEL_ID) return;

  const history = conversations.get(message.channel.id) ?? [];
  await message.channel.sendTyping();

  try {
    // Rapport mensuel manuel
    if (isReportRequest(message.content)) {
      const now = new Date();
      await sendMonthlyReport(message.channel, now.getFullYear(), now.getMonth());
      return;
    }

    let userContent = message.content;

    if (isStatsRequest(message.content)) {
      const [stripeStats, dbStats] = await Promise.all([getStripeStats(), getDbStats()]);
      userContent = `${message.content}

[DONNÉES EN TEMPS RÉEL]
Stripe :
- Abonnements actifs : ${stripeStats.activeSubscriptions}
- Nouveaux aujourd'hui : ${stripeStats.newToday}
- MRR : ${stripeStats.mrr} €
- Total clients Stripe : ${stripeStats.totalCustomers}

Base de données :
- Total utilisateurs inscrits : ${dbStats.totalUsers}
- Nouveaux inscrits aujourd'hui : ${dbStats.newToday}
- Plan free : ${dbStats.freeUsers}
- Plan premium : ${dbStats.premiumUsers}`;
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
      const paragraphs = reply.split('\n\n');
      let current = '';
      for (const para of paragraphs) {
        if ((current + '\n\n' + para).length > 1900) {
          if (current) await message.reply(current.trim());
          current = para;
        } else {
          current = current ? current + '\n\n' + para : para;
        }
      }
      if (current) await message.reply(current.trim());
    } else {
      await message.reply(reply);
    }

  } catch (error) {
    console.error('[Agent Principal]', error);
    await message.reply('❌ Erreur interne, réessaie dans quelques secondes.');
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
