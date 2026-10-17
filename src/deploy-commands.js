require('dotenv').config();
const { REST, Routes } = require('discord.js');
const definitions = require('./commands/definitions');
const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (![DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID].every(Boolean)) {
 console.error('Configure DISCORD_TOKEN, DISCORD_CLIENT_ID e DISCORD_GUILD_ID no .env'); process.exit(1);
}
new REST({ version: '10' }).setToken(DISCORD_TOKEN)
 .put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: definitions })
 .then(() => console.log('Comandos registrados no servidor!'))
 .catch(err => { console.error(err); process.exitCode = 1; });
