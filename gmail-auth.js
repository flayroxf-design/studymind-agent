const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const credentials = JSON.parse(fs.readFileSync('./gmail-credentials.json', 'utf8'));
const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n🔐 Ouvre cette URL dans ton navigateur :\n');
console.log(authUrl);
console.log('\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('📋 Colle le code affiché après autorisation : ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    console.log('\n✅ Token obtenu !\n');
    console.log('Ajoute ces lignes dans ton .env :\n');
    console.log(`GMAIL_CLIENT_ID=${client_id}`);
    console.log(`GMAIL_CLIENT_SECRET=${client_secret}`);
    console.log(`GMAIL_REDIRECT_URI=${redirect_uris[0]}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n');
  } catch (err) {
    console.error('❌ Erreur :', err.message);
  }
});
