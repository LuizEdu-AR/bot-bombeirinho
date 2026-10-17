const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { db, admin } = require('./firebase');
const { channels } = require('../config/ids');

const MAX_TEXT = 3500;
const pending = new Set();
const suggestionRef = (guildId, id) => db.collection('guilds').doc(guildId).collection('suggestions').doc(String(id));

function view(s) {
 const total = (s.agree || 0) + (s.disagree || 0);
 const percentage = total ? Math.round(100 * (s.agree || 0) / total) : 0;
 const embed = new EmbedBuilder()
  .setColor(0xC62828)
  .setTitle(`🚒 SSFD • Sugestão #${s.number}`)
  .setDescription(`**📢 PROPOSTA**\n\n**${s.text}**`)
  .addFields({name:'Autor',value:`<@${s.authorId}>`,inline:true},{name:'Participação',value:`${total} voto(s)`,inline:true})
  .setFooter({text:'SSFD • Vote abaixo e participe da discussão no tópico'})
  .setTimestamp(s.createdAt ? new Date(s.createdAt) : new Date());
 const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`sug:vote:${s.number}:agree`).setLabel(`Concordo ${percentage}% • ${s.agree || 0}`).setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`sug:vote:${s.number}:disagree`).setLabel(`Discordo ${total ? 100 - percentage : 0}% • ${s.disagree || 0}`).setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`sug:count:${s.number}`).setLabel(`Total de votos: ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true)
 );
 return {embeds:[embed],components:[row],allowedMentions:{parse:[]}};
}

async function nextNumber(guildId) {
 const ref = db.collection('guilds').doc(guildId).collection('counters').doc('suggestions');
 return db.runTransaction(async tx => {
  const snap = await tx.get(ref);
  const number = (snap.data()?.last || 0) + 1;
  tx.set(ref,{last:number,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return number;
 });
}

async function handleSuggestionMessage(message) {
 if (!message.guild || message.channelId !== channels.sugestoes || message.author.bot || message.webhookId || message.system) return;
 if (!message.content?.trim()) return;
 if (pending.has(message.id)) return;
 pending.add(message.id);
 try {
  const text = message.content.trim();
  if (text.length > MAX_TEXT) {
   await message.reply({content:`Sua sugestão ultrapassa ${MAX_TEXT} caracteres. Envie uma versão mais curta para que seja possível publicá-la.`}).catch(()=>{});
   return;
  }
  const number = await nextNumber(message.guildId);
  const ref = suggestionRef(message.guildId,number);
  const data = {number,text,authorId:message.author.id,agree:0,disagree:0,createdAt:new Date().toISOString(),status:'creating',channelId:message.channelId,sourceMessageId:message.id};
  await ref.set({...data,createdAtServer:admin.firestore.FieldValue.serverTimestamp()});
  let post;
  try {post = await message.channel.send(view(data));}
  catch(err) {await ref.update({status:'publish_failed',error:String(err.message).slice(0,300)});throw err;}
  await ref.update({messageId:post.id,status:'published'});
  try {
   const thread = await post.startThread({name:`Discussão • Sugestão #${number}`,autoArchiveDuration:1440,reason:'Discussão da sugestão SSFD'});
   await thread.send({content:`🚒 **Discussão da sugestão #${number}**\nSugestão enviada por <@${message.author.id}>.\n\nUse este espaço para apresentar opiniões, dúvidas e propostas de melhoria. Mantenha o respeito e o foco no assunto.`,allowedMentions:{parse:[]}});
   await ref.update({threadId:thread.id});
  } catch(err) {console.error(`[Sugestões] Tópico #${number} não criado:`,err);await ref.update({threadError:String(err.message).slice(0,300)}).catch(()=>{});}
  try {await message.delete();} catch(err) {console.warn(`[Sugestões] Não foi possível apagar mensagem original #${number}:`,err.message);}
  console.log(`[Sugestões] #${number} publicada (${post.id}).`);
 } catch(err) {console.error('[Sugestões] Falha ao publicar:',err);} finally {pending.delete(message.id);}
}

async function handleSuggestionInteraction(interaction) {
 if (!interaction.isButton() || !interaction.customId.startsWith('sug:vote:')) return;
 if (!interaction.guildId || interaction.channelId !== channels.sugestoes) return interaction.reply({content:'Este voto não pertence ao canal de sugestões.',flags:MessageFlags.Ephemeral});
 const [, , rawNumber, choice] = interaction.customId.split(':');
 const number = Number(rawNumber);
 if (!Number.isSafeInteger(number) || number < 1 || !['agree','disagree'].includes(choice)) return interaction.reply({content:'Votação inválida.',flags:MessageFlags.Ephemeral});
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 const ref = suggestionRef(interaction.guildId,number);
 const voteRef = ref.collection('votes').doc(interaction.user.id);
 let result;
 try {
  result = await db.runTransaction(async tx => {
   const [snap,voteSnap] = await Promise.all([tx.get(ref),tx.get(voteRef)]);
   if (!snap.exists || snap.data().status !== 'published' || snap.data().messageId !== interaction.message.id) return {kind:'missing'};
   const old = voteSnap.exists ? voteSnap.data().choice : null;
   if (old === choice) return {kind:'same'};
   const agree = Math.max(0,(snap.data().agree||0)+(choice==='agree'?1:0)-(old==='agree'?1:0));
   const disagree = Math.max(0,(snap.data().disagree||0)+(choice==='disagree'?1:0)-(old==='disagree'?1:0));
   tx.update(ref,{agree,disagree,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   tx.set(voteRef,{choice,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   return {kind:old?'changed':'new'};
  });
 } catch(err) {console.error('[Sugestões] Erro ao votar:',err);return interaction.editReply('Não foi possível registrar seu voto. Tente novamente.');}
 if (result.kind==='missing') return interaction.editReply('Esta sugestão não está mais disponível para votação.');
 if (result.kind==='same') return interaction.editReply('Seu voto já estava registrado nessa opção.');
 await interaction.editReply(result.kind==='changed'?'Seu voto foi alterado com sucesso!':'Seu voto foi registrado com sucesso!');
 // Recarrega o total mais recente. Uma atualização subsequente também pode ocorrer em paralelo.
 await refreshSuggestion(interaction.client,interaction.guildId,number).catch(err=>console.error('[Sugestões] Erro ao atualizar placar:',err));
}

const refreshing = new Map();
async function refreshSuggestion(client,guildId,number) {
 const key=`${guildId}:${number}`;
 if(refreshing.has(key)) {refreshing.set(key,true);return;}
 refreshing.set(key,false);
 try {
  do {
   refreshing.set(key,false);
   const snap=await suggestionRef(guildId,number).get();
   if(!snap.exists || !snap.data().messageId) return;
   const channel=await client.channels.fetch(snap.data().channelId);
   const post=await channel.messages.fetch(snap.data().messageId);
   await post.edit(view(snap.data()));
  } while(refreshing.get(key));
 } finally {refreshing.delete(key);}
}
module.exports={handleSuggestionMessage,handleSuggestionInteraction};
