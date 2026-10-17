const { roles } = require('../config/ids');

// Manutenção possui acesso administrativo global às ações do bot.
function hasAnyRole(member, allowed = []) {
  return Boolean(member?.roles?.cache?.some(role => role.id === roles.manutencao || allowed.includes(role.id)));
}

module.exports = { hasAnyRole };
