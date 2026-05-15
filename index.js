require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

const SYSTEM_PROMPT = `Tu es l'agent principal de StudyMind, le co-chef de Raphaël.
StudyMind est un SaaS edtech français (tuteur IA + planning + flashcards) pour les élèves de la 6ème au Bac.

Tes capacités :
- Envoyer des emails au nom de Raphaël
- Donner les stats du jour (abonnements, revenus)
- Donner les analytics du site (visites, utilisateurs)
- Conseiller sur le business, marketing, product

Règles :
- Réponds TOUJOURS en français
- Sois concis et professionnel comme un vrai co-chef
- Tutoie Raphaël
- Si tu ne peux pas faire quelque chose, dis-le honnêtement`;

client.on('ready', () => {
  console.log(`✅ Agent Principal connecté : ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.AGENT_CHANNEL_ID) return;

  const history = conversations.get(message.channel.id) ?? [];
  history.push({ role: 'user', content: message.content });
  if (history.length > 20) history.splice(0, 2);
  conversations.set(message.channel.id, history);

  try {
    await message.channel.sendTyping();

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
