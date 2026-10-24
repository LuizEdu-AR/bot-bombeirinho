const { EmbedBuilder } = require('discord.js');
const { db, admin } = require('./firebase');
const { channels } = require('../config/ids');

const ITEMS = [
  {
    key: 'botHelpPonto',
    title: 'SSFD • Bombeirinho | Sistema de Ponto',
    build: () => new EmbedBuilder()
      .setColor(0xC62828)
      .setTitle('SSFD • Bombeirinho | Sistema de Ponto')
      .setDescription('O Bombeirinho registra e acompanha suas horas de serviço na corporação.')
      .addFields(
        { name: 'Entrada e saída automáticas', value: 'Ao **entrar em serviço na cidade**, o bot abre seu ponto no Discord. Ao **sair de serviço**, ele encerra o ponto e contabiliza as horas.' },
        { name: 'Comando /ponto', value: 'Use `/ponto` para consultar seu ponto e, quando necessário, **pausar, retomar ou encerrar manualmente**.' },
        { name: 'Se o bot ficar indisponível', value: 'Continue entrando e saindo de serviço normalmente na cidade. Os logs que chegarem ao Discord poderão ser recuperados **normalmente pelo comando**, após o retorno do bot.' },
        { name: 'Divergência nas horas', value: 'Se perceber alguma inconsistência, solicite uma revisão no canal de **correções de ponto**.' }
      )
      .setFooter({ text: 'SSFD • Registre corretamente sua entrada e saída de serviço.' })
  },
  {
    key: 'botHelpVistorias',
    title: 'SSFD • Bombeirinho | Sistema de Vistorias',
    build: () => new EmbedBuilder()
      .setColor(0xC62828)
      .setTitle('SSFD • Bombeirinho | Sistema de Vistorias')
      .setDescription(`Acompanhe os agendamentos no canal <#${channels.agendamentoVistoria}>.`)
      .addFields(
        { name: 'Agendamentos', value: 'Cada vistoria apresenta o estabelecimento, localização, responsável e status atualizado.' },
        { name: 'Contato realizado', value: 'Registra que o contato foi feito e status é atualizado.' },
        { name: 'Concluir Vistoria', value: 'Registra a conclusão da vistoria com as informações solicitadas pelo jurídico.' },
        { name: 'Cancelar Vistoria', value: 'Permite cancelar o agendamento, informando o motivo, conforme as permissões do sistema.' }
      )
      .setFooter({ text: 'SSFD • Mantenha o andamento das vistorias atualizado.' })
  }
];

async function ensureBotHelp(client) {
  const channel = await client.channels.fetch(channels.botHelp);
  if (!channel?.isTextBased() || !channel.messages?.fetch || !channel.guild) {
    throw new Error('Canal bot-help não encontrado ou sem acesso a mensagens.');
  }
  const collection = db.collection('guilds').doc(channel.guild.id).collection('panels');
  for (const item of ITEMS) {
    try {
      const ref = collection.doc(item.key);
      const snap = await ref.get();
      let message = null;
      if (snap.exists && snap.data()?.channelId === channel.id && snap.data()?.messageId) {
        message = await channel.messages.fetch(snap.data().messageId).catch(err => {
          if (err.code === 10008) return null;
          throw err;
        });
      }
      if (message && (message.author?.id !== client.user.id || !message.embeds?.some(e => e.title === item.title))) message = null;
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 });
        message = recent.find(m => m.author?.id === client.user.id && m.embeds?.some(e => e.title === item.title)) || null;
      }
      const embed = item.build();
      const desired = embed.toJSON();
      if (message) {
        const current = message.embeds[0]?.toJSON();
        const normalized = obj => JSON.stringify({title:obj?.title,description:obj?.description,color:obj?.color,fields:obj?.fields,footer:obj?.footer});
        if (normalized(current) !== normalized(desired)) await message.edit({ embeds: [embed], components: [] });
      } else {
        message = await channel.send({ embeds: [embed] });
      }
      if (!snap.exists || snap.data()?.messageId !== message.id || snap.data()?.channelId !== channel.id) {
        await ref.set({ channelId: channel.id, messageId: message.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      console.log(`[Bot Help] ${item.key} pronto: ${message.id}`);
    } catch (err) {
      console.error(`[Bot Help] Falha em ${item.key}:`, err);
    }
  }
}

module.exports = { ensureBotHelp };
