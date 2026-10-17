const { db, admin } = require('./firebase');
const { channels } = require('../config/ids');
const { panel } = require('./registrations');
const { panel: controlPanel } = require('./controle-ponto');
const { cadastroPanel, agendaPanel } = require('./vistorias');
const { panel: gestaoPanel } = require('./gestao-cargos');

const PANEL_KEY = 'setagem';
const PANEL_TITLE = '🚒 SSFD • Setagem';

function isSetagemPanel(message, botId) {
  return message.author?.id === botId && message.embeds?.some(embed => embed.title === PANEL_TITLE) &&
    message.components?.some(row => row.components?.some(component => component.customId === 'reg:start'));
}

async function ensureSetagemPanel(guild) {
  const channel = await guild.channels.fetch(channels.setagem);
  if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error('Canal de Setagem não é um canal de mensagens acessível.');
  const ref = db.collection('guilds').doc(guild.id).collection('panels').doc(PANEL_KEY);
  const snap = await ref.get();
  let message = null;
  if (snap.exists && snap.data()?.channelId === channel.id && snap.data()?.messageId) {
    message = await channel.messages.fetch(snap.data().messageId).catch(err => {
      if (err.code === 10008) return null; // mensagem apagada
      throw err;
    });
    if (message && !isSetagemPanel(message, guild.client.user.id)) message = null;
  }
  // Recupera o painel publicado manualmente antes da atualização, sem duplicá-lo.
  // O Discord só permite pesquisar o histórico acessível ao bot; usamos as últimas 100 mensagens.
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 100 });
    message = recent.find(m => isSetagemPanel(m, guild.client.user.id)) || null;
  }
  if (message) {
    await message.edit(panel());
    console.log(`[Painéis] Setagem reutilizado em ${guild.name}: ${message.id}`);
  } else {
    message = await channel.send(panel());
    console.log(`[Painéis] Setagem publicado em ${guild.name}: ${message.id}`);
  }
  await ref.set({ channelId: channel.id, messageId: message.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return message;
}

async function ensureControlePanel(guild) {
 const channel = await guild.channels.fetch(channels.controlePonto);
 if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error('Canal Controle de Ponto indisponível.');
 const ref = db.collection('guilds').doc(guild.id).collection('panels').doc('controlePonto');
 const snap = await ref.get();
 let message = null;
 if (snap.exists && snap.data()?.channelId === channel.id && snap.data()?.messageId) {
  message = await channel.messages.fetch(snap.data().messageId).catch(() => null);
  if (message?.author?.id !== guild.client.user.id || !message.embeds?.some(e=>e.title==='🚒 SSFD • Controle de Ponto')) message=null;
 }
 if (!message) {
  const recent=await channel.messages.fetch({limit:100});
  message=recent.find(m=>m.author?.id===guild.client.user.id && m.embeds?.some(e=>e.title==='🚒 SSFD • Controle de Ponto'))||null;
 }
 if (message) await message.edit(controlPanel());
 else message=await channel.send(controlPanel());
 await ref.set({channelId:channel.id,messageId:message.id,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 console.log(`[Painéis] Controle de Ponto ${snap.exists?'verificado':'publicado'} em ${guild.name}: ${message.id}`);
}
async function ensureVistoriaPanel(guild, key, channelId, title, content) {
 const channel = await guild.channels.fetch(channelId);
 if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error(`Canal ${key} indisponível.`);
 const ref = db.collection('guilds').doc(guild.id).collection('panels').doc(key);
 const snap = await ref.get(); let message=null;
 if (snap.exists && snap.data()?.messageId && snap.data()?.channelId===channel.id) {
  message=await channel.messages.fetch(snap.data().messageId).catch(()=>null);
  if (message?.author?.id!==guild.client.user.id || !message.embeds?.some(e=>e.title===title)) message=null;
 }
 if (!message) {const recent=await channel.messages.fetch({limit:100});message=recent.find(m=>m.author?.id===guild.client.user.id&&m.embeds?.some(e=>e.title===title))||null;}
 if (message) await message.edit(content()); else message=await channel.send(content());
 await ref.set({channelId:channel.id,messageId:message.id,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 console.log(`[Painéis] ${key} verificado em ${guild.name}: ${message.id}`);
}
async function ensureGestaoPanel(guild){
 const channel=await guild.channels.fetch(channels.gestaoCargos);
 if(!channel?.isTextBased()||!channel.messages?.fetch)throw new Error('Canal Gestão de Cargos indisponível.');
 const ref=db.collection('guilds').doc(guild.id).collection('panels').doc('gestaoCargos');
 const snap=await ref.get();let message=null;
 if(snap.exists&&snap.data()?.channelId===channel.id&&snap.data()?.messageId)message=await channel.messages.fetch(snap.data().messageId).catch(()=>null);
 if(message?.author?.id!==guild.client.user.id||!message?.embeds?.some(e=>e.title==='🚒 SSFD • Gestão de Cargos'))message=null;
 if(!message){const recent=await channel.messages.fetch({limit:100});message=recent.find(m=>m.author?.id===guild.client.user.id&&m.embeds?.some(e=>e.title==='🚒 SSFD • Gestão de Cargos'))||null;}
 if(message)await message.edit(gestaoPanel());else message=await channel.send(gestaoPanel());
 await ref.set({channelId:channel.id,messageId:message.id,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 // Remover o painel antigo de importação, sem excluir os registros do Firebase.
 const oldRef=db.collection('guilds').doc(guild.id).collection('panels').doc('syncMembers');
 const oldSnap=await oldRef.get();
 if(oldSnap.exists&&oldSnap.data()?.messageId){const old=await channel.messages.fetch(oldSnap.data().messageId).catch(()=>null);if(old?.author?.id===guild.client.user.id&&old.embeds?.some(e=>e.title==='🚒 SSFD • Sincronização de Membros'))await old.delete().catch(err=>console.error('[Painéis] Não foi possível remover painel antigo:',err));}
 const recent=await channel.messages.fetch({limit:100});
 for(const old of recent.values())if(old.id!==message.id&&old.author?.id===guild.client.user.id&&old.embeds?.some(e=>e.title==='🚒 SSFD • Sincronização de Membros'))await old.delete().catch(()=>{});
 console.log(`[Painéis] Gestão de Cargos ativo: ${message.id}`);
}
async function ensurePanels(client) {
  for (const guild of client.guilds.cache.values()) {
    try { await ensureSetagemPanel(guild); await ensureControlePanel(guild);
      await ensureVistoriaPanel(guild,'cadastrarVistoria',channels.cadastrarVistoria,'🚒 SSFD • Cadastrar Vistoria',cadastroPanel);
      await ensureVistoriaPanel(guild,'agendamentoVistoria',channels.agendamentoVistoria,'🚒 SSFD • Agendamento de Vistorias',agendaPanel);
      await ensureGestaoPanel(guild); }
    catch (error) { console.error(`[Painéis] Erro no servidor ${guild.id}:`, error); }
  }
}

module.exports = { ensurePanels, ensureSetagemPanel, ensureControlePanel };
