const {
    ActionRowBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const { db, admin, guildCollection } = require('./firebase');
const { channels, roles } = require('../config/ids');
const { administrativePanel, hasPanelTitle } = require('./panel-components-v2');

const PANEL_TITLE = 'SSFD • Registro de Baú';
const PANEL_KEY = 'registroBau';
const EPHEMERAL = MessageFlags.Ephemeral;

const ITEMS = [
    { label: 'Gase', value: 'gase' },
    { label: 'Colete', value: 'colete' },
    { label: 'Bolsa de sangue', value: 'bolsa_sangue' },
    { label: 'Soro', value: 'soro' },
    { label: 'Outro', value: 'outro' }
];

const ALLOWED_RANKS = [
    roles.cadete,
    roles.bombeiroI,
    roles.bombeiroII,
    roles.bombeiroIII,
    roles.tenente,
    roles.capitao,
    roles.chefeBatalhao,
    roles.chefeAdjunto,
    roles.chefe,
    roles.manutencao
];

function panel() {
    return administrativePanel(
        PANEL_TITLE,
        'Registre entradas e retiradas de itens do baú. Todas as movimentações são registradas no histórico, sem controle de estoque.',
        [
            {
                id: 'bau:add',
                label: 'Guardar',
                description: 'Registre um item guardado no baú.',
                style: ButtonStyle.Success
            },
            {
                id: 'bau:remove',
                label: 'Retirar',
                description: 'Registre um item retirado e o motivo da retirada.',
                style: ButtonStyle.Danger
            }
        ]
    );
}

function memberAllowed(member) {
    return Boolean(member?.roles?.cache?.some(role => ALLOWED_RANKS.includes(role.id)));
}

async function checkAccess(interaction) {
    if (!interaction.inGuild() || interaction.channelId !== channels.registroBau) {
        await interaction.reply({
            content: `Utilize o painel no canal <#${channels.registroBau}>.`,
            flags: EPHEMERAL
        });
        return false;
    }

    // Recarrega as patentes para impedir que uma interação antiga mantenha acesso.
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    if (!memberAllowed(member)) {
        await interaction.reply({
            content: 'Você não possui uma patente autorizada a registrar movimentações do baú.',
            flags: EPHEMERAL
        });
        return false;
    }

    return true;
}

function itemSelection(operation) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`bau:item:${operation}`)
        .setPlaceholder('Selecione o item')
        .addOptions(ITEMS);

    return {
        content: operation === 'add'
            ? '**Guardar no baú** — selecione o item que foi guardado.'
            : '**Retirar do baú** — selecione o item que foi retirado.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: EPHEMERAL
    };
}

function input(id, label, style, maxLength) {
    return new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setStyle(style)
            .setRequired(true)
            .setMaxLength(maxLength)
    );
}

function movementModal(operation, itemKey) {
    const item = ITEMS.find(entry => entry.value === itemKey);

    if (!item) {
        return null;
    }

    const fields = [];

    if (itemKey === 'outro') {
        fields.push(input('item', 'Nome do item', TextInputStyle.Short, 100));
    }

    fields.push(input('quantity', 'Quantidade', TextInputStyle.Short, 12));

    if (operation === 'remove') {
        fields.push(input('reason', 'Motivo da remoção', TextInputStyle.Paragraph, 1000));
    }

    return new ModalBuilder()
        .setCustomId(`bau:submit:${operation}:${itemKey}`)
        .setTitle(operation === 'add' ? 'Guardar item no baú' : 'Retirar item do baú')
        .addComponents(...fields);
}

function safeText(value, limit = 1000) {
    return String(value)
        .replace(/[\r\n]+/g, ' ')
        .replace(/@/g, '＠')
        .replace(/`/g, "'")
        .trim()
        .slice(0, limit);
}

function logEmbed(record) {
    const isAddition = record.operation === 'add';

    const embed = new EmbedBuilder()
        .setColor(isAddition ? 0x27875a : 0xc62828)
        .setTitle(isAddition ? 'SSFD • Registro de Baú | Adição' : 'SSFD • Registro de Baú | Remoção')
        .addFields(
            { name: 'Responsável', value: `<@${record.actorId}>`, inline: true },
            { name: 'Movimentação', value: isAddition ? 'Entrada' : 'Saída', inline: true },
            { name: 'Item', value: record.item, inline: true },
            { name: 'Quantidade', value: `${record.quantity} unidade(s)`, inline: true }
        )
        .setFooter({ text: 'Bombeirinho • Histórico de movimentações do baú' })
        .setTimestamp(new Date(record.createdAt));

    if (!isAddition) {
        embed.addFields({ name: 'Motivo da remoção', value: record.reason, inline: false });
    }

    return embed;
}

async function recordMovement(interaction, operation, itemKey) {
    const chosen = ITEMS.find(item => item.value === itemKey);

    if (!chosen || !['add', 'remove'].includes(operation)) {
        return interaction.reply({ content: 'Movimentação inválida.', flags: EPHEMERAL });
    }

    const quantityText = interaction.fields.getTextInputValue('quantity').trim();

    if (!/^[1-9]\d*$/.test(quantityText) || !Number.isSafeInteger(Number(quantityText))) {
        return interaction.reply({
            content: 'Informe uma quantidade inteira e positiva.',
            flags: EPHEMERAL
        });
    }

    const quantity = Number(quantityText);
    const item = itemKey === 'outro'
        ? safeText(interaction.fields.getTextInputValue('item'), 100)
        : chosen.label;
    const reason = operation === 'remove'
        ? safeText(interaction.fields.getTextInputValue('reason'), 1000)
        : null;

    if (!item || (operation === 'remove' && !reason)) {
        return interaction.reply({
            content: 'Preencha corretamente o nome do item e o motivo, quando necessário.',
            flags: EPHEMERAL
        });
    }

    await interaction.deferReply({ flags: EPHEMERAL });

    const record = {
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        actorName: interaction.member?.displayName || interaction.user.username,
        operation,
        item,
        itemKey,
        quantity,
        reason,
        createdAt: new Date().toISOString(),
        createdAtServer: admin.firestore.FieldValue.serverTimestamp()
    };

    // O ID da interação impede duplicidade do histórico caso haja reprocessamento.
    const ref = guildCollection(interaction.guildId, 'bauMovements')
        .doc(interaction.id);

    await ref.create(record);

    let logSent = false;

    try {
        const channel = await interaction.guild.channels.fetch(channels.logBau);

        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            throw new Error('Canal de Log Baú indisponível.');
        }

        const message = await channel.send({
            embeds: [logEmbed(record)],
            allowedMentions: { parse: [] }
        });

        logSent = true;
        await ref.update({ logMessageId: message.id, logChannelId: channel.id });
    } catch (error) {
        console.error('[Registro Baú] Não foi possível publicar o log:', error);
    }

    await interaction.editReply({
        content: logSent
            ? `Movimentação registrada: **${operation === 'add' ? 'adição' : 'remoção'}** de **${quantity}** unidade(s) de **${item}**.`
            : 'Movimentação salva no Firebase, mas não foi possível publicar o log no Discord. Avise a administração para verificar o canal de logs.'
    });
}

async function handleBau(interaction) {
    if (!interaction.customId?.startsWith('bau:')) {
        return false;
    }

    if (!(await checkAccess(interaction))) {
        return true;
    }

    const id = interaction.customId;

    if (interaction.isButton() && (id === 'bau:add' || id === 'bau:remove')) {
        await interaction.reply(itemSelection(id === 'bau:add' ? 'add' : 'remove'));
        return true;
    }

    if (interaction.isStringSelectMenu() && id.startsWith('bau:item:')) {
        const operation = id.slice('bau:item:'.length);
        const modal = movementModal(operation, interaction.values[0]);

        if (!modal) {
            await interaction.reply({ content: 'Item inválido.', flags: EPHEMERAL });
            return true;
        }

        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith('bau:submit:')) {
        const [, , operation, itemKey] = id.split(':');
        await recordMovement(interaction, operation, itemKey);
        return true;
    }

    await interaction.reply({ content: 'Ação do baú não reconhecida.', flags: EPHEMERAL });
    return true;
}

async function ensureBauPanel(guild) {
    const channel = await guild.channels.fetch(channels.registroBau);

    if (!channel?.isTextBased() || !channel.messages?.fetch) {
        throw new Error('Canal Registro Baú indisponível.');
    }

    const ref = guildCollection(guild.id, 'panels')
        .doc(PANEL_KEY);

    const saved = await ref.get();
    let message = null;

    if (saved.exists && saved.data()?.channelId === channel.id && saved.data()?.messageId) {
        message = await channel.messages.fetch(saved.data().messageId).catch(() => null);

        if (message?.author?.id !== guild.client.user.id || !hasPanelTitle(message, PANEL_TITLE)) {
            message = null;
        }
    }

    if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 });
        message = recent.find(item =>
            item.author?.id === guild.client.user.id && hasPanelTitle(item, PANEL_TITLE)
        ) || null;
    }

    if (message) {
        await message.edit(panel());
    } else {
        message = await channel.send(panel());
    }

    await ref.set({
        channelId: channel.id,
        messageId: message.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[Registro Baú] Painel ativo em ${guild.name}: ${message.id}`);
}

module.exports = {
    ensureBauPanel,
    handleBau,
    panel
};
