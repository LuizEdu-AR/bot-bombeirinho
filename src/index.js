require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { channels } = require('./config/ids');
const { initAdministrativeLogs } = require('./services/logs-administrativos');
const { panel, handleRegistration } = require('./services/registrations');
require('./services/firebase');
const { onMemberLeave, reconcileMembership } = require('./services/membership');
const { ensurePanels } = require('./services/panels');
const { ensureBotHelp } = require('./services/bot-help');
const { handlePonto } = require('./services/ponto');
const { handleFiveMLog } = require('./services/ponto-fivem');
const {handleRecoverLogs}=require('./services/recuperar-logs-ponto');
const { handleControle } = require('./services/controle-ponto');
const { handleVistorias } = require('./services/vistorias');
const { onMemberUpdate } = require('./services/sync-members');
const {handleSyncIds,onNicknameUpdate}=require('./services/sincronizar-ids');
const {handleSyncCourses}=require('./services/sincronizar-cursos');
const {handleManualRegistration}=require('./services/cadastrar-bombeiro');
const { handleGestao } = require('./services/gestao-cargos');
const { registerHierarchy } = require('./services/hierarquia');
const { handleNicks } = require('./services/padronizar-nicks');
const { handleSuggestionMessage, handleSuggestionInteraction } = require('./services/sugestoes');
const { handleAnalysis } = require('./services/analisar-estabelecimentos');
if (!process.env.DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no .env');
const client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
registerHierarchy(client);
initAdministrativeLogs(client);
client.on(Events.MessageCreate, message => {
 handleSuggestionMessage(message).catch(err=>console.error('[Sugestões] Erro:',err));
 handleFiveMLog(message).catch(err=>console.error('[FiveM] Erro:',err));
});
client.on(Events.GuildMemberRemove, member => onMemberLeave(member).catch(err => console.error('Erro ao registrar saída:', err)));
client.on(Events.GuildMemberUpdate, (oldMember,newMember)=>{
 onMemberUpdate(oldMember,newMember).catch(err=>console.error('Erro ao sincronizar cargos:',err));
 onNicknameUpdate(oldMember,newMember).catch(err=>console.error('Erro ao sincronizar ID:',err));
});
client.on(Events.GuildMemberAdd, member => reconcileMembership(member).catch(err => console.error('Erro ao verificar reentrada:', err)));
client.once(Events.ClientReady, async c => {
 console.log(`🚒 Bombeirinho online como ${c.user.tag}`);
 await ensurePanels(c);
 await ensureBotHelp(c).catch(err => console.error('[Bot Help] Erro:', err));
});
client.on(Events.InteractionCreate,async interaction=>{
 try {
  if (interaction.isChatInputCommand()) {
   if (interaction.commandName==='analisar-estabelecimentos') return await handleAnalysis(interaction);
   if (interaction.commandName==='sincronizar-cursos') return await handleSyncCourses(interaction);
   if (interaction.commandName==='cadastrar-bombeiro') return await handleManualRegistration(interaction);
   if (interaction.commandName==='sincronizar-ids') return await handleSyncIds(interaction);
   if (interaction.commandName==='padronizar-nicks') return await handleNicks(interaction);
   if (interaction.commandName==='recuperar-logs-ponto') return await handleRecoverLogs(interaction);
   if (interaction.commandName==='ponto') return await handlePonto(interaction);
   if (interaction.commandName==='ping') return interaction.reply({content:'🚒 Bombeirinho online!',flags:MessageFlags.Ephemeral});
   if (interaction.commandName==='painel') {
    if (interaction.options.getString('tipo')!=='setagem') return interaction.reply({content:'Painel inválido.',flags:MessageFlags.Ephemeral});
    if (interaction.channelId!==channels.setagem) return interaction.reply({content:`Use este comando no canal <#${channels.setagem}>.`,flags:MessageFlags.Ephemeral});
    await interaction.channel.send(panel());
    return interaction.reply({content:'Painel de setagem publicado.',flags:MessageFlags.Ephemeral});
   }
  }
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isModalSubmit()) {
   if (interaction.customId.startsWith('sug:')) return await handleSuggestionInteraction(interaction);
   if (interaction.customId.startsWith('ids:')) return await handleSyncIds(interaction);
   if (interaction.customId.startsWith('nicks:')) return await handleNicks(interaction);
   if (interaction.customId.startsWith('gest:')) return await handleGestao(interaction);
   if (interaction.customId.startsWith('sync:')) return interaction.reply({content:'O painel antigo de importação foi desativado.',flags:MessageFlags.Ephemeral});
   if (interaction.customId.startsWith('vist:')) return await handleVistorias(interaction);
   if (interaction.customId.startsWith('controle:')) return await handleControle(interaction);
   if (interaction.customId.startsWith('ponto:')) return await handlePonto(interaction);
   if (interaction.customId.startsWith('reg:')) return await handleRegistration(interaction);
  }
 } catch(err) {
  console.error('Erro na interação:',err);
  const msg={content:'Ocorreu um erro ao processar a ação. Tente novamente ou contate a administração.',flags:MessageFlags.Ephemeral};
  if (interaction.deferred) await interaction.editReply({content:msg.content}).catch(()=>{});
  else if (interaction.replied) await interaction.followUp(msg).catch(()=>{});
  else await interaction.reply(msg).catch(()=>{});
 }
});
client.login(process.env.DISCORD_TOKEN);
