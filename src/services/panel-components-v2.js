// Layout dos painéis administrativos com Discord Components V2.
// IDs e estilos originais dos botões são preservados para manter os handlers existentes.
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder,
  SeparatorSpacingSize, ButtonBuilder, ButtonStyle, MessageFlags
} = require('discord.js');

const ACCENT = 0xc62828;

function administrativePanel(title, introduction, actions) {
  const container = new ContainerBuilder().setAccentColor(ACCENT);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}\n${introduction}`)
  );
  for (const { id, label, description, style = ButtonStyle.Secondary } of actions) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${label}**\n${description}`)
        )
        .setButtonAccessory(
          new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)
        )
    );
  }
  return { flags: MessageFlags.IsComponentsV2, embeds: [], components: [container] };
}

// Compatibilidade com mensagens antigas: permite reaproveitar o painel no canal
// em vez de publicar outro a cada inicialização do bot.
function hasPanelTitle(message, title) {
  if (message.embeds?.some(embed => embed.title === title)) return true;
  return message.components?.some(component =>
    JSON.stringify(component.toJSON?.() ?? component).includes(title)
  ) ?? false;
}

module.exports = { administrativePanel, hasPanelTitle };
