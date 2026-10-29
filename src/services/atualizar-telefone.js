'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { db, admin } = require('./firebase');
const { roles } = require('../config/ids');

const BUTTON_ID = 'telefone:abrir';
const MODAL_ID = 'telefone:salvar';
const INPUT_ID = 'telefone:numero';
const MANAGERS = [roles.manutencao, roles.chefe, roles.chefeAdjunto, roles.chefeBatalhao];

function panel() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0xB71C1C)
      .setTitle('Atualização de Telefone RP | SSFD')
      .setDescription('Mantenha seu telefone do personagem atualizado para facilitar o contato da corporação.\n\nClique no botão abaixo para informar ou alterar **seu próprio telefone RP**. A atualização será salva no seu cadastro e utilizada nos documentos e sistemas da SSFD.')
      .setFooter({ text: 'Bombeirinho SSFD • Atualização individual' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('Atualizar meu telefone').setStyle(ButtonStyle.Primary)
    )],
  };
}

async function publishPhonePanel(interaction) {
  if (!interaction.inGuild() || !MANAGERS.some(id => interaction.member?.roles?.cache?.has(id))) {
    return interaction.reply({ content: 'Apenas a chefia ou Manutenção pode publicar este painel.', flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.options.getChannel('canal') || interaction.channel;
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return interaction.reply({ content: 'Selecione um canal de texto ou de anúncios do servidor.', flags: MessageFlags.Ephemeral });
  }
  const me = await interaction.guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: `Não tenho permissões para visualizar, enviar mensagens e incorporar links em <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = await channel.send(panel());
  return interaction.editReply({ content: `Painel de atualização de telefone publicado em <#${channel.id}>. [Ver painel](${message.url})` });
}

async function handlePhone(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Este recurso só funciona no servidor da SSFD.', flags: MessageFlags.Ephemeral });
  }
  const ref = db.collection('guilds').doc(interaction.guildId).collection('registrations').doc(interaction.user.id);
  if (interaction.customId === BUTTON_ID) {
    const snapshot = await ref.get();
    const data = snapshot.data();
    if (!snapshot.exists || data?.status !== 'approved' || !data?.name) {
      return interaction.reply({ content: 'Você precisa ter um cadastro aprovado de bombeiro para atualizar seu telefone RP.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Atualizar telefone RP');
    const input = new TextInputBuilder()
      .setCustomId(INPUT_ID)
      .setLabel('Telefone do personagem')
      .setPlaceholder('Ex.: 555-1234')
      .setStyle(TextInputStyle.Short)
      .setMinLength(4)
      .setMaxLength(35)
      .setRequired(true);
    if (data.phone) input.setValue(String(data.phone).slice(0, 35));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }
  if (interaction.customId !== MODAL_ID) return;
  const phone = interaction.fields.getTextInputValue(INPUT_ID).trim();
  if (!/^[0-9+() .-]{4,35}$/.test(phone) || phone.replace(/\D/g, '').length < 4) {
    return interaction.reply({ content: 'Telefone inválido. Use de 4 a 35 caracteres (números, espaços, +, parênteses ou hífens), com pelo menos 4 dígitos.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let previous;
  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      if (!snapshot.exists || data?.status !== 'approved' || !data?.name) {
        throw new Error('CADASTRO_INATIVO');
      }
      previous = data.phone || null;
      transaction.update(ref, {
        phone,
        phoneUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        phoneUpdatedBy: interaction.user.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    if (error.message === 'CADASTRO_INATIVO') {
      return interaction.editReply('Seu cadastro não está mais aprovado. Solicite ajuda à chefia.');
    }
    console.error('[Telefone RP] Falha ao atualizar:', error);
    return interaction.editReply('Não foi possível salvar o telefone no Firebase. Tente novamente.');
  }
  return interaction.editReply(previous === phone
    ? `Seu telefone RP já estava cadastrado como **${phone}**. Cadastro confirmado.`
    : `Telefone RP atualizado com sucesso para **${phone}**. A alteração já está salva no seu cadastro.`);
}

module.exports = { publishPhonePanel, handlePhone };
